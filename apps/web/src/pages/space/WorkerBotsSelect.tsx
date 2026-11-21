import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

export function WorkerBotsSelect({
  id,
  bots,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  bots: readonly Bot[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter((bot) => bot.name.toLowerCase().includes(q));
  }, [bots, query]);

  const selectedNames = useMemo(() => {
    const byId = new Map(bots.map((bot) => [bot.id, bot.name]));
    return value.map((botId) => byId.get(botId)).filter((name): name is string => Boolean(name));
  }, [bots, value]);

  const summary =
    selectedNames.length === 0
      ? t`No workers`
      : selectedNames.length <= 2
        ? selectedNames.join(", ")
        : `${selectedNames.slice(0, 2).join(", ")} (+${selectedNames.length - 2})`;

  const toggle = (botId: string) => {
    if (selected.has(botId)) {
      onChange(value.filter((item) => item !== botId));
    } else {
      onChange([...value, botId]);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            size="default"
            disabled={disabled || bots.length === 0}
            data-testid="worker-bots-trigger"
            className="w-full justify-between font-normal"
          >
            <span
              className={cn(
                "min-w-0 truncate text-start",
                selectedNames.length === 0 && "text-muted-foreground",
              )}
            >
              {summary}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72 p-2">
        {bots.length > 6 ? (
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search bots`}
            aria-label={t`Search bots`}
          />
        ) : null}
        <fieldset
          aria-label={t`Workers`}
          data-testid="worker-bots-list"
          className="flex max-h-56 flex-col gap-0.5 overflow-y-auto"
        >
          {filtered.map((bot) => {
            const checked = selected.has(bot.id);
            const optionId = `${id ?? "workers"}-${bot.id}`;
            return (
              <label
                key={bot.id}
                htmlFor={optionId}
                data-testid={`worker-bot-option-${bot.id}`}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-sm hover:bg-accent"
              >
                <Checkbox id={optionId} checked={checked} onCheckedChange={() => toggle(bot.id)} />
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              </label>
            );
          })}
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-body-sm text-muted-foreground">
              <Trans>No matching bots</Trans>
            </p>
          ) : null}
        </fieldset>
        {value.length > 0 ? (
          <div className="flex justify-end border-t border-border pt-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange([])}>
              <Trans>Clear</Trans>
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
