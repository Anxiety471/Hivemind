import { deadlineSignal } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSRuntime } from "quickjs-emscripten";
import { formatCodeModeLintFindings, lintCodeModeScript } from "./code-mode-lint.js";

/** The snippet's whole outward channel: console output, capped so one print cannot flood a turn. */
export const CODE_MODE_OUTPUT_MAX_CHARS = 20_000;
/** A script reaches tools through the host, so a loop is bounded here, not by the model's turn budget. */
export const CODE_MODE_MAX_CALLS = 32;
export const CODE_MODE_TIMEOUT_MS = 60_000;
const ARGS_MAX_BYTES = 200_000;
const RESULT_MAX_BYTES = 1_000_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 8;
const TRANSPILE_CACHE_MAX_ENTRIES = 128;
const TRANSPILE_CACHE_MAX_CHARS = 32_768;

let esbuildPromise: Promise<typeof import("esbuild")> | undefined;
let quickJSPromise: ReturnType<typeof import("quickjs-emscripten")["getQuickJS"]> | undefined;
const transpileCache = new Map<string, string>();

function loadEsbuild() {
  esbuildPromise ??= import("esbuild").catch((error) => {
    esbuildPromise = undefined;
    throw error;
  });
  return esbuildPromise;
}

function loadQuickJS() {
  quickJSPromise ??= import("quickjs-emscripten")
    .then(({ getQuickJS }) => getQuickJS())
    .catch((error) => {
      quickJSPromise = undefined;
      throw error;
    });
  return quickJSPromise;
}

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
  /** JSON-serializable values installed on `globalThis` before the script evaluates. */
  globals?: Readonly<Record<string, unknown>>;
  /**
   * When provided, calls for which this returns `true` may run concurrently up to `maxConcurrency`,
   * while calls returning `false` act as a FIFO exclusive barrier. When omitted, all calls serialize.
   */
  canRunConcurrently?: (name: string, args: Record<string, unknown>) => boolean;
  /** Maximum number of concurrent host calls when `canRunConcurrently` allows overlap. */
  maxConcurrency?: number;
  /** Whether the code is a top-level `code_mode` script or a saved `cmd.*` command body. */
  mode?: "script" | "command";
}

/** Transpiles TypeScript without running it, returning a SyntaxError shape when invalid. */
export async function checkCodeModeSyntax(
  code: string,
): Promise<{ name: "SyntaxError"; message: string } | undefined> {
  try {
    await toJavaScript(code);
    return undefined;
  } catch (error) {
    return { name: "SyntaxError", message: errorShape(error).message };
  }
}

export interface CodeModeRunResult {
  output: string;
  returnValue?: string;
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

/** TypeScript to the ES2022 JavaScript the isolate runs, with a bounded LRU cache. */
async function toJavaScript(code: string): Promise<string> {
  const cacheable = code.length <= TRANSPILE_CACHE_MAX_CHARS;
  if (cacheable) {
    const cached = transpileCache.get(code);
    if (cached !== undefined) {
      transpileCache.delete(code);
      transpileCache.set(code, cached);
      return cached;
    }
  }
  // esbuild is a native binary; load it only when a script actually runs.
  const { transform } = await loadEsbuild();
  const compiled = (
    await transform(code, {
      loader: "ts",
      target: "es2022",
      format: "esm",
      logLevel: "silent",
    })
  ).code;
  if (cacheable) {
    if (transpileCache.size >= TRANSPILE_CACHE_MAX_ENTRIES) {
      const oldest = transpileCache.keys().next().value;
      if (oldest !== undefined) transpileCache.delete(oldest);
    }
    transpileCache.set(code, compiled);
  }
  return compiled;
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
 * filesystem and no imports: its only capabilities are `console` and the host calls the
 * caller installed by name.
 */
export async function runCodeModeScript(options: CodeModeRunOptions): Promise<CodeModeRunResult> {
  const findings = lintCodeModeScript(options.code, {
    mode: options.mode,
    tools: options.tools,
    commandPrefix: options.commandPrefix,
  });
  if (findings.length > 0) {
    return {
      output: "",
      calls: [],
      truncated: false,
      error: { name: "LintError", message: formatCodeModeLintFindings(findings) },
    };
  }
  const timeoutMs = options.timeoutMs ?? CODE_MODE_TIMEOUT_MS;
  const maxCalls = options.maxCalls ?? CODE_MODE_MAX_CALLS;
  const maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));
  // The signal covers the async pump, and the clock covers the interrupt handler: a script
  // spinning inside WebAssembly blocks timers, so the handler must read the clock itself.
  const budgetEndsAt = Date.now() + timeoutMs;
  const deadline = deadlineSignal(timeoutMs, options.signal);
  const logs: string[] = [];
  const calls: string[] = [];
  let written = 0;
  let returnValue: string | undefined;
  let truncated = false;
  let callCount = 0;
  let limitExceeded = false;

  const stopped = (): { name: string; message: string } | undefined =>
    options.signal?.aborted
      ? { name: "AbortError", message: "the run stopped" }
      : deadline.aborted || Date.now() > budgetEndsAt
        ? { name: "TimeoutError", message: `the script ran longer than ${timeoutMs}ms` }
        : undefined;

  const sourceToCompile =
    options.mode === "command"
      ? options.code
      : `const __ret = await (async () => {\n${options.code}\n})();\n__reportReturn(__ret);`;

  let javascript: string;
  let QuickJS: Awaited<ReturnType<typeof loadQuickJS>>;
  try {
    [javascript, QuickJS] = await Promise.all([toJavaScript(sourceToCompile), loadQuickJS()]);
  } catch (error) {
    return {
      output: "",
      calls,
      truncated: false,
      error: stopped() ?? { name: "SyntaxError", message: errorShape(error).message },
    };
  }

  if (deadline.aborted) {
    return {
      output: "",
      calls,
      truncated: false,
      error: stopped() ?? {
        name: "TimeoutError",
        message: `the script ran longer than ${timeoutMs}ms`,
      },
    };
  }

  const runtime: QuickJSRuntime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => deadline.aborted || Date.now() > budgetEndsAt);
  const vm: QuickJSContext = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  let disposed = false;

  try {
    const print = vm.newFunction("__print", (lineHandle) => {
      const line = vm.getString(lineHandle);
      const sep = logs.length > 0 ? 1 : 0;
      const room = CODE_MODE_OUTPUT_MAX_CHARS - written - sep;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (line.length > room) {
        logs.push(line.slice(0, room));
        written = CODE_MODE_OUTPUT_MAX_CHARS;
        truncated = true;
      } else {
        logs.push(line);
        written += sep + line.length;
      }
    });
    vm.setProp(vm.global, "__print", print);
    print.dispose();

    const setReturn = vm.newFunction("__setReturn", (valueHandle) => {
      const value = vm.getString(valueHandle);
      if (value.length > CODE_MODE_OUTPUT_MAX_CHARS) {
        returnValue = value.slice(0, CODE_MODE_OUTPUT_MAX_CHARS);
        truncated = true;
      } else {
        returnValue = value;
      }
    });
    vm.setProp(vm.global, "__setReturn", setReturn);
    setReturn.dispose();

    const allowed = new Set(options.tools);
    const commandPrefix = options.commandPrefix;
    const canRunConcurrently = options.canRunConcurrently;
    let inFlight = 0;
    let activeConcurrent = 0;
    let exclusiveRunning = false;
    let settled = false;
    let wakeWaiter: (() => void) | undefined;
    let deadlockScheduled = false;

    const scheduleDeadlockCheck = () => {
      if (deadlockScheduled || disposed || settled) return;
      deadlockScheduled = true;
      queueMicrotask(() => {
        deadlockScheduled = false;
        if (!disposed && !settled && inFlight === 0 && !vm.runtime.hasPendingJob()) {
          wakeWaiter?.();
        }
      });
    };

    const pump = () => {
      if (disposed) return;
      vm.runtime.executePendingJobs();
      if (!settled && inFlight === 0 && !vm.runtime.hasPendingJob()) {
        scheduleDeadlockCheck();
      }
    };

    type QueueEntry = {
      concurrent: boolean;
      run: () => void;
    };
    const waiting: QueueEntry[] = [];

    const drainQueue = () => {
      while (waiting.length > 0 && !exclusiveRunning) {
        const next = waiting[0]!;
        if (next.concurrent) {
          if (activeConcurrent >= maxConcurrency) break;
          waiting.shift();
          activeConcurrent += 1;
          next.run();
        } else {
          if (activeConcurrent > 0) break;
          waiting.shift();
          exclusiveRunning = true;
          next.run();
        }
      }
    };

    const invoke = vm.newFunction("__call", (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      const raw = vm.getString(argsHandle);
      const deferred = vm.newPromise();
      pending.add(deferred);
      inFlight += 1;

      const finishDeferred = (settle: () => void) => {
        inFlight -= 1;
        if (disposed) return;
        try {
          settle();
        } finally {
          pending.delete(deferred);
          deferred.dispose();
          pump();
        }
      };

      const fail = (error: unknown) => {
        finishDeferred(() => {
          const shape = errorShape(error);
          const handle = vm.newError(shape.message);
          vm.newString(shape.name).consume((code) => vm.setProp(handle, "code", code));
          deferred.reject(handle);
          // reject does not take the handle: leave it for the runtime's GC check at free().
          handle.dispose();
        });
      };

      if (!allowed.has(name) && !(commandPrefix && name.startsWith(commandPrefix))) {
        queueMicrotask(() =>
          fail(
            Object.assign(new Error(`${name} is not a tool this run offers`), {
              name: "ToolUnavailable",
            }),
          ),
        );
        return deferred.handle;
      }
      if (raw.length > ARGS_MAX_BYTES) {
        queueMicrotask(() =>
          fail(new Error(`arguments for ${name} exceed ${ARGS_MAX_BYTES} bytes`)),
        );
        return deferred.handle;
      }
      callCount += 1;
      if (callCount > maxCalls) {
        limitExceeded = true;
        queueMicrotask(() => fail(new CallLimitReached(maxCalls)));
        return deferred.handle;
      }
      calls.push(name);
      let args: Record<string, unknown>;
      try {
        args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch (error) {
        queueMicrotask(() => fail(error));
        return deferred.handle;
      }

      const concurrent = Boolean(canRunConcurrently?.(name, args));
      waiting.push({
        concurrent,
        run: () => {
          void bestEffort(
            "run the next code-mode bridge call",
            Promise.resolve().then(async () => {
              try {
                const value = await options.call(name, args);
                const serialized = serializableResult(value, name);
                finishDeferred(() => {
                  vm.newString(serialized).consume((str) => deferred.resolve(str));
                });
              } catch (error) {
                fail(error);
              } finally {
                if (concurrent) activeConcurrent -= 1;
                else exclusiveRunning = false;
                if (!disposed) drainQueue();
              }
            }),
          );
        },
      });
      drainQueue();
      return deferred.handle;
    });
    vm.setProp(vm.global, "__call", invoke);
    invoke.dispose();

    const globalsScript = options.globals
      ? `(() => {
           const injected = JSON.parse(${JSON.stringify(JSON.stringify(options.globals))});
           for (const [key, value] of Object.entries(injected)) {
             Object.defineProperty(globalThis, key, { value, writable: true, enumerable: true, configurable: true });
           }
         })();`
      : "";

    // The host checks every name; the isolate only needs one forwarding property so no tool
    // name is ever pasted into executable source.
    const install = vm.evalCode(
      `(() => {
         const formatPart = (part) => {
           if (typeof part === "string") return part;
           if (part === undefined) return "undefined";
           if (part instanceof Error) {
             const head = part.name + (part.message ? ": " + part.message : "");
             return part.stack ? (part.stack.startsWith(head) ? part.stack : head + "\\n" + part.stack) : head;
           }
           try {
             const json = JSON.stringify(part);
             return json === undefined ? String(part) : json;
           } catch {
             return String(part);
           }
         };
         const printLine = (...parts) => __print(parts.map(formatPart).join(" "));
         globalThis.console = {
           log: printLine,
           error: printLine,
           warn: printLine,
           info: printLine,
         };
         const formatReturn = (value) => {
           if (typeof value === "string") return value;
           if (value instanceof Error) return formatPart(value);
           try {
             const json = JSON.stringify(value);
             return json === undefined ? formatPart(value) : json;
           } catch {
             return formatPart(value);
           }
         };
         Object.defineProperty(globalThis, "__reportReturn", {
           value: (value) => {
             if (value !== undefined) __setReturn(formatReturn(value));
           },
           enumerable: false,
         });
         const call = (name) => async (input) => {
           const raw = await __call(name, JSON.stringify(input ?? {}));
           return JSON.parse(raw);
         };
         const commands = new Proxy(Object.create(null), {
           get: (_target, name) => call(${JSON.stringify(commandPrefix ?? "")} + String(name)),
         });
         globalThis.codemode = new Proxy(Object.create(null), {
           get: (_target, name) => name === ${JSON.stringify(commandPrefix?.slice(0, -1) ?? null)} ? commands : call(String(name)),
         });
       })();
       ${globalsScript}`,
      "codemode-api.js",
    );
    if (install.error) {
      const failure = stopped() ?? errorShape(vm.dump(install.error));
      install.error.dispose();
      return { output: "", calls, truncated: false, error: failure };
    }
    install.value.dispose();

    let result: CodeModeRunResult;
    const evaluated = vm.evalCode(`(async () => {\n${javascript}\n})()`, "codemode-script.ts");
    if (evaluated.error) {
      result = {
        output: logs.join("\n"),
        calls,
        truncated,
        error: stopped() ?? errorShape(vm.dump(evaluated.error)),
      };
      evaluated.error.dispose();
    } else {
      const outcome = vm.resolvePromise(evaluated.value);
      outcome.then(
        () => {
          settled = true;
          wakeWaiter?.();
        },
        () => {
          settled = true;
          wakeWaiter?.();
        },
      );

      pump();

      if (!settled && !deadline.aborted) {
        await new Promise<void>((resolve) => {
          const onAbort = () => resolve();
          wakeWaiter = () => {
            deadline.removeEventListener("abort", onAbort);
            resolve();
          };
          deadline.addEventListener("abort", onAbort, { once: true });
          if (settled || deadline.aborted) {
            deadline.removeEventListener("abort", onAbort);
            resolve();
            return;
          }
          if (inFlight === 0 && !vm.runtime.hasPendingJob()) {
            scheduleDeadlockCheck();
          }
        });
        wakeWaiter = undefined;
      }

      const stopReason = stopped();
      // An interrupt rejects the script's promise; pump once if pending so its handle can settle.
      if (!settled && stopReason && vm.runtime.hasPendingJob()) {
        vm.runtime.executePendingJobs();
        await Promise.resolve();
      }
      if (settled) {
        const resolved = await outcome;
        if (resolved.error) {
          result = {
            output: logs.join("\n"),
            calls,
            truncated,
            error: stopReason ?? errorShape(vm.dump(resolved.error)),
          };
          resolved.error.dispose();
        } else {
          result = {
            output: logs.join("\n"),
            calls,
            truncated,
          };
          resolved.value.dispose();
        }
      } else if (stopReason) {
        result = {
          output: logs.join("\n"),
          calls,
          truncated,
          error: stopReason,
        };
      } else if (inFlight === 0 && !vm.runtime.hasPendingJob()) {
        result = {
          output: logs.join("\n"),
          calls,
          truncated,
          error: {
            name: "Error",
            message: "the script ended with an unresolved promise",
          },
        };
      } else {
        result = {
          output: logs.join("\n"),
          calls,
          truncated,
          error: {
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
    if (returnValue !== undefined) result.returnValue = returnValue;
    return result;
  } finally {
    disposed = true;
    for (const deferred of pending) deferred.dispose();
    pending.clear();
    vm.dispose();
    runtime.dispose();
  }
}
