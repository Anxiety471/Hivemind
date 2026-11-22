import { useLingui } from "@lingui/react/macro";
import type { DriveFile } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ListSearchInput,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../../../lib/query/query";

/** Picks one file already in the Space Drive for the composer to send by id. */
export function DriveFilePickerDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (file: DriveFile) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [query, setQuery] = useState("");
  const listing = useQuery(
    queries.files.list.queryOptions({
      input: {
        allFolders: true,
        ...(query.trim() ? { query: query.trim() } : {}),
        limit: 100,
      },
    }),
  );
  const files = listing.data?.files ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="w-[min(520px,94vw)] sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t`Choose from Files`}</DialogTitle>
        </DialogHeader>
        <ListSearchInput
          query={query}
          setQuery={setQuery}
          label={t`Search files`}
          placeholder={t`Search files…`}
        />
        <div className="max-h-[min(52vh,420px)] min-h-24 overflow-y-auto">
          {files === null ? (
            <div className="grid place-items-center py-10 text-muted-foreground">
              {listing.isError ? (
                <Button variant="outline" size="sm" onClick={() => void listing.refetch()}>
                  {t`Try again`}
                </Button>
              ) : (
                <Spinner aria-label={t`Loading…`} />
              )}
            </div>
          ) : files.length === 0 ? (
            <p className="py-10 text-center text-body-sm text-muted-foreground">{t`No files`}</p>
          ) : (
            files.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() => {
                  onPick(file);
                  onClose();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-body hover:bg-accent"
              >
                <FileText size={15} strokeWidth={1.8} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="shrink-0 text-label text-muted-foreground">
                  {formatFileSize(file.size)}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
