import { Trans, useLingui } from "@lingui/react/macro";
import type { BoardRepository, BoardRepositoryInput } from "@rakazo/contracts";
import { BOARD_MAX_REPOSITORIES, normalizeRepositoryUrl, ticketLinkLabel } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { getLabs, subscribeLabs } from "../../lib/bootstrap";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** The Space's board repositories, which ticket and commit links resolve against. Off without the board lab. */
export function SpaceBoardSettings({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const boardEnabled = useSyncExternalStore(
    subscribeLabs,
    () => getLabs().includes("board"),
    () => false,
  );
  if (!boardEnabled) return null;
  return <BoardRepositories onBusyChange={onBusyChange} />;
}

function BoardRepositories({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const board = useQuery(queries.boards.get.queryOptions());
  const [url, setUrl] = useState("");
  const [aliases, setAliases] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const save = useSave<BoardRepositoryInput[]>({
    save: (repositories, rpc) => rpc.boards.rename({ repositories }),
    stale: [queries.boards.get.key(), queries.boards.list.key()],
    onSaved: () => {
      setUrl("");
      setAliases("");
    },
  });
  useEffect(() => {
    onBusyChange?.(save.pending);
  }, [save.pending, onBusyChange]);

  if (!board.data) {
    return board.isError ? (
      <p role="alert" className="text-body-sm text-destructive">
        {errorText(board.error)}
      </p>
    ) : null;
  }
  const repositories = board.data.repositories;

  // Saves the whole list: the server replaces the board's repositories with what is sent.
  function replaceWith(next: BoardRepositoryInput[]) {
    setFormError(null);
    save.run(next);
  }

  function remove(target: BoardRepository) {
    const rest = repositories.filter((repo) => repo.url !== target.url);
    // Losing the default hands it to the first repository left.
    const promote = target.isDefault && rest.length > 0;
    replaceWith(
      rest.map((repo, index) => ({
        ...repo,
        isDefault: promote ? index === 0 : repo.isDefault,
      })),
    );
  }

  function makeDefault(target: BoardRepository) {
    replaceWith(repositories.map((repo) => ({ ...repo, isDefault: repo.url === target.url })));
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.pending) return;
    const normalized = normalizeRepositoryUrl(url);
    if (!normalized) {
      setFormError(t`Use a repository link such as https://example.com/owner/repo.`);
      return;
    }
    if (repositories.some((repo) => repo.url === normalized)) {
      setFormError(t`That repository is already on the board.`);
      return;
    }
    if (repositories.length >= BOARD_MAX_REPOSITORIES) {
      setFormError(t`A board holds up to ${BOARD_MAX_REPOSITORIES} repositories.`);
      return;
    }
    const added = aliases
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean);
    // The first repository on a board becomes its default.
    const hasDefault = repositories.some((repo) => repo.isDefault);
    replaceWith([...repositories, { url: normalized, aliases: added, isDefault: !hasDefault }]);
  }

  const message = formError ?? (save.error ? errorText(save.error) : null);

  return (
    <SettingsGroup title={<Trans>Repositories</Trans>} data-testid="space-board-repositories">
      {repositories.map((repo) => {
        const label = ticketLinkLabel(repo.url);
        return (
          <SettingsRow
            key={repo.url}
            label={
              <>
                <p className="font-mono">{label}</p>
                <p className="text-body-sm text-muted-foreground">{repo.url}</p>
                {repo.aliases.map((alias) => (
                  <p key={alias} className="text-body-sm text-muted-foreground">
                    {alias}
                  </p>
                ))}
              </>
            }
            control={
              <>
                {repo.isDefault ? (
                  <span className="text-body-sm text-muted-foreground">
                    <Trans>Default</Trans>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full"
                    disabled={save.pending}
                    onClick={() => makeDefault(repo)}
                  >
                    <Trans>Make default</Trans>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Remove ${label}`}
                  disabled={save.pending}
                  onClick={() => remove(repo)}
                >
                  <X aria-hidden />
                </Button>
              </>
            }
          />
        );
      })}
      <div className="px-4 py-3">
        <form
          noValidate
          className="flex flex-wrap items-center gap-2"
          onSubmit={add}
          data-testid="space-board-repository-form"
        >
          <Input
            type="url"
            size="sm"
            className="w-56"
            aria-label={t`Repository URL`}
            placeholder="https://example.com/owner/repo"
            value={url}
            disabled={save.pending}
            onChange={(event) => {
              setUrl(event.target.value);
              setFormError(null);
              save.reset();
            }}
          />
          <Input
            size="sm"
            className="w-48"
            aria-label={t`Aliases (comma-separated)`}
            placeholder={t`Aliases (comma-separated)`}
            value={aliases}
            disabled={save.pending}
            onChange={(event) => {
              setAliases(event.target.value);
              setFormError(null);
              save.reset();
            }}
          />
          <Button type="submit" size="sm" disabled={save.pending}>
            <Trans>Add</Trans>
          </Button>
        </form>
        {message ? (
          <p role="alert" className="pt-2 text-body-sm text-destructive">
            {message}
          </p>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
