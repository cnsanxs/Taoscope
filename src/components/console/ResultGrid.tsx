import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type FilterFn,
  type SortingFnOption,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Minus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import type { Column, QueryResult } from "@/datasource/types";
import { cn } from "@/lib/utils";
import { useAppState } from "@/store/appState";
import { formatCell } from "@/components/console/formatCell";
import { INDEX_COL_WIDTH, ResultRow } from "@/components/console/ResultRow";
import { columnToText, serializeValue } from "@/components/console/resultExport";
import { useDisplayPrefs } from "@/state/displayPrefs";
import type { TzPref } from "@/state/displayPrefs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const EMPTY_GRID_STATE = {
  sorting: [] as SortingState,
  columnSizing: {} as ColumnSizingState,
};

function resolveUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function"
    ? (updater as (p: T) => T)(prev)
    : updater;
}

type Row = unknown[];

function sortingFnForColumn(col: Column): SortingFnOption<Row> {
  switch (col.type) {
    case "TIMESTAMP":
    case "INT":
    case "BIGINT":
    case "SMALLINT":
    case "TINYINT":
    case "INT UNSIGNED":
    case "BIGINT UNSIGNED":
    case "SMALLINT UNSIGNED":
    case "TINYINT UNSIGNED":
    case "FLOAT":
    case "DOUBLE":
      return (a, b, id) => {
        const av = a.getValue(id) as number | null | undefined;
        const bv = b.getValue(id) as number | null | undefined;
        if (av == null) return bv == null ? 0 : -1;
        if (bv == null) return 1;
        return av - bv;
      };
    case "BOOL":
      return (a, b, id) =>
        Number(!!a.getValue(id)) - Number(!!b.getValue(id));
    default:
      return "text";
  }
}

function estimateInitialSize(col: Column): number {
  const headerWidth = col.name.length * 7 + 60;
  const typeWidth = (() => {
    switch (col.type) {
      case "TIMESTAMP":
        return 200;
      case "BOOL":
        return 80;
      case "TINYINT":
      case "SMALLINT":
        return 80;
      case "INT":
      case "INT UNSIGNED":
        return 100;
      case "BIGINT":
      case "BIGINT UNSIGNED":
        return 140;
      case "FLOAT":
      case "DOUBLE":
        return 120;
      case "BINARY":
      case "NCHAR":
      case "VARCHAR":
        return Math.min(320, (col.length ?? 64) * 4);
      default:
        return 160;
    }
  })();
  return Math.max(80, Math.min(320, Math.max(headerWidth, typeWidth)));
}

function buildColumnDefs(columns: Column[], tz: TzPref): ColumnDef<Row>[] {
  return columns.map((col, idx) => ({
    id: col.name,
    accessorFn: (row: Row) => row[idx],
    header: () => (
      <div className="flex items-center gap-1">
        <span>{col.name}</span>
        <span className="text-muted-foreground/70 ml-1 font-mono">
          {col.type}
          {col.isTag ? " · tag" : ""}
        </span>
      </div>
    ),
    cell: (info) => formatCell(info.getValue(), col, tz),
    sortingFn: sortingFnForColumn(col),
    size: estimateInitialSize(col),
    minSize: 64,
    maxSize: 600,
  }));
}

export function ResultGrid({
  result,
  filterQuery,
  selectedIds,
  setSelectedIds,
}: {
  result: QueryResult;
  filterQuery?: string;
  selectedIds: Set<number>;
  setSelectedIds: Dispatch<SetStateAction<Set<number>>>;
}) {
  const { t } = useTranslation("result");
  const activeId = useAppState((s) => s.activeConsoleId);
  const gridState =
    useAppState((s) =>
      activeId ? s.consoleRuntime[activeId]?.gridState : undefined,
    ) ?? EMPTY_GRID_STATE;
  const setGridState = useAppState((s) => s.setGridState);
  const tz = useDisplayPrefs((s) => s.tz);

  const columns = useMemo(
    () => buildColumnDefs(result.columns, tz),
    [result.columns, tz],
  );

  const globalFilterFn = useMemo<FilterFn<Row>>(
    () => (row, _colId, query) => {
      const q = typeof query === "string" ? query : "";
      if (!q) return true;
      const needle = q.toLowerCase();
      const original = row.original;
      for (let i = 0; i < result.columns.length; i++) {
        const col = result.columns[i];
        if (!col) continue;
        if (serializeValue(original[i], col, tz).toLowerCase().includes(needle)) {
          return true;
        }
      }
      return false;
    },
    [result.columns, tz],
  );

  const table = useReactTable<Row>({
    data: result.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableColumnResizing: true,
    // `onEnd` instead of `onChange`: avoids a zustand write + full-grid
    // re-render on every pixel of column-resize drag. The column header
    // still visibly tracks the drag (TanStack handles that locally); the
    // store / virtualizer only see the final width on mouse-up.
    columnResizeMode: "onEnd",
    globalFilterFn,
    state: {
      sorting: gridState.sorting,
      columnSizing: gridState.columnSizing,
      globalFilter: filterQuery ?? "",
    },
    onSortingChange: (updater) => {
      if (!activeId) return;
      const next = resolveUpdater(updater, gridState.sorting);
      setGridState(activeId, { ...gridState, sorting: next });
    },
    onColumnSizingChange: (updater) => {
      if (!activeId) return;
      const next = resolveUpdater(updater, gridState.columnSizing);
      setGridState(activeId, { ...gridState, columnSizing: next });
    },
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;

  // ── Row selection (gutter column) ──────────────────────────────────────
  // Selection identity is the original data index (`Number(row.id)`), stable
  // across sort/filter. Drag ranges are expressed in *visible* positions and
  // mapped to ids through the current row model. Latest rows/selection are
  // mirrored into refs so the click/drag handlers can stay referentially
  // stable — that keeps the memoized ResultRow from re-rendering every row on
  // each selection change (only rows whose `selected` flag flipped re-render).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const dragRef = useRef<{
    anchor: number;
    paint: boolean;
    base: Set<number>;
  } | null>(null);

  const applyFromBase = useCallback(
    (base: Set<number>, fromPos: number, toPos: number, paint: boolean) => {
      const r = rowsRef.current;
      const lo = Math.min(fromPos, toPos);
      const hi = Math.max(fromPos, toPos);
      const next = new Set(base);
      for (let p = lo; p <= hi; p++) {
        const row = r[p];
        if (!row) continue;
        const id = Number(row.id);
        if (paint) next.add(id);
        else next.delete(id);
      }
      setSelectedIds(next);
    },
    [setSelectedIds],
  );

  const handleIndexMouseDown = useCallback(
    (pos: number, e: React.MouseEvent) => {
      // Left button only; prevent the text-selection that a drag would start.
      if (e.button !== 0) return;
      e.preventDefault();
      const row = rowsRef.current[pos];
      if (!row) return;
      const id = Number(row.id);
      const base = selectedRef.current;
      const paint = !base.has(id);
      dragRef.current = { anchor: pos, paint, base: new Set(base) };
      applyFromBase(dragRef.current.base, pos, pos, paint);
    },
    [applyFromBase],
  );

  const handleIndexMouseEnter = useCallback(
    (pos: number) => {
      const d = dragRef.current;
      if (!d) return;
      applyFromBase(d.base, d.anchor, pos, d.paint);
    },
    [applyFromBase],
  );

  // End the drag on any mouse release, even outside the grid.
  useEffect(() => {
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const visibleIds = rows.map((r) => Number(r.id));
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected =
    !allSelected && visibleIds.some((id) => selectedIds.has(id));

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    // 4 instead of 8: each mounted row spins up a Radix ContextMenu Root;
    // a tighter overscan halves the number of those that exist at any
    // moment without producing visible blank rows during normal scrolling.
    overscan: 4,
  });

  // Grid width includes the fixed selection gutter on top of the data columns.
  const totalWidth = table.getCenterTotalSize() + INDEX_COL_WIDTH;

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <table
        className="border-collapse font-mono text-xs"
        style={{ display: "block", width: totalWidth }}
      >
        <thead
          className="bg-muted sticky top-0 z-10 shadow-[0_2px_5px_-3px_rgba(0,0,0,0.45)]"
          style={{ display: "block" }}
        >
          {table.getHeaderGroups().map((headerGroup) => (
            <tr
              key={headerGroup.id}
              style={{ display: "flex", width: totalWidth }}
            >
              <th
                onClick={toggleSelectAll}
                title={t("selection.select-all")}
                className="bg-muted hover:bg-muted/70 border-border flex shrink-0 cursor-pointer items-center justify-center border-r border-b select-none"
                style={{ width: INDEX_COL_WIDTH }}
              >
                {allSelected ? (
                  <Check className="h-3 w-3" />
                ) : someSelected ? (
                  <Minus className="h-3 w-3" />
                ) : (
                  <span className="text-muted-foreground/50 text-[10px]">
                    #
                  </span>
                )}
              </th>
              {headerGroup.headers.map((header) => {
                const sortDir = header.column.getIsSorted();
                const colIdx = result.columns.findIndex(
                  (c) => c.name === header.column.id,
                );
                const col =
                  colIdx >= 0 ? result.columns[colIdx] : undefined;

                function copyColumnName() {
                  if (!col) return;
                  navigator.clipboard
                    .writeText(col.name)
                    .then(() =>
                      toast.success(
                        t("toast.copied-quoted", { value: col.name }),
                      ),
                    )
                    .catch(() => toast.error(t("toast.failed-to-copy")));
                }

                function copyColumnValues() {
                  if (!col || colIdx < 0) return;
                  const text = columnToText(result.rows, colIdx, col, tz);
                  navigator.clipboard
                    .writeText(text)
                    .then(() =>
                      toast.success(
                        t("toast.copied-values", { n: result.rows.length }),
                      ),
                    )
                    .catch(() => toast.error(t("toast.failed-to-copy")));
                }

                return (
                  <ContextMenu key={header.id}>
                    <ContextMenuTrigger asChild>
                      <th
                        className="bg-muted hover:bg-muted/70 text-foreground border-border relative cursor-pointer border-r border-b px-2 py-1 text-left text-xs font-semibold tracking-wide select-none last:border-r-0"
                        style={{
                          width: header.getSize(),
                          flexShrink: 0,
                        }}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className="flex items-center gap-1">
                          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                          </span>
                          {sortDir === "asc" && (
                            <ChevronUp className="h-3 w-3 shrink-0" />
                          )}
                          {sortDir === "desc" && (
                            <ChevronDown className="h-3 w-3 shrink-0" />
                          )}
                        </div>
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onClick={(e) => e.stopPropagation()}
                          onContextMenu={(e) => e.stopPropagation()}
                          className={cn(
                            "absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none select-none",
                            header.column.getIsResizing()
                              ? "bg-primary"
                              : "hover:bg-primary/40",
                          )}
                        />
                      </th>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => header.column.toggleSorting(false)}
                      >
                        <ArrowUp className="mr-2 h-3 w-3" />
                        {t("context-menu.sort-asc")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => header.column.toggleSorting(true)}
                      >
                        <ArrowDown className="mr-2 h-3 w-3" />
                        {t("context-menu.sort-desc")}
                      </ContextMenuItem>
                      {sortDir !== false && (
                        <ContextMenuItem
                          onSelect={() => header.column.clearSorting()}
                        >
                          <X className="mr-2 h-3 w-3" />
                          {t("context-menu.clear-sort")}
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={copyColumnName}
                        disabled={!col}
                      >
                        {t("context-menu.copy-column-name")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={copyColumnValues}
                        disabled={!col}
                      >
                        {t("context-menu.copy-column-values")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody
          style={{
            display: "block",
            height:
              rows.length === 0 ? undefined : rowVirtualizer.getTotalSize(),
            position: "relative",
            width: totalWidth,
          }}
        >
          {rows.length === 0 && (
            <tr style={{ display: "flex", width: totalWidth }}>
              <td
                className="text-muted-foreground/70 px-3 py-2 text-xs italic"
                style={{ width: totalWidth }}
              >
                {result.rows.length === 0
                  ? t("empty.no-rows")
                  : t("empty.no-rows-filtered")}
              </td>
            </tr>
          )}
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const row = rows[vRow.index];
            if (!row) return null;
            return (
              <ResultRow
                key={row.id}
                row={row}
                columns={result.columns}
                totalWidth={totalWidth}
                translateY={vRow.start}
                zebra={vRow.index % 2 === 1}
                rowIndex={vRow.index}
                selected={selectedIds.has(Number(row.id))}
                onIndexMouseDown={handleIndexMouseDown}
                onIndexMouseEnter={handleIndexMouseEnter}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
