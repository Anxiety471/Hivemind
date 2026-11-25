import { Trans, useLingui } from "@lingui/react/macro";
import type { RoutineCommand } from "@rakazo/contracts";
import { FieldError, OptionSelect, Textarea } from "@rakazo/ui-web";
import type { RoutinePrepareDraft } from "../../../lib/routines/routine-draft";
import { prepareFromDraft } from "../../../lib/routines/routine-draft";

/** The saved command a routine runs before its model, with arguments for the picked one. */
export function RoutinePrepareField({
  prepare,
  commands,
  onChange,
  fieldId,
}: {
  prepare: RoutinePrepareDraft | null;
  /** The Space's saved commands; empty hides the field unless one is already set. */
  commands: RoutineCommand[];
  onChange: (prepare: RoutinePrepareDraft | null) => void;
  fieldId: string;
}) {
  const { t } = useLingui();
  const id = `${fieldId}-prepare`;
  if (!prepare && !commands.length) return null;

  const selected = prepare ? commands.find((command) => command.name === prepare.command) : null;
  const takesArgs = selected
    ? selected.parameters !== null
    : Boolean(prepare && prepare.args.trim() !== "{}" && prepare.args.trim());
  const parsed = prepare ? prepareFromDraft(prepare) : null;
  const argsError = takesArgs && parsed && "error" in parsed ? parsed.error : null;

  return (
    <div className="mt-5 text-body text-muted-foreground">
      <label htmlFor={id} className="block">
        <Trans>Run first</Trans>
        <OptionSelect
          id={id}
          className="mt-2"
          value={prepare?.command ?? ""}
          onValueChange={(command) => {
            if (!command) {
              onChange(null);
              return;
            }
            onChange({
              command,
              args: prepare?.command === command ? prepare.args : "{}",
            });
          }}
          options={[
            { value: "", label: t`None` },
            ...(prepare && !commands.some((command) => command.name === prepare.command)
              ? [{ value: prepare.command, label: prepare.command }]
              : []),
            ...commands.map((command) => ({ value: command.name, label: command.name })),
          ]}
        />
      </label>
      {selected?.description ? (
        <p className="mt-1.5 text-body-sm text-muted-foreground/70">{selected.description}</p>
      ) : null}
      {prepare && takesArgs ? (
        <>
          <label htmlFor={`${id}-args`} className="mt-3 block">
            <Trans>Arguments</Trans>
            <Textarea
              id={`${id}-args`}
              value={prepare.args}
              onChange={(e) => onChange({ ...prepare, args: e.target.value })}
              aria-invalid={argsError ? true : undefined}
              aria-describedby={argsError ? `${id}-args-error` : undefined}
              rows={2}
              className="mt-2 font-mono text-body-sm"
            />
          </label>
          {argsError ? <FieldError id={`${id}-args-error`}>{argsError}</FieldError> : null}
        </>
      ) : null}
    </div>
  );
}
