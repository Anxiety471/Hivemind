import { useLingui } from "@lingui/react/macro";
import type { DriveFolderTreeEntry } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  OptionSelect,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";

export type MoveTarget =
  | { kind: "folder"; id: string; name: string; parentId: string | null }
  | { kind: "file"; id: string; name: string; parentId: string | null };

const ROOT = "root";

/** Flattens the folder tree, leaving out the folder being moved and everything under it. */
function destinationOptions(
  folders: readonly DriveFolderTreeEntry[],
  movingFolderId: string | null,
  rootLabel: string,
): { value: string; label: string }[] {
  const children = new Map<string | null, DriveFolderTreeEntry[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  const excluded = new Set<string>();
  if (movingFolderId) {
    const pending = [movingFolderId];
    while (pending.length) {
      const id = pending.pop()!;
      if (excluded.has(id)) continue;
      excluded.add(id);
      for (const child of children.get(id) ?? []) pending.push(child.id);
    }
  }
  const options = [{ value: ROOT, label: rootLabel }];
  const walk = (parentId: string | null, depth: number) => {
    const siblings = [...(children.get(parentId) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const folder of siblings) {
      if (excluded.has(folder.id)) continue;
      options.push({ value: folder.id, label: `${"— ".repeat(depth)}${folder.name}` });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}

/** Moves a file or folder into another folder of the same Space. */
export function MoveDialog({
  target,
  open,
  onOpenChange,
}: {
  target: MoveTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const tree = useQuery({
    ...queries.files.folderTree.queryOptions({ input: undefined }),
    enabled: open,
  });
  const [parentId, setParentId] = useState<string>(ROOT);
  const options = useMemo(
    () =>
      destinationOptions(
        tree.data?.folders ?? [],
        target?.kind === "folder" ? target.id : null,
        t`Files`,
      ),
    [tree.data?.folders, target, t],
  );

  useEffect(() => {
    if (!open) return;
    const initial = target?.parentId ?? ROOT;
    setParentId(options.some((option) => option.value === initial) ? initial : ROOT);
  }, [open, target, options]);

  const move = useSave({
    save: async (destination: string, rpc) => {
      const folderId = destination === ROOT ? null : destination;
      if (!target) return;
      if (target.kind === "folder")
        await rpc.files.moveFolder({ folderId: target.id, parentId: folderId });
      else await rpc.files.move({ fileId: target.id, folderId });
    },
    stale: [queries.files.list.key(), queries.files.folderTree.key()],
    onSaved: () => onOpenChange(false),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!move.pending) onOpenChange(next);
      }}
    >
      <DialogContent className="w-[min(420px,94vw)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t`Move ${target?.name ?? ""}`}</DialogTitle>
        </DialogHeader>
        <OptionSelect
          aria-label={t`Destination folder`}
          value={parentId}
          onValueChange={setParentId}
          options={options}
          disabled={tree.isLoading || move.pending}
        />
        {move.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(move.error, t`Could not move this item.`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={move.pending} onClick={() => onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button disabled={move.pending || !target} onClick={() => move.run(parentId)}>
            {move.pending ? t`Moving…` : t`Move`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
