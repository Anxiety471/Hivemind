import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
  Spinner,
  Switch,
  Toggle,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ProviderSettingsDraft } from "../../components/models/ProviderSettingsForm";
import { ProviderSettingsForm } from "../../components/models/ProviderSettingsForm";
import { SETTINGS_CONTENT_WIDTH } from "../../components/settings/SettingsRows";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorCode, errorText } from "../../lib/query/user-error";
import { SpaceMemorySection } from "../space/KnowledgeSection";

type MemoryScope = "isolated" | "shared";

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
  const roamerChange = useSave({
    save: async (input: { enabled: boolean; intervalMinutes?: number }, rpc) =>
      rpc.memory.setRoamer(input),
    stale: [queries.memory.roamer.queryKey()],
  });
  const intervalInputId = useId();
  const [intervalDraft, setIntervalDraft] = useState("360");
  const [intervalError, setIntervalError] = useState<string | null>(null);
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
  const busy = change.pending || roamerChange.pending;

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
              <Trans>Memory</Trans>
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
                Uses your main model connection. Tidies only MEMORY.md, USER.md, Instructions, and
                shared memory. Other notes stay read-only.
              </Trans>
            </p>
            <Field className="mt-3">
              <FieldLabel htmlFor={intervalInputId}>
                <Trans>Check every (minutes)</Trans>
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={intervalInputId}
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
                {intervalSummary ? (
                  <span className="text-body-sm text-muted-foreground">{intervalSummary}</span>
                ) : null}
              </div>
            </Field>
            {intervalError ? (
              <p role="alert" className="mt-2 text-body-sm text-destructive">
                {intervalError}
              </p>
            ) : null}
            <p
              className={`mt-3 text-body-sm ${roamer?.lastError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {roamer === undefined
                ? t`Loading…`
                : roamer.lastError
                  ? t`Last run failed: ${roamer.lastError}`
                  : roamer.lastRunAt
                    ? t`Last run ${new Date(roamer.lastRunAt).toLocaleString()}`
                    : roamer.enabled
                      ? t`Waiting for the first run`
                      : t`Off`}
            </p>
            {roamer?.lastRunAt && !roamer.lastError ? (
              <p className="mt-1 text-body-sm text-muted-foreground">
                {roamer.lastChanges === 1 ? t`1 change` : t`${roamer.lastChanges} changes`}
              </p>
            ) : null}
            {roamer?.lastReport?.length ? (
              <details className="mt-2 text-body-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Details</Trans>
                </summary>
                <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                  {roamer.lastReport.map((target) => (
                    <li key={`${target.kind}:${target.id}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium text-foreground">
                          {target.kind === "shared"
                            ? t`Shared memory (${target.name})`
                            : target.name}
                        </span>
                        <span className="shrink-0 text-caption text-muted-foreground">
                          {new Date(target.checkedAt).toLocaleTimeString()}
                        </span>
                      </div>
                      {target.status === "failed" ? (
                        <p className="text-destructive">{target.error}</p>
                      ) : target.changes.length === 0 ? (
                        <p className="text-muted-foreground">
                          <Trans>No changes</Trans>
                        </p>
                      ) : (
                        <ul className="mt-0.5 text-muted-foreground">
                          {target.changes.map((change) => (
                            <li key={`${change.scope}:${change.path}`}>
                              {change.path}: {change.beforeBytes} → {change.afterBytes} bytes
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : roamer?.lastFailures?.length ? (
              <details className="mt-2 text-body-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Details</Trans>
                </summary>
                <ul className="mt-2 max-h-52 space-y-1.5 overflow-y-auto">
                  {roamer.lastFailures.map((failure) => (
                    <li key={`${failure.kind}:${failure.id}`}>
                      <span className="font-medium text-foreground">
                        {failure.kind === "shared"
                          ? t`Shared memory (${failure.name})`
                          : failure.name}
                      </span>
                      <span className="text-muted-foreground">: {failure.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {roamer?.retryAt ? (
              <p className="mt-2 text-body-sm text-muted-foreground">
                {t`Retrying ${new Date(roamer.retryAt).toLocaleString()} (attempt ${roamer.retryAttempt})`}
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
