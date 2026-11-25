import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { Button, cn } from "@rakazo/ui-web";
import { TextQuote } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  isDetachedRange,
  lastSelectedText,
  quoteDraftForSelection,
} from "../../../lib/chat/quote-selection";
import { desktopBridge } from "../../../lib/platform/desktop";
import { useEventListener } from "../../../lib/use-event-listener";
import { isApplePlatform, isEditableTarget, quoteShortcutLabel } from "../shell-shortcuts";

export function useTranscriptQuote({
  messages,
  messageById,
  onQuote,
  onQuoteShortcutChange,
  onMouseUp,
}: {
  messages: readonly ThreadMessage[];
  messageById: ReadonlyMap<string, ThreadMessage>;
  onQuote: (message: ThreadMessage, quote: string) => void;
  onQuoteShortcutChange?: (handler: (() => boolean) | null) => void;
  onMouseUp: () => void;
}) {
  const [quoteDraft, setQuoteDraft] = useState<{
    message: ThreadMessage;
    text: string;
    range: Range;
    /** The range's text when armed: a rewrite that removes one endpoint moves it without collapsing. */
    rangeText: string;
  } | null>(null);
  const selectingWithMouse = useRef(false);
  const applyQuote = useCallback(() => {
    const selection = window.getSelection();
    if (
      !quoteDraft ||
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount ||
      isDetachedRange(quoteDraft.range) ||
      quoteDraft.range.toString() !== quoteDraft.rangeText
    ) {
      return false;
    }
    const range = selection.getRangeAt(0);
    if (
      range.compareBoundaryPoints(Range.START_TO_START, quoteDraft.range) !== 0 ||
      range.compareBoundaryPoints(Range.END_TO_END, quoteDraft.range) !== 0
    ) {
      return false;
    }
    onQuote(quoteDraft.message, quoteDraft.text);
    selection.removeAllRanges();
    setQuoteDraft(null);
    return true;
  }, [onQuote, quoteDraft]);

  useLayoutEffect(() => {
    onQuoteShortcutChange?.(
      quoteDraft ? () => !isEditableTarget(document.activeElement) && applyQuote() : null,
    );
    return () => onQuoteShortcutChange?.(null);
  }, [onQuoteShortcutChange, applyQuote, quoteDraft]);

  // A streaming edit can replace the selected nodes without firing selectionchange: replacing
  // both endpoints collapses the range, replacing one moves it; the pill must not keep its
  // stale placement either way.
  useLayoutEffect(() => {
    setQuoteDraft((prev) =>
      prev && (isDetachedRange(prev.range) || prev.range.toString() !== prev.rangeText)
        ? null
        : prev,
    );
  }, [messages]);

  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const contentOf = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-quote-message-id]",
      ) ?? null;
    const startContent = contentOf(range.startContainer);
    const endContent = contentOf(lastSelectedText(range));
    // selection.toString() serializes the whole range (a Ctrl+A transcript is
    // unbounded), so it only runs once both endpoints sit in one message.
    const draft = quoteDraftForSelection(
      {
        startContent,
        endContent,
        text: startContent && startContent === endContent ? selection.toString() : "",
      },
      messageById,
    );
    setQuoteDraft((prev) => {
      if (!draft) return null;
      // Repeat firings for an unchanged selection reuse the draft so the
      // transcript isn't re-rendered by every unrelated selection event. A
      // moved selection (e.g. keyboard-selecting a second occurrence of the
      // same text) must carry its new Range — the pill anchors to it.
      if (
        prev &&
        prev.message === draft.message &&
        prev.text === draft.text &&
        prev.range.compareBoundaryPoints(Range.START_TO_START, range) === 0 &&
        prev.range.compareBoundaryPoints(Range.END_TO_END, range) === 0
      ) {
        return prev;
      }
      return { ...draft, range, rangeText: range.toString() };
    });
  }, [messageById]);

  // Keyboard and assistive-tech selections never reach a mouseup, so the pill
  // lifecycle listens on selectionchange; the mouse flag keeps it hidden while
  // a drag is still in flight.
  useEventListener(
    document,
    "mousedown",
    (event) => {
      selectingWithMouse.current = true;
      if ((event.target as Element | null)?.closest?.("[data-quote-selection]")) return;
      setQuoteDraft(null);
    },
    true,
  );
  useEventListener(
    document,
    "mouseup",
    () => {
      selectingWithMouse.current = false;
      // Clicks and selection drags end here even when released over the composer.
      onMouseUp();
      evaluateSelection();
    },
    true,
  );
  useEventListener(document, "selectionchange", () => {
    if (!selectingWithMouse.current) evaluateSelection();
  });
  useEventListener(document, "keydown", (event) => {
    if (event.key === "Escape") setQuoteDraft(null);
  });
  // A drag that ends outside the window never fires document mouseup; reset
  // the flag on blur so keyboard selections keep working afterwards.
  useEventListener(window, "blur", () => {
    selectingWithMouse.current = false;
  });

  return { quoteDraft, applyQuote };
}

export const QuoteSelectionButton = memo(function QuoteSelectionButton({
  range,
  onQuote,
}: {
  range: Range;
  onQuote: () => void;
}) {
  const { t } = useLingui();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);

  const update = () => {
    if (isDetachedRange(range)) {
      setPlacement(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const width = buttonRef.current?.offsetWidth ?? 0;
    const height = buttonRef.current?.offsetHeight ?? 0;
    const above = rect.top >= height + 8;
    setPlacement({
      top: above ? rect.top - 8 : rect.bottom + 8,
      left: Math.min(
        Math.max(rect.left + rect.width / 2, width / 2 + 8),
        window.innerWidth - width / 2 - 8,
      ),
      above,
    });
  };
  useLayoutEffect(update, [range]);
  useEventListener(window, "resize", update);
  // Scroll doesn't bubble — listen on the capture phase to catch any scroller.
  useEventListener(window, "scroll", update, { capture: true, passive: true });

  return createPortal(
    // The wrapper owns the offset so the button's pressed nudge cannot move it.
    <div
      data-quote-selection
      style={placement ? { top: placement.top, left: placement.left } : { visibility: "hidden" }}
      className={cn(
        "fixed z-50 -translate-x-1/2",
        placement?.above === false ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <Button
        ref={buttonRef}
        variant="floating"
        size="sm"
        data-testid="quote-selection"
        onMouseDown={(event) => {
          // Keep the highlight alive until the click commits the quote.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={onQuote}
        className="px-3 shadow-md"
      >
        <TextQuote strokeWidth={2} />
        {t`Reply`}
        <span className="hidden text-label text-muted-foreground pointer-fine:inline">
          {quoteShortcutLabel({ desktop: Boolean(desktopBridge()), apple: isApplePlatform() })}
        </span>
      </Button>
    </div>,
    document.body,
  );
});
