import { Trans, useLingui } from "@lingui/react/macro";
import type { MemoryRoamerTarget, SpaceMemoryConfig } from "@rakazo/contracts";
import { SYSTEM_PROMPT_APPEND_MAX_CHARS } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Disclosure,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
  Spinner,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock3, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ProviderSettingsDraft } from "../../components/models/ProviderSettingsForm";
import { ProviderSettingsForm } from "../../components/models/ProviderSettingsForm";
import { SETTINGS_CONTENT_WIDTH } from "../../components/settings/SettingsRows";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorCode, errorText } from "../../lib/query/user-error";
import { useEventListener } from "../../lib/use-event-listener";
import { SpaceMemorySection } from "../space/KnowledgeSection";

type MemoryScope = "isolated" | "shared";

function shortWhen(value: string): string {
  const date = new Date(value);
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(
    undefined,
    sameDay ? time : { month: "short", day: "numeric", ...time },
  );
}

type Change =
  | { kind: "connect"; provider: string; draft: ProviderSettingsDraft; scope: MemoryScope }
  | { kind: "update"; draft: ProviderSettingsDraft }
  | { kind: "scope"; scope: MemoryScope }
  | { kind: "disconnect" };

function ScopePicker({
  value,
  disabled,
  onChange,
}: {
  value: MemoryScope;
  disabled: boolean;
  onChange: (scope: MemoryScope) => void;
}) {
  const labelId = useId();
  return (
    <Field aria-labelledby={labelId}>
      <FieldLabel id={labelId}>
        <Trans>Default scope</Trans>
      </FieldLabel>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {(["isolated", "shared"] as const).map((option) => (
          <Toggle
            key={option}
            pressed={value === option}
            disabled={disabled}
            onPressedChange={() => onChange(option)}
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            {option === "isolated" ? <Trans>Isolated</Trans> : <Trans>Shared</Trans>}
          </Toggle>
        ))}
      </div>
    </Field>
  );
}

export function MemorySettingsOverlay({
  onClose,
  config,
  onConfigChange,
  embedded = false,
  onBusyChange,
}: {
  onClose: () => void;
  config: SpaceMemoryConfig | null | undefined;
  onConfigChange: (config: SpaceMemoryConfig | null) => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const providerSelectId = useId();
  const providersQuery = useQuery(queries.memory.providers.queryOptions());
  // A server from before this call has no providers to describe: nothing can be connected or
  // edited. Any other failure is a load to retry, not an empty list.
  const olderServer = errorCode(providersQuery.error) === "NOT_FOUND";
  const providers = providersQuery.data ?? (olderServer ? [] : undefined);
  const [selectedProvider, setSelectedProvider] = useState(config?.provider);
  const [defaultScope, setDefaultScope] = useState<MemoryScope>(
    config?.defaultMemoryScope ?? "isolated",
  );
  const [addingProvider, setAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState(false);
  const change = useSave({
    save: async (input: Change, rpc): Promise<SpaceMemoryConfig | null> => {
      if (input.kind === "connect") {
        return rpc.memory.connectProvider({
          provider: input.provider,
          ...input.draft,
          defaultMemoryScope: input.scope,
        });
      }
      if (input.kind === "update") return rpc.memory.updateProvider(input.draft);
      if (input.kind === "scope") {
        return rpc.memory.setDefaultScope({ defaultMemoryScope: input.scope });
      }
      await rpc.memory.disconnectProvider();
      return null;
    },
    // What is remembered and how much room it has are read through the connected provider.
    stale: [
      queries.memory.providerConfig.queryKey(),
      queries.memory.list.key(),
      queries.memory.budget.key(),
    ],
    onSaved: (next, input) => {
      if (input.kind === "disconnect") setAddingProvider(false);
      if (input.kind === "disconnect" || input.kind === "update") setEditingProvider(false);
      onConfigChange(next);
    },
  });
  const roamerQuery = useQuery(queries.memory.roamer.queryOptions());
  const roamer = roamerQuery.data;
  const failedTargets = roamer?.lastReport?.filter((target) => target.status === "failed") ?? [];
  const okTargets = roamer?.lastReport?.filter((target) => target.status === "ok") ?? [];
  const changedTargets = okTargets.filter((target) => target.changes.length > 0);
  const unchangedTargets = okTargets.filter((target) => target.changes.length === 0);
  const targetName = (target: Pick<MemoryRoamerTarget, "kind" | "name">) =>
    target.kind === "shared"
      ? t`Shared Memory (${target.name})`
      : target.kind === "skills"
        ? t`Skills (${target.name})`
        : target.name;
  const failureCount = failedTargets.length || roamer?.lastFailures?.length || 0;
  const totalChecks = failedTargets.length + okTargets.length;
  const firstFailure = failedTargets[0] ?? roamer?.lastFailures?.[0];
  const failureSummary = firstFailure
    ? failureCount > 1
      ? t`${targetName(firstFailure)} and ${failureCount - 1} more`
      : targetName(firstFailure)
    : null;
  const runFailed = Boolean(roamer?.lastError || failureCount);
  const hasResults = failureCount > 0 || okTargets.length > 0;
  const changeSummary = (target: MemoryRoamerTarget) =>
    target.changes.length
      ? target.changes
          .map((change) =>
            change.command
              ? t`${change.command} ${change.path}: ${change.beforeBytes} → ${change.afterBytes} bytes`
              : t`${change.path}: ${change.beforeBytes} → ${change.afterBytes} bytes`,
          )
          .join("; ")
      : t`No changes`;
  const roamerChange = useSave({
    save: async (input: { enabled: boolean; intervalMinutes?: number }, rpc) =>
      rpc.memory.setRoamer(input),
    stale: [queries.memory.roamer.queryKey()],
  });
  const systemPromptQuery = useQuery(queries.memory.systemPrompt.queryOptions());
  const systemPrompt = systemPromptQuery.data;
  const promptAppendId = useId();
  const [promptDraft, setPromptDraft] = useState("");
  useEffect(() => {
    if (systemPrompt) setPromptDraft(systemPrompt.append);
  }, [systemPrompt?.append]);
  const promptSave = useSave({
    save: async (append: string, rpc) => rpc.memory.setSystemPrompt({ append }),
    stale: [queries.memory.systemPrompt.queryKey()],
    onSaved: (saved) => {
      setPromptDraft(saved.append);
    },
  });
  const promptDirty =
    systemPrompt !== undefined && promptDraft.trim() !== systemPrompt.append.trim();
  const intervalInputId = useId();
  const [intervalDraft, setIntervalDraft] = useState("360");
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEventListener(
    detailsOpen ? document : null,
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const popup = document.querySelector("[data-run-results]");
      if (popup && !popup.contains(target)) setDetailsOpen(false);
    },
    true,
  );
  useEffect(() => {
    if (roamer) setIntervalDraft(String(roamer.intervalMinutes));
  }, [roamer?.intervalMinutes]);
  const saveInterval = () => {
    const minutes = Number(intervalDraft);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 10_080) {
      setIntervalError(t`Enter 15 to 10,080 minutes.`);
      return;
    }
    setIntervalError(null);
    if (minutes === roamer?.intervalMinutes) return;
    roamerChange.run({ enabled: roamer?.enabled ?? false, intervalMinutes: minutes });
  };
  const intervalSummary =
    Number(intervalDraft) >= 15 && Number(intervalDraft) <= 10_080
      ? Number(intervalDraft) % 1_440 === 0
        ? Number(intervalDraft) === 1_440
          ? t`every day`
          : t`every ${Number(intervalDraft) / 1_440} days`
        : Number(intervalDraft) % 60 === 0
          ? Number(intervalDraft) === 60
            ? t`every hour`
            : t`every ${Number(intervalDraft) / 60} hours`
          : t`every ${Number(intervalDraft)} minutes`
      : null;
  const busy = change.pending || roamerChange.pending || promptSave.pending;

  useEffect(() => {
    if (!config) return;
    setSelectedProvider(config.provider);
    setDefaultScope(config.defaultMemoryScope);
  }, [config]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const descriptor =
    providers?.find((entry) => entry.id === (config?.provider ?? selectedProvider)) ??
    (config ? undefined : providers?.[0]);
  const nameOf = (id: string | undefined) =>
    providers?.find((entry) => entry.id === id)?.displayName ?? id;
  const failed = change.error ? change.input : undefined;
  const error = !failed
    ? null
    : failed.kind === "connect"
      ? errorText(change.error, t`Could not connect ${nameOf(failed.provider)}`)
      : failed.kind === "update"
        ? errorText(change.error, t`Could not save ${nameOf(config?.provider)}`)
        : failed.kind === "scope"
          ? errorText(change.error, t`Could not update the default memory scope`)
          : errorText(change.error, t`Could not disconnect memory provider`);

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-heading2 font-medium text-foreground">
              <Trans>Shared Memory</Trans>
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close memory settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
      ) : null}

      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-6 sm:px-8 sm:pb-8">
        <div className={`space-y-5 ${SETTINGS_CONTENT_WIDTH}`}>
          {error ? <p className="text-body-sm text-destructive">{error}</p> : null}

          <SpaceMemorySection />

          <section
            className="rounded-xl border border-border px-4 py-4"
            data-testid="space-system-prompt"
          >
            <SectionHeading variant="heading">
              <Trans>System prompt</Trans>
            </SectionHeading>
            {systemPrompt?.basePromptPreview ? (
              <Disclosure
                summary={
                  <span className="text-body-sm text-muted-foreground">
                    <Trans>View base prompt</Trans>
                  </span>
                }
                className="mt-2"
                contentClassName="mt-2"
              >
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-mono text-caption text-muted-foreground">
                  {systemPrompt.basePromptPreview}
                </pre>
              </Disclosure>
            ) : null}
            <Field className="mt-3">
              <FieldLabel htmlFor={promptAppendId}>
                <Trans>Append to system prompt</Trans>
              </FieldLabel>
              <Textarea
                id={promptAppendId}
                rows={4}
                maxLength={SYSTEM_PROMPT_APPEND_MAX_CHARS}
                value={promptDraft}
                disabled={!systemPrompt || promptSave.pending}
                onChange={(event) => {
                  setPromptDraft(event.target.value);
                  promptSave.reset();
                }}
                className="font-mono text-body-sm"
              />
              {systemPrompt?.hasHostAppend ? (
                <FieldDescription>
                  <Trans>Host append file is also active.</Trans>
                </FieldDescription>
              ) : null}
            </Field>
            {promptSave.error ? (
              <p role="alert" className="mt-2 text-body-sm text-destructive">
                {errorText(promptSave.error, t`Could not save system prompt additions`)}
              </p>
            ) : null}
            <div className="mt-3 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={!promptDirty || promptSave.pending}
                onClick={() => promptSave.run(promptDraft)}
              >
                {promptSave.pending ? <Trans>Saving…</Trans> : <Trans>Save prompt</Trans>}
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <SectionHeading variant="heading">
                <Trans>Background roamer</Trans>
              </SectionHeading>
              <Switch
                checked={roamer?.enabled ?? false}
                disabled={!roamer || roamerChange.pending}
                aria-label={t`Run memory maintenance in the background`}
                onCheckedChange={(enabled) => {
                  const minutes = Number(intervalDraft);
                  roamerChange.run({
                    enabled,
                    intervalMinutes:
                      Number.isInteger(minutes) && minutes >= 15 && minutes <= 10_080
                        ? minutes
                        : roamer?.intervalMinutes,
                  });
                }}
              />
            </div>
            <p className="mt-1 text-body-sm text-muted-foreground">
              <Trans>
                Tidies MEMORY.md, USER.md, Instructions, shared memory, and Space skills with your
                main model; other notes stay read-only.
              </Trans>
            </p>
            <div className="mt-4">
              {roamer === undefined ? (
                <p className="text-body-sm text-muted-foreground">
                  <Trans>Loading…</Trans>
                </p>
              ) : roamer.lastRunAt || runFailed ? (
                <div
                  className={`rounded-xl border px-3 py-3 ${
                    runFailed
                      ? "border-destructive/25 bg-destructive/5"
                      : "border-border bg-muted/30"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                        runFailed
                          ? "bg-destructive/10 text-destructive"
                          : "bg-success/10 text-success"
                      }`}
                    >
                      {runFailed ? (
                        <CircleAlert className="size-4" />
                      ) : (
                        <CircleCheck className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p
                          className={`text-body font-medium ${
                            runFailed ? "text-destructive" : "text-foreground"
                          }`}
                        >
                          {runFailed ? t`Last run failed` : t`Last run completed`}
                        </p>
                        {roamer.lastRunAt ? (
                          <span className="shrink-0 text-caption text-muted-foreground">
                            {shortWhen(roamer.lastRunAt)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-body-sm text-muted-foreground">
                        {runFailed
                          ? totalChecks
                            ? t`${failureCount} of ${totalChecks} checks failed`
                            : (roamer.lastError ?? t`Failed`)
                          : totalChecks
                            ? t`${totalChecks} checks completed`
                            : t`Completed`}
                      </p>
                      {failureSummary ? (
                        <p className="mt-2 text-body-sm font-medium text-foreground">
                          {failureSummary}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {hasResults ? (
                          <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
                            {t`View results`}
                          </Button>
                        ) : null}
                        {roamer.retryAt ? (
                          <span className="text-caption text-muted-foreground">
                            {t`Retry at ${shortWhen(roamer.retryAt)} · attempt ${roamer.retryAttempt}`}
                          </span>
                        ) : !runFailed && roamer.lastChanges > 0 ? (
                          <span className="text-caption text-muted-foreground">
                            {roamer.lastChanges === 1
                              ? t`1 change`
                              : t`${roamer.lastChanges} changes`}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Clock3 className="size-4" />
                  </span>
                  <div>
                    <p className="text-body font-medium text-foreground">
                      {roamer.enabled ? t`Waiting for the first run` : t`Off`}
                    </p>
                    <p className="mt-0.5 text-body-sm text-muted-foreground">
                      {roamer.enabled
                        ? t`It runs within the next 15 minutes.`
                        : t`Turn it on to consolidate memory in the background.`}
                    </p>
                  </div>
                </div>
              )}
            </div>
            <Field orientation="horizontal" className="mt-4 border-t border-border pt-4">
              <FieldContent>
                <FieldLabel htmlFor={intervalInputId}>
                  <Trans>Check every</Trans>
                </FieldLabel>
                <FieldDescription className="text-body-sm">
                  {intervalSummary ?? t`15 to 10,080 minutes`}
                </FieldDescription>
              </FieldContent>
              <div className="flex items-center gap-2">
                <Input
                  id={intervalInputId}
                  className="w-24"
                  type="number"
                  inputMode="numeric"
                  min={15}
                  max={10_080}
                  step={15}
                  value={intervalDraft}
                  disabled={!roamer || roamerChange.pending}
                  onChange={(event) => setIntervalDraft(event.target.value)}
                  onBlur={saveInterval}
                />
                <span className="text-body-sm text-muted-foreground">
                  <Trans>min</Trans>
                </span>
              </div>
            </Field>
            {intervalError ? (
              <p role="alert" className="mt-2 text-body-sm text-destructive">
                {intervalError}
              </p>
            ) : null}
            {roamerChange.error ? (
              <p role="alert" className="mt-2 text-body-sm text-destructive">
                {errorText(roamerChange.error, t`Could not save the memory roamer`)}
              </p>
            ) : null}
          </section>

          {providers === undefined && providersQuery.isError ? (
            <div role="alert" className="text-body-sm text-destructive">
              {errorText(providersQuery.error)}
              <Button variant="ghost" size="sm" onClick={() => void providersQuery.refetch()}>
                {t`Retry`}
              </Button>
            </div>
          ) : config === undefined || providers === undefined ? (
            <p className="text-body-sm text-muted-foreground">
              <Spinner aria-label={t`Loading memory settings…`} />
            </p>
          ) : config ? (
            <section className="rounded-xl border border-border px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <SectionHeading variant="heading">{nameOf(config.provider)}</SectionHeading>
                <span className="text-body-sm text-success">
                  <Trans>Connected</Trans>
                </span>
              </div>
              <p className="mt-1 text-body-sm text-muted-foreground">
                {config.connectionLabel ?? config.provider}
              </p>
              <div className="mt-4">
                <ScopePicker
                  value={defaultScope}
                  disabled={busy}
                  onChange={(scope) => {
                    if (scope !== defaultScope) change.run({ kind: "scope", scope });
                  }}
                />
              </div>
              {editingProvider && descriptor ? (
                <>
                  <ProviderSettingsForm
                    fields={descriptor.fields}
                    busy={busy}
                    saved={config.settings}
                    onSubmit={(draft) => change.run({ kind: "update", draft })}
                    advancedSettings={null}
                  />
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingProvider(false);
                      change.reset();
                    }}
                    className="mt-5 ml-2"
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </>
              ) : (
                <div className="mt-5 flex gap-2">
                  {descriptor ? (
                    <Button
                      variant="outline"
                      type="button"
                      disabled={busy}
                      onClick={() => setEditingProvider(true)}
                    >
                      <Trans>Edit</Trans>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => change.run({ kind: "disconnect" })}
                  >
                    {busy && change.input?.kind === "disconnect" ? (
                      <Trans>Disconnecting…</Trans>
                    ) : (
                      <Trans>Disconnect</Trans>
                    )}
                  </Button>
                </div>
              )}
            </section>
          ) : !addingProvider ? (
            <Button
              variant="outline"
              type="button"
              onClick={() => setAddingProvider(true)}
              className="rounded-full"
            >
              <Trans>Connect memory provider</Trans>
            </Button>
          ) : descriptor ? (
            <section className="rounded-xl border border-border px-4 py-4">
              <SectionHeading id={providerSelectId} variant="heading">
                <Trans>Provider</Trans>
              </SectionHeading>
              {providers.length > 1 ? (
                <div className="mt-3">
                  <OptionSelect
                    aria-labelledby={providerSelectId}
                    value={descriptor.id}
                    disabled={busy}
                    options={providers.map((entry) => ({
                      value: entry.id,
                      label: entry.displayName,
                    }))}
                    onValueChange={setSelectedProvider}
                  />
                </div>
              ) : (
                <p className="mt-3 text-body text-foreground">{descriptor.displayName}</p>
              )}

              <p className="mt-3 text-body-sm text-muted-foreground">
                <Trans>
                  An external memory service for storing and recalling context across chats.
                </Trans>
              </p>
              <ProviderSettingsForm
                key={descriptor.id}
                fields={descriptor.fields}
                busy={busy}
                onSubmit={(draft) =>
                  change.run({
                    kind: "connect",
                    provider: descriptor.id,
                    draft,
                    scope: defaultScope,
                  })
                }
                advancedSettings={
                  <div className="mt-4">
                    <ScopePicker value={defaultScope} disabled={busy} onChange={setDefaultScope} />
                  </div>
                }
              />
            </section>
          ) : (
            <p className="text-body-sm text-destructive">
              <Trans>The selected memory provider is not available in this build.</Trans>
            </p>
          )}
        </div>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent size="md" showCloseButton={false} data-run-results className="bg-card">
          <div className="flex items-start justify-between gap-4 px-5 pt-4">
            <div>
              <DialogTitle className="text-heading2 font-medium text-foreground">
                <Trans>Run results</Trans>
              </DialogTitle>
              <p className="mt-1 text-body-sm text-muted-foreground">
                {[
                  failureCount
                    ? failureCount === 1
                      ? t`1 failed`
                      : t`${failureCount} failed`
                    : null,
                  okTargets.length ? t`${okTargets.length} completed` : null,
                  roamer?.lastRunAt ? shortWhen(roamer.lastRunAt) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <DialogClose
              aria-label={t`Close run results`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <XIcon />
            </DialogClose>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-border px-5 pb-4">
            {failureCount ? (
              <section className="py-3">
                <h3 className="text-body-sm font-medium text-muted-foreground">
                  <Trans>Failed</Trans>
                </h3>
                <ul className="mt-1 divide-y divide-border">
                  {failedTargets.length
                    ? failedTargets.map((target) => (
                        <li key={`${target.kind}:${target.id}`} className="flex gap-3 py-2.5">
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
                          <div className="min-w-0 flex-1">
                            <p className="text-body-sm font-medium text-foreground">
                              {targetName(target)}
                            </p>
                            <p className="mt-0.5 text-body-sm text-destructive">
                              {target.error ?? t`Failed`}
                            </p>
                            {target.changes.length ? (
                              <p className="mt-1 text-body-sm text-muted-foreground">
                                {changeSummary(target)}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      ))
                    : roamer?.lastFailures?.map((failure) => (
                        <li key={`${failure.kind}:${failure.id}`} className="flex gap-3 py-2.5">
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
                          <div className="min-w-0 flex-1">
                            <p className="text-body-sm font-medium text-foreground">
                              {targetName(failure)}
                            </p>
                            <p className="mt-0.5 text-body-sm text-destructive">{failure.error}</p>
                          </div>
                        </li>
                      ))}
                </ul>
              </section>
            ) : null}
            {changedTargets.length ? (
              <section className="py-3">
                <h3 className="text-body-sm font-medium text-muted-foreground">
                  <Trans>Changed</Trans>
                </h3>
                <ul className="mt-1 divide-y divide-border">
                  {changedTargets.map((target) => (
                    <li
                      key={`${target.kind}:${target.id}`}
                      className="flex items-start gap-3 py-2.5"
                    >
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
                      <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
                        <p className="text-body-sm font-medium text-foreground">
                          {targetName(target)}
                        </p>
                        <p className="text-end text-body-sm text-muted-foreground">
                          {changeSummary(target)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {unchangedTargets.length ? (
              <Disclosure
                className="border-t border-border py-3"
                summary={
                  unchangedTargets.length === 1
                    ? t`1 with no changes`
                    : t`${unchangedTargets.length} with no changes`
                }
                summaryClassName="text-body-sm text-muted-foreground"
              >
                <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                  {unchangedTargets.map((target) => (
                    <li
                      key={`${target.kind}:${target.id}`}
                      className="flex items-center gap-2 text-body-sm text-foreground"
                    >
                      <span className="size-1.5 shrink-0 rounded-full bg-success" />
                      <span className="min-w-0">{targetName(target)}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="memory-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(760px,calc(100%-2rem))] w-[560px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[min(760px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
