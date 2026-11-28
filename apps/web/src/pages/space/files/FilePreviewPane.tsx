import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { artifactPreviewKind, isAttachmentAudioMimeType } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import { Button, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { SandboxedHtmlViewer } from "../../../components/messages/SandboxedHtmlViewer";
import { fileContentUrl } from "../../../lib/files/file-client";
import {
  downloadArtifact,
  fetchArtifactBytes,
  TEXT_PREVIEW_MAX_BYTES,
} from "../../../lib/pages/artifact-open";
import { selectFilePreviewContents } from "../../../lib/pages/file-preview-selection";
import { useSpaceQueries } from "../../../lib/query/query";
import { errorDetails, errorText } from "../../../lib/query/user-error";

type TextState =
  | { status: "loading" }
  | { status: "ready"; text: string; truncated: boolean }
  | { status: "error"; message: string };

/** One file's metadata and preview, streaming media from the content URL. */
export function FilePreviewPane({ artifactId, backTo }: { artifactId: string; backTo: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const fileQuery = useQuery(queries.files.get.queryOptions({ input: { fileId: artifactId } }));
  const file = fileQuery.data;
  const kind = file ? artifactPreviewKind(file.mimeType) : "none";
  const textPreview = kind === "html" || kind === "markdown" || kind === "text";
  const [textState, setTextState] = useState<TextState>({ status: "loading" });

  useEffect(() => {
    if (!file || !textPreview) return;
    const controller = new AbortController();
    setTextState({ status: "loading" });
    void fetchArtifactBytes(artifactId, {
      maxBytes: TEXT_PREVIEW_MAX_BYTES,
      signal: controller.signal,
    })
      .then((bytes) =>
        setTextState({
          status: "ready",
          text: new TextDecoder("utf-8").decode(bytes),
          truncated: bytes.length >= TEXT_PREVIEW_MAX_BYTES,
        }),
      )
      .catch((error) => {
        if (controller.signal.aborted) return;
        setTextState({ status: "error", message: errorText(error, t`Could not load this file.`) });
      });
    return () => controller.abort();
  }, [artifactId, file, textPreview, t]);

  const contentUrl = fileContentUrl(artifactId);
  return (
    <section
      aria-label={file?.name ?? t`Preview`}
      onKeyDown={(event) =>
        selectFilePreviewContents(
          event,
          event.currentTarget.querySelector("[data-file-preview-body]"),
        )
      }
      className="flex min-w-0 flex-1 flex-col border-s border-border"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link
          to={backTo}
          aria-label={t`Close preview`}
          className="text-muted-foreground hover:text-foreground"
        >
          <X size={17} strokeWidth={1.9} />
        </Link>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body font-medium">{file?.name ?? null}</h2>
          {file ? (
            <div className="flex flex-col gap-0.5">
              <p className="flex flex-wrap gap-2 truncate text-label text-muted-foreground">
                <span>{file.mimeType}</span>
                <span>{formatFileSize(file.size)}</span>
                {file.slug ? <span className="font-mono">{file.slug}</span> : null}
              </p>
              {file.description ? (
                <p className="truncate text-body-sm text-muted-foreground">{file.description}</p>
              ) : null}
            </div>
          ) : null}
        </div>
        {file ? (
          <Button variant="outline" size="sm" onClick={() => downloadArtifact(file.id, file.name)}>
            <Download className="me-1.5" size={15} strokeWidth={1.9} />
            {t`Download`}
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {fileQuery.isError ? (
          <div className="p-5">
            <ErrorNotice
              error={errorDetails(fileQuery.error, t`Could not load this file.`)}
              onRetry={() => fileQuery.refetch()}
            />
          </div>
        ) : !file ? (
          <div className="grid h-full place-items-center text-muted-foreground">
            <Spinner aria-label={t`Loading…`} />
          </div>
        ) : kind === "image" ? (
          <div className="grid h-full place-items-center bg-muted/40 p-4">
            <img
              src={contentUrl}
              alt={file.name}
              className="max-h-full max-w-full rounded-lg shadow-sm"
            />
          </div>
        ) : kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: A Drive video has no caption track supplied by the author.
          <video
            src={contentUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={file.name}
            className="h-full w-full object-contain"
          />
        ) : isAttachmentAudioMimeType(file.mimeType) ? (
          // biome-ignore lint/a11y/useMediaCaption: A Drive audio file has no caption track supplied by the author.
          <audio
            src={contentUrl}
            controls
            preload="metadata"
            aria-label={file.name}
            className="p-4"
          />
        ) : kind === "pdf" ? (
          <iframe title={file.name} src={contentUrl} className="h-full w-full border-0" />
        ) : kind === "none" ? (
          <p className="p-6 text-body text-muted-foreground">
            {t`Preview isn't available for this file type — download it to view it.`}
          </p>
        ) : textState.status === "loading" ? (
          <div className="grid h-full place-items-center text-muted-foreground">
            <Spinner aria-label={t`Loading…`} />
          </div>
        ) : textState.status === "error" ? (
          <p className="p-5 text-destructive">{textState.message}</p>
        ) : kind === "html" ? (
          <SandboxedHtmlViewer html={textState.text} title={file.name} />
        ) : kind === "markdown" ? (
          <article
            data-file-preview-body
            className="mx-auto w-full max-w-[760px] px-8 py-10 text-body-lg leading-7 text-foreground"
          >
            <ChatMarkdown>{textState.text}</ChatMarkdown>
          </article>
        ) : (
          <pre
            data-file-preview-body
            className="px-8 py-10 font-mono text-body-sm leading-6 whitespace-pre-wrap break-words text-foreground"
          >
            {textState.text}
          </pre>
        )}
        {textState.status === "ready" && textState.truncated ? (
          <p className="border-t border-border px-8 py-3 text-body-sm text-muted-foreground">
            {t`Showing the first ${formatFileSize(TEXT_PREVIEW_MAX_BYTES)}.`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
