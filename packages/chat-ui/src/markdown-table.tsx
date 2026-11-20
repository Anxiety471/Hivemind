import {
  CopyTextFallback,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  useCopyText,
} from "@rakazo/ui-web";
import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { useMarkdownCopy } from "./markdown-copy";
import type { ExtractedTable, HastNode, TableAlign, TableSortDirection } from "./table-utils";
import {
  clampZoom,
  columnSortLabel,
  extractTable,
  nextSort,
  sortRows,
  stepZoom,
  TABLE_PAGE_SIZE,
  TABLE_ZOOM_MAX,
  TABLE_ZOOM_MIN,
  tableToCsv,
  tableToTsv,
} from "./table-utils";

/** The markdown source a render was parsed from — lets a reparsed-but-
    unchanged table reuse its extraction by content instead of node identity. */
export const MarkdownTableSourceContext = createContext("");

/**
 * Extracted plain text drives sorting and export while sanitized React children preserve
 * inline markup. Invalid tables fall back to the default <table>.
 */
export const MarkdownTable = memo(function MarkdownTable({
  node,
  tableProps,
  children,
}: {
  node?: HastNode;
  tableProps?: ComponentPropsWithoutRef<"table">;
  children?: ReactNode;
}) {
  const source = useContext(MarkdownTableSourceContext);
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  const sourceKey =
    typeof start === "number" && typeof end === "number" && start <= end && end <= source.length
      ? source.slice(start, end)
      : null;
  // sourceKey pins the extraction to the source text; node identity is only
  // the fallback when the parser supplies no position.
  const extracted = useMemo(() => extractTable(node), [sourceKey ?? node]);
  const rendered = useMemo(() => extractRenderedCells(children), [children]);
  if (!extracted) return <table {...tableProps}>{children}</table>;
  return (
    <TableCard table={extracted} renderedHeaders={rendered.headers} renderedRows={rendered.rows} />
  );
});

type SortState = { column: number; direction: TableSortDirection } | null;

export const TableCard = memo(function TableCard({
  table,
  renderedHeaders,
  renderedRows,
}: {
  table: ExtractedTable;
  renderedHeaders?: ReactNode[];
  renderedRows?: ReactNode[][];
}) {
  const { columns, aligns, rows, schemaKey, dataSignature, numericColumns, minWidths, rowKeys } =
    table;
  const copy = useMarkdownCopy();
  const [copiedNow, copyText, copyFailed, resetCopy, copyFailedText] = useCopyText();
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // Expanded view only: a scale on the table's base size, reset each time it opens.
  const [zoom, setZoom] = useState(1);
  // The data the copy was taken from: the check mark drops once the rows change.
  const [copiedSignature, setCopiedSignature] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const announceTimer = useRef<number | undefined>(undefined);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogScrollRef = useRef<HTMLElement | null>(null);

  const copied = copiedNow && copiedSignature === dataSignature;

  const renderedRowsBySource = useMemo(
    () => new Map(rows.map((row, index) => [row, renderedRows?.[index]])),
    [renderedRows, rows],
  );
  const sortedRows = useMemo(
    () => (sort ? sortRows(rows, sort.column, sort.direction) : rows),
    [rows, sort],
  );

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / TABLE_PAGE_SIZE));
  const showPagination = sortedRows.length > TABLE_PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = showPagination
    ? sortedRows.slice(safePage * TABLE_PAGE_SIZE, (safePage + 1) * TABLE_PAGE_SIZE)
    : sortedRows;

  // Data and sort changes only clamp the page; an explicit sort click resets
  // to page 0 in the handler so the two coalesce into one commit.
  useEffect(() => setPage((p) => Math.min(p, pageCount - 1)), [pageCount]);
  useEffect(() => {
    setSort(null);
    setPage(0);
    setExpanded(false);
  }, [schemaKey]);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Clear then restore so identical successive strings still fire a live-region update.
  const announce = (text: string) => {
    window.clearTimeout(announceTimer.current);
    setAnnouncement("");
    announceTimer.current = window.setTimeout(() => setAnnouncement(text), 0);
  };

  const toggleSort = (column: number) => {
    const next = nextSort(sort, column);
    setSort(next);
    setPage(0);
    announce(
      next
        ? copy.sortedBy(columnSortLabel(columns, column, copy), next.direction)
        : copy.sortCleared,
    );
  };

  const copyRows = () => {
    const signature = dataSignature;
    void copyText(tableToTsv(columns, sortedRows)).then((ok) => {
      if (!ok) return;
      setCopiedSignature(signature);
      announce(copy.copied);
    });
  };

  const downloadCsv = () => {
    // BOM so spreadsheet apps decode UTF-8 correctly.
    const blob = new Blob([`\uFEFF${tableToCsv(columns, sortedRows)}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "table.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const openChange = (open: boolean) => {
    if (open) setZoom(1);
    setExpanded(open);
  };

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way) zooms
  // the table instead of the page. React's onWheel is passive, so it can't cancel.
  const attachDialogScroll = useCallback((element: HTMLElement | null) => {
    dialogScrollRef.current = element;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const pixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const delta = Math.max(-50, Math.min(50, pixels));
      setZoom((current) => clampZoom(current * Math.exp(-delta * 0.004)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      dialogScrollRef.current = null;
    };
  }, []);

  // Shrinks a table wider than the view until it fits; never enlarges past 100%.
  const fitWidth = () => {
    const scroll = dialogScrollRef.current;
    const table = scroll?.querySelector("table");
    if (!scroll || !table) return;
    const style = getComputedStyle(scroll);
    const available =
      scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const natural = table.offsetWidth / zoom;
    if (natural <= 0) return;
    setZoom(clampZoom(Math.min(1, Math.floor((available / natural) * 100) / 100)));
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") setZoom((current) => stepZoom(current, 1));
    else if (event.key === "-" || event.key === "_") setZoom((current) => stepZoom(current, -1));
    else if (event.key === "0") setZoom(1);
    else return;
    event.preventDefault();
  };

  const tableView = (mode: "card" | "dialog") => (
    <TableView
      columns={columns}
      aligns={aligns}
      // The expanded view is the full view: every row, no pages.
      rows={mode === "dialog" ? sortedRows : pageRows}
      rowOffset={mode === "dialog" ? 0 : safePage * TABLE_PAGE_SIZE}
      numericColumns={numericColumns}
      minWidths={minWidths}
      renderedHeaders={renderedHeaders}
      renderedRows={renderedRowsBySource}
      rowKeys={rowKeys}
      expanded={mode === "dialog"}
      sort={sort}
      onToggleSort={toggleSort}
    />
  );

  const pager = showPagination ? (
    <div className="rk-table-footer">
      <span className="rk-table-range">
        {copy.rowRange(
          safePage * TABLE_PAGE_SIZE + 1,
          Math.min((safePage + 1) * TABLE_PAGE_SIZE, sortedRows.length),
          sortedRows.length,
        )}
      </span>
      <button
        type="button"
        className="rk-table-tool"
        aria-label={copy.previousPage}
        disabled={safePage === 0}
        onClick={() => {
          setPage(safePage - 1);
          announce(copy.pageOf(safePage, pageCount));
        }}
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        className="rk-table-tool"
        aria-label={copy.nextPage}
        disabled={safePage >= pageCount - 1}
        onClick={() => {
          setPage(safePage + 1);
          announce(copy.pageOf(safePage + 2, pageCount));
        }}
      >
        <ChevronRightIcon />
      </button>
    </div>
  ) : (
    <div className="rk-table-footer">
      <span className="rk-table-range">{copy.rowCount(sortedRows.length)}</span>
    </div>
  );

  const zoomPercent = Math.round(zoom * 100);
  const zoomLabel = `${zoomPercent}%`;
  const zoomControls = (
    <div className="rk-table-zoom">
      <button
        type="button"
        className="rk-table-tool"
        onClick={() => setZoom((current) => stepZoom(current, -1))}
        disabled={zoom <= TABLE_ZOOM_MIN + 0.001}
        aria-label={copy.zoomOut}
        aria-keyshortcuts="-"
      >
        <ZoomOutIcon />
      </button>
      <button
        type="button"
        className="rk-table-tool rk-table-zoom-level"
        onClick={() => setZoom(1)}
        aria-label={copy.resetZoom(zoomPercent)}
        aria-keyshortcuts="0"
      >
        {zoomLabel}
      </button>
      <button
        type="button"
        className="rk-table-tool"
        onClick={() => setZoom((current) => stepZoom(current, 1))}
        disabled={zoom >= TABLE_ZOOM_MAX - 0.001}
        aria-label={copy.zoomIn}
        aria-keyshortcuts="+"
      >
        <ZoomInIcon />
      </button>
      <button type="button" className="rk-table-tool" onClick={fitWidth} aria-label={copy.fitWidth}>
        <FitWidthIcon />
      </button>
    </div>
  );

  const tools = (mode: "card" | "dialog") => (
    <div className="rk-table-head">
      {mode === "dialog" ? zoomControls : null}
      <button
        type="button"
        className="rk-table-tool"
        onClick={copyRows}
        aria-label={copied ? copy.copied : copy.copyRows}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        type="button"
        className="rk-table-tool"
        onClick={downloadCsv}
        aria-label={copy.downloadCsv}
      >
        <DownloadIcon />
      </button>
      {mode === "card" ? (
        <button
          type="button"
          className="rk-table-tool"
          ref={expandButtonRef}
          onClick={() => openChange(true)}
          aria-label={copy.expandTable}
        >
          <ExpandIcon />
        </button>
      ) : (
        <DialogClose
          ref={closeButtonRef}
          aria-label={copy.closeTable}
          render={<button type="button" className="rk-table-tool" />}
        >
          <CloseIcon />
        </DialogClose>
      )}
    </div>
  );

  const status = (
    <div role="status" className="rk-sr-only">
      {announcement}
    </div>
  );

  return (
    <Dialog open={expanded} onOpenChange={openChange}>
      <CopyTextFallback
        open={copyFailed}
        onOpenChange={resetCopy}
        text={copyFailedText}
        label={copy.copyRows}
      />
      <div className="rk-table-card rk-table-box" data-testid="table-card">
        {/* Keep the live region in the active view — dialog content is outside the card. */}
        {expanded ? null : status}
        {tools("card")}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must
            be keyboard-focusable (WCAG 2.1.1 / axe scrollable-region-focusable). */}
        <section className="rk-table-scroll" aria-label={copy.table} tabIndex={0}>
          {tableView("card")}
        </section>
        {pager}
      </div>
      <DialogContent
        showCloseButton={false}
        initialFocus={closeButtonRef}
        finalFocus={expandButtonRef}
        onKeyDown={onDialogKeyDown}
        className="rk-table-dialog rk-table-box rk-chat-markdown"
      >
        <DialogTitle className="rk-table-dialog-title">{copy.table}</DialogTitle>
        {expanded ? status : null}
        {tools("dialog")}
        {/* biome-ignore-start lint/a11y/noNoninteractiveTabindex: a scrollable region must
            be keyboard-focusable (WCAG 2.1.1 / axe scrollable-region-focusable). */}
        <section
          ref={attachDialogScroll}
          className="rk-table-scroll rk-table-dialog-scroll"
          aria-label={copy.table}
          tabIndex={0}
          style={{ "--rk-table-zoom": zoom } as CSSProperties}
        >
          {tableView("dialog")}
        </section>
        {/* biome-ignore-end lint/a11y/noNoninteractiveTabindex: end of scrollable region. */}
        <div className="rk-table-footer">
          <span className="rk-table-range">{copy.rowCount(sortedRows.length)}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
});

function TableView({
  columns,
  aligns,
  rows,
  rowOffset,
  numericColumns,
  minWidths,
  renderedHeaders,
  renderedRows,
  rowKeys,
  expanded,
  sort,
  onToggleSort,
}: {
  columns: string[];
  aligns: TableAlign[];
  rows: string[][];
  rowOffset: number;
  numericColumns: ReadonlySet<number>;
  minWidths: Record<number, string>;
  renderedHeaders?: ReactNode[];
  renderedRows: Map<string[], ReactNode[] | undefined>;
  rowKeys: Map<string[], string>;
  expanded: boolean;
  sort: SortState;
  onToggleSort: (column: number) => void;
}) {
  const copy = useMarkdownCopy();
  // Numeric columns right-align unless the author declared an alignment.
  const alignClass = (index: number) => {
    const align = aligns[index] ?? (numericColumns.has(index) ? "right" : "left");
    return align && align !== "left" ? `rk-align-${align}` : undefined;
  };
  // Sort labels need disambiguation: empty headers and duplicate names would
  // otherwise produce identical or blank "Sort by" announcements.
  const sortLabel = (index: number) => columnSortLabel(columns, index, copy);
  return (
    <table className="rk-table" aria-label={copy.markdownTable}>
      <thead>
        <tr>
          <th className="rk-table-gutter" scope="col" aria-label={copy.row} />
          {columns.map((column, i) => (
            <SortableColumnHeader
              key={i}
              column={sortLabel(i)}
              content={renderedHeaders?.[i] ?? column}
              direction={sort?.column === i ? sort.direction : null}
              className={alignClass(i)}
              onToggleSort={() => onToggleSort(i)}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length + 1} className="rk-table-empty">
              {copy.noRows}
            </td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr key={rowKeys.get(row)}>
              <td className="rk-table-gutter">{rowOffset + rowIndex + 1}</td>
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex] ?? "";
                return (
                  <td
                    key={columnIndex}
                    style={{ minWidth: expanded ? undefined : minWidths[columnIndex] }}
                    className={alignClass(columnIndex)}
                  >
                    <span className="rk-table-cell-text">
                      {renderedRows.get(row)?.[columnIndex] ?? value}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function SortableColumnHeader({
  column,
  content,
  direction,
  className,
  onToggleSort,
}: {
  column: string;
  content: ReactNode;
  direction: TableSortDirection | null;
  className?: string;
  onToggleSort: () => void;
}) {
  const copy = useMarkdownCopy();
  const rich = !isPlainText(content);
  const sortButton = (
    <button
      type="button"
      className={rich ? "rk-table-sort-trigger" : "rk-table-sort"}
      onClick={onToggleSort}
      aria-label={copy.sortBy(column)}
    >
      {rich ? null : <span className="rk-table-sort-label">{content}</span>}
      <SortIndicator direction={direction} />
    </button>
  );
  return (
    <th
      aria-sort={direction ? (direction === "asc" ? "ascending" : "descending") : undefined}
      className={className}
      scope="col"
    >
      {rich ? (
        <div className="rk-table-sort">
          <span className="rk-table-sort-label">{content}</span>
          {sortButton}
        </div>
      ) : (
        sortButton
      )}
    </th>
  );
}

function isPlainText(node: ReactNode): boolean {
  return Children.toArray(node).every(
    (child) => typeof child === "string" || typeof child === "number",
  );
}

type ElementWithChildren = ReactElement<{ children?: ReactNode }>;

function extractRenderedCells(children: ReactNode): {
  headers?: ReactNode[];
  rows?: ReactNode[][];
} {
  const rows: ElementWithChildren[] = [];
  const collect = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<{ children?: ReactNode }>(child)) continue;
      if (child.type === "tr") rows.push(child);
      else collect(child.props.children);
    }
  };
  collect(children);

  const [headerRow, ...bodyRows] = rows;
  const headerTh = headerRow ? cellChildren(headerRow, "th") : [];
  const headerCells =
    headerTh.length > 0 ? headerTh : headerRow ? cellChildren(headerRow, "td") : [];
  const renderedBody = bodyRows.map((row) => {
    const cells = cellChildren(row, "td");
    return cells.length > 0 ? cells : cellChildren(row, "th");
  });
  return {
    headers: headerCells.length > 0 ? headerCells : undefined,
    rows: renderedBody.length > 0 ? renderedBody : undefined,
  };
}

function cellChildren(row: ElementWithChildren, type: "th" | "td"): ReactNode[] {
  return Children.toArray(row.props.children)
    .filter(
      (cell): cell is ElementWithChildren =>
        isValidElement<{ children?: ReactNode }>(cell) && cell.type === type,
    )
    .map((cell) => cell.props.children);
}

function SortIndicator({ direction }: { direction: TableSortDirection | null }) {
  return (
    <span className="rk-table-sort-icon" aria-hidden="true">
      <ChevronUpIcon active={direction === "asc"} />
      <ChevronDownIcon active={direction === "desc"} />
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4v11m0 0 4-4m-4 4-4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 0 2 2h-3M3 16v3a2 2 0 0 0 2 2h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11h6m6 9-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 11h6m-3-3v6m9 6-4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FitWidthIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 4v16m18-16v16M7 12h10M7 12l3-3m-3 3 3 3m7-3-3-3m3 3-3 3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronUpIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? "rk-sort-on" : "rk-sort-off"}
    >
      <path
        d="m6 15 6-6 6 6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? "rk-sort-on" : "rk-sort-off"}
    >
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m14 7-5 5 5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m10 7 5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
