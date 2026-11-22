import { i18n } from "@lingui/core";
import { t as translate } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { artifactPreviewKind, isAttachmentAudioMimeType } from "@rakazo/contracts";
import { fileSizeParts } from "@rakazo/core";
import {
  Button,
  CopyTextFallback,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Spinner,
} from "@rakazo/ui-web";
import { Check, Code2, Copy, Download, FileText, Play, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { fileContentUrl } from "../../lib/files/file-client";
import {
  downloadArtifact,
  fetchArtifactBytes,
  TEXT_PREVIEW_MAX_BYTES,
} from "../../lib/pages/artifact-open";
import { selectFilePreviewContents } from "../../lib/pages/file-preview-selection";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";
import { IconTooltip } from "../IconTooltip";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

type ArtifactFileCardProps = {
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
};

function isTextPreview(mimeType: string) {
  const kind = artifactPreviewKind(mimeType);
  return kind === "markdown" || kind === "html" || kind === "text";
}

function isPreviewable(mimeType: string) {
  return (
    isTextPreview(mimeType) ||
    artifactPreviewKind(mimeType) === "pdf" ||
    artifactPreviewKind(mimeType) === "video"
  );
}

export function ArtifactFileCard(props: ArtifactFileCardProps) {
  const { t } = useLingui();
  const previewable = isPreviewable(props.mimeType);
  const previewButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (isAttachmentAudioMimeType(props.mimeType)) {
    return <AudioArtifactPreview key={props.artifactId} {...props} />;
  }

  if (!previewable) {
    return (
      <button
        type="button"
        onClick={() => downloadArtifact(props.artifactId, props.name)}
        className="rounded-2xl bg-card px-4 py-3 text-start text-body text-foreground hover:bg-accent"
      >
        <div className="font-medium">{props.name}</div>
        <div className="mt-1 flex gap-2 text-muted-foreground">
          <span>{props.mimeType}</span>
          <span>{formatSize(props.size)}</span>
        </div>
      </button>
    );
  }

  return (
    <>
      <BuiCard className="flex min-w-[280px] overflow-hidden text-start text-foreground">
        <button
          ref={previewButton}
          type="button"
          aria-label={t`Preview ${props.name}`}
          onClick={() => setPreviewOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-start hover:bg-accent"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-muted text-foreground">
            {props.mimeType === "text/html" ? (
              <Code2 size={21} strokeWidth={1.8} />
            ) : (
              <FileText size={21} strokeWidth={1.8} />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body font-medium">{props.name}</span>
            <span className="mt-0.5 block text-body-sm text-muted-foreground">
              {formatSize(props.size)}
            </span>
          </span>
        </button>
        <IconTooltip label={t`Download ${props.name}`}>
          <button
            type="button"
            aria-label={t`Download ${props.name}`}
            onClick={() => downloadArtifact(props.artifactId, props.name)}
            className="grid w-14 shrink-0 place-items-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Download size={19} strokeWidth={1.8} />
          </button>
        </IconTooltip>
      </BuiCard>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          onKeyDown={(event) =>
            selectFilePreviewContents(
              event,
              event.currentTarget.querySelector("[data-file-preview-body]"),
            )
          }
          showCloseButton={false}
          initialFocus={closeButton}
          finalFocus={previewButton}
          className="flex h-[min(88vh,900px)] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <FilePreview {...props} closeButtonRef={closeButton} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilePreview({
  artifactId,
  name,
  mimeType,
  closeButtonRef,
}: ArtifactFileCardProps & { closeButtonRef: RefObject<HTMLButtonElement | null> }) {
  const { t } = useLingui();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; text?: string; truncated?: boolean }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const [copied, copy, copyFailed, resetCopy, copyFailedText] = useCopyText();

  useEffect(() => {
    if (!isTextPreview(mimeType)) {
      setState({ status: "ready" });
      return;
    }
    const controller = new AbortController();
    void fetchArtifactBytes(artifactId, {
      maxBytes: TEXT_PREVIEW_MAX_BYTES,
      signal: controller.signal,
    })
      .then((bytes) => {
        setState({
          status: "ready",
          text: new TextDecoder("utf-8").decode(bytes),
          truncated: bytes.length >= TEXT_PREVIEW_MAX_BYTES,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: errorText(error, t`Could not load this file.`),
        });
      });
    return () => controller.abort();
  }, [artifactId, mimeType, t]);
  const kind = artifactPreviewKind(mimeType);
  const src = fileContentUrl(artifactId);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-5">
        <DialogTitle className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
          {name}
        </DialogTitle>
        {state.status === "ready" &&
        state.text !== undefined &&
        (kind === "markdown" || kind === "text") ? (
          <IconTooltip label={copied ? t`Copied` : t`Copy ${name}`}>
            <Button
              variant="ghost"
              size="icon-lg"
              className="rounded-full text-muted-foreground"
              aria-label={copied ? t`Copied` : t`Copy ${name}`}
              onClick={() => void copy(state.text!)}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </IconTooltip>
        ) : null}
        <CopyTextFallback
          open={copyFailed}
          onOpenChange={resetCopy}
          text={copyFailedText}
          label={t`Copy ${name}`}
        />
        <IconTooltip label={t`Download ${name}`}>
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-full text-muted-foreground"
            aria-label={t`Download ${name}`}
            onClick={() => downloadArtifact(artifactId, name)}
          >
            <Download />
          </Button>
        </IconTooltip>
        <DialogClose
          ref={closeButtonRef}
          aria-label={t`Close preview`}
          render={
            <Button variant="ghost" size="icon-lg" className="rounded-full text-muted-foreground" />
          }
        >
          <X />
        </DialogClose>
      </header>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Spinner aria-label={t`Loading preview…`} />
          </div>
        ) : state.status === "error" ? (
          <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
            {state.message}
          </div>
        ) : kind === "html" && state.text !== undefined ? (
          <SandboxedHtmlViewer html={state.text} title={name} />
        ) : kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: Attachment playback has no caption track supplied by the author.
          <video
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
            className="h-full w-full object-contain"
          />
        ) : kind === "pdf" ? (
          <iframe title={name} src={src} className="h-full w-full border-0" />
        ) : state.text !== undefined && kind === "text" ? (
          <pre
            data-file-preview-body
            className="px-8 py-10 font-mono text-body-sm leading-6 whitespace-pre-wrap break-words text-foreground sm:px-12 sm:py-12"
          >
            {state.text}
          </pre>
        ) : state.text !== undefined ? (
          <article
            data-file-preview-body
            className="mx-auto w-full max-w-[760px] px-8 py-10 text-body-lg leading-7 text-foreground sm:px-12 sm:py-12"
          >
            <ChatMarkdown>{state.text}</ChatMarkdown>
          </article>
        ) : null}
        {state.status === "ready" && state.truncated ? (
          <p className="border-t border-border px-8 py-3 text-body-sm text-muted-foreground">
            {t`Showing the first ${formatSize(TEXT_PREVIEW_MAX_BYTES)}.`}
          </p>
        ) : null}
      </div>
    </>
  );
}

function AudioArtifactPreview({ artifactId, name }: ArtifactFileCardProps) {
  const { t } = useLingui();
  const [playing, setPlaying] = useState(false);

  return (
    <BuiCard className="min-w-[280px] p-4 text-foreground">
      <div className="flex items-center gap-3">
        {!playing ? (
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={t`Play ${name}`}
            onClick={() => setPlaying(true)}
          >
            <Play />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-body font-medium">{name}</span>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t`Download ${name}`}
          onClick={() => downloadArtifact(artifactId, name)}
          className="text-muted-foreground"
        >
          <Download strokeWidth={1.8} className="size-[19px]" />
        </Button>
      </div>
      {playing ? (
        // biome-ignore lint/a11y/useMediaCaption: Attachment playback has no caption track supplied by the author.
        <audio
          src={fileContentUrl(artifactId)}
          controls
          preload="metadata"
          aria-label={name}
          className="mt-3 w-full"
        />
      ) : null}
    </BuiCard>
  );
}

export function VideoPreview({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/mp4" }));
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes]);
  return (
    // biome-ignore lint/a11y/useMediaCaption: Attachment playback has no caption track supplied by the author.
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      aria-label={name}
      className="h-full w-full object-contain"
    />
  );
}

function formatSize(bytes: number): string {
  const parts = fileSizeParts(bytes, i18n.locale || "en");
  if (!parts) return "";
  const size = parts.amount;
  switch (parts.unit) {
    case "B":
      return translate`${size} B`;
    case "KB":
      return translate`${parts.amount} KB`;
    case "MB":
      return translate`${parts.amount} MB`;
    case "GB":
      return translate`${parts.amount} GB`;
    case "TB":
      return translate`${parts.amount} TB`;
  }
}
