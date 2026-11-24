import { abortableDelay, deadlineSignal } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSRuntime } from "quickjs-emscripten";

/** The snippet's whole outward channel: console output, capped so one print cannot flood a turn. */
export const CODE_MODE_OUTPUT_MAX_CHARS = 20_000;
/** A script reaches tools through the host, so a loop is bounded here, not by the model's turn budget. */
export const CODE_MODE_MAX_CALLS = 32;
export const CODE_MODE_TIMEOUT_MS = 60_000;
const ARGS_MAX_BYTES = 200_000;
const RESULT_MAX_BYTES = 1_000_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;

export interface CodeModeRunOptions {
  code: string;
  /** Names installed as `codemode.<name>`. Anything else is not a value in the isolate. */
  tools: readonly string[];
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxCalls?: number;
  /**
   * Ends with a dot, e.g. `cmd.`. Names under it reach `call` unchecked, as `codemode.cmd.<name>`;
   * `call` decides whether the command exists.
   */
  commandPrefix?: string;
}

export interface CodeModeRunResult {
  output: string;
  calls: string[];
  truncated: boolean;
  error?: { name: string; message: string };
}

class CallLimitReached extends Error {
  constructor(maxCalls: number) {
    super(`code_mode allows at most ${maxCalls} tool calls per script`);
    this.name = "CallLimitReached";
  }
}

/** TypeScript to the ES2022 JavaScript the isolate runs. */
async function toJavaScript(code: string): Promise<string> {
  // esbuild is a native binary; load it only when a script actually runs.
  const { transform } = await import("esbuild");
  return (
    await transform(code, {
      loader: "ts",
      target: "es2022",
      format: "esm",
      logLevel: "silent",
    })
  ).code;
}

function errorShape(error: unknown): { name: string; message: string } {
  if (error && typeof error === "object") {
    const value = error as { name?: unknown; message?: unknown };
    return {
      name: typeof value.name === "string" ? value.name : "Error",
      message: typeof value.message === "string" ? value.message : String(error),
    };
  }
  return { name: "Error", message: String(error) };
}

function serializableResult(value: unknown, name: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value ?? null);
  } catch (error) {
    throw new Error(`${name} returned a value that is not JSON: ${errorShape(error).message}`);
  }
  if (json === undefined) throw new Error(`${name} returned a value that is not JSON`);
  if (json.length > RESULT_MAX_BYTES) {
    throw new Error(`${name} returned more than ${RESULT_MAX_BYTES} bytes; ask for less`);
  }
  return json;
}

/**
 * Runs model-authored TypeScript in a fresh QuickJS isolate. The isolate has no network, no
 * filesystem and no imports: its only capabilities are `console.log` and the host calls the
 * caller installed by name.
 */
export async function runCodeModeScript(options: CodeModeRunOptions): Promise<CodeModeRunResult> {
  const timeoutMs = options.timeoutMs ?? CODE_MODE_TIMEOUT_MS;
  const maxCalls = options.maxCalls ?? CODE_MODE_MAX_CALLS;
  // The signal covers the async pump, and the clock covers the interrupt handler: a script
  // spinning inside WebAssembly blocks timers, so the handler must read the clock itself.
  const budgetEndsAt = Date.now() + timeoutMs;
  const deadline = deadlineSignal(timeoutMs, options.signal);
  const logs: string[] = [];
  const calls: string[] = [];
  let written = 0;
  let callCount = 0;
  let limitExceeded = false;

  const stopped = (): { name: string; message: string } | undefined =>
    options.signal?.aborted
      ? { name: "AbortError", message: "the run stopped" }
      : deadline.aborted
        ? { name: "TimeoutError", message: `the script ran longer than ${timeoutMs}ms` }
        : undefined;

  const javascript = await toJavaScript(options.code);
  // The WASM module is a megabyte load; a worker only pays for it when a script runs.
  const { getQuickJS } = await import("quickjs-emscripten");
  const QuickJS = await getQuickJS();
  const runtime: QuickJSRuntime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => deadline.aborted || Date.now() > budgetEndsAt);
  const vm: QuickJSContext = runtime.newContext();

  const print = vm.newFunction("__print", (lineHandle) => {
    const line = vm.getString(lineHandle);
    const room = CODE_MODE_OUTPUT_MAX_CHARS - written;
    if (room <= 0) return;
    const kept = line.slice(0, room);
    logs.push(kept);
    written += kept.length;
  });
  vm.setProp(vm.global, "__print", print);
  print.dispose();

  // One host call at a time: tools were written for a turn that runs calls a step apart, and a
  // serialized bridge keeps their order and the run's own bookkeeping deterministic on replay.
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Set<QuickJSDeferredPromise>();
  const allowed = new Set(options.tools);
  const commandPrefix = options.commandPrefix;
  const invoke = vm.newFunction("__call", (nameHandle, argsHandle) => {
    const name = vm.getString(nameHandle);
    const raw = vm.getString(argsHandle);
    const deferred = vm.newPromise();
    pending.add(deferred);
    const fail = (error: unknown) => {
      const shape = errorShape(error);
      const handle = vm.newError(shape.message);
      vm.setProp(handle, "code", vm.newString(shape.name));
      deferred.reject(handle);
      // reject does not take the handle: leave it for the runtime's GC check at free().
      handle.dispose();
    };
    queue = queue.then(async () => {
      if (!allowed.has(name) && !(commandPrefix && name.startsWith(commandPrefix))) {
        return fail(
          Object.assign(new Error(`${name} is not a tool this run offers`), {
            name: "ToolUnavailable",
          }),
        );
      }
      if (raw.length > ARGS_MAX_BYTES) {
        return fail(new Error(`arguments for ${name} exceed ${ARGS_MAX_BYTES} bytes`));
      }
      callCount += 1;
      if (callCount > maxCalls) {
        limitExceeded = true;
        return fail(new CallLimitReached(maxCalls));
      }
      calls.push(name);
      const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      try {
        const value = await options.call(name, args);
        deferred.resolve(vm.newString(serializableResult({ value }, name)));
      } catch (error) {
        fail(error);
      }
    });
    queue = bestEffort("run the next code-mode bridge call", queue).finally(() => {
      vm.runtime.executePendingJobs();
    });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__call", invoke);
  invoke.dispose();

  // The host checks every name; the isolate only needs one forwarding property so no tool
  // name is ever pasted into executable source.
  const install = vm.evalCode(
    `globalThis.console = {
       log: (...parts) => __print(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ")),
       error: (...parts) => __print(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ")),
     };
     (() => {
       const call = (name) => async (input) => {
         const raw = await __call(name, JSON.stringify(input ?? {}));
         return JSON.parse(raw).value;
       };
       const commands = new Proxy(Object.create(null), {
         get: (_target, name) => call(${JSON.stringify(commandPrefix ?? "")} + String(name)),
       });
       globalThis.codemode = new Proxy(Object.create(null), {
         get: (_target, name) => name === ${JSON.stringify(commandPrefix?.slice(0, -1) ?? null)} ? commands : call(String(name)),
       });
     })();`,
    "codemode-api.js",
  );
  if (install.error) {
    const failure = stopped() ?? errorShape(vm.dump(install.error));
    install.error.dispose();
    vm.dispose();
    runtime.dispose();
    return { output: "", calls, truncated: false, error: failure };
  }
  install.value.dispose();

  let result: CodeModeRunResult;
  const evaluated = vm.evalCode(`(async () => {\n${javascript}\n})()`, "codemode-script.ts");
  if (evaluated.error) {
    result = {
      output: logs.join("\n"),
      calls,
      truncated: written >= CODE_MODE_OUTPUT_MAX_CHARS,
      error: stopped() ?? errorShape(vm.dump(evaluated.error)),
    };
    evaluated.error.dispose();
  } else {
    let settled = false;
    const outcome = vm.resolvePromise(evaluated.value);
    outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled && !deadline.aborted) {
      vm.runtime.executePendingJobs();
      await abortableDelay(0, deadline);
    }
    const stopReason = stopped();
    // An interrupt rejects the script's promise; let it settle so its handle is released
    // before the runtime is freed.
    if (!settled && stopReason) {
      const grace = Date.now() + 250;
      while (!settled && Date.now() < grace) {
        vm.runtime.executePendingJobs();
        // The run's own signal never covers this grace; only the clock does.
        await abortableDelay(0);
      }
    }
    if (settled) {
      const resolved = await outcome;
      if (resolved.error) {
        result = {
          output: logs.join("\n"),
          calls,
          truncated: written >= CODE_MODE_OUTPUT_MAX_CHARS,
          error: stopReason ?? errorShape(vm.dump(resolved.error)),
        };
        resolved.error.dispose();
      } else {
        result = {
          output: logs.join("\n"),
          calls,
          truncated: written >= CODE_MODE_OUTPUT_MAX_CHARS,
        };
        resolved.value.dispose();
      }
    } else {
      result = {
        output: logs.join("\n"),
        calls,
        truncated: written >= CODE_MODE_OUTPUT_MAX_CHARS,
        error: stopReason ?? {
          name: "TimeoutError",
          message: `the script ran longer than ${timeoutMs}ms`,
        },
      };
    }
    evaluated.value.dispose();
  }

  if (limitExceeded) {
    // The script may have swallowed the rejection; the turn still must see that it was cut off.
    result.error ??= {
      name: "CallLimitReached",
      message: `code_mode allows at most ${maxCalls} tool calls per script`,
    };
  }
  for (const deferred of pending) deferred.dispose();
  vm.dispose();
  runtime.dispose();
  return result;
}
