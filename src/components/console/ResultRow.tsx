import { memo, useRef } from "react";
import { flexRender, type Row as TanRow } from "@tanstack/react-table";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import type { Column } from "@/datasource/types";
import { cn } from "@/lib/utils";
import { ResultCell } from "@/components/console/ResultCell";
import { isNumericColumn } from "@/components/console/formatCell";
import {
  rowToJson,
  rowToTsv,
  serializeValue,
} from "@/components/console/resultExport";
import { useDisplayPrefs } from "@/state/displayPrefs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

type RowData = unknown[];

/** Width of the leading row-number / selection gutter column, shared with
 *  ResultGrid (which renders the matching header cell and includes it in the
 *  grid's total width). Defined here to keep the import edge one-directional
 *  (ResultGrid → ResultRow). */
export const INDEX_COL_WIDTH = 52;

interface ResultRowProps {
  row: TanRow<RowData>;
  columns: Column[];
  totalWidth: number;
  translateY: number;
  zebra: boolean;
  /** 0-based position in the current (sorted/filtered) row model; shown as
   *  `rowIndex + 1` in the gutter. */
  rowIndex: number;
  selected: boolean;
  onIndexMouseDown: (pos: number, e: React.MouseEvent) => void;
  onIndexMouseEnter: (pos: number) => void;
}

function previewValue(s: string): string {
  if (s === "") return "";
  if (s.length > 30) return `${s.slice(0, 30)}…`;
  return s;
}

/**
 * One row of the result grid, wrapped in a *single* ContextMenu that
 * dispatches to whichever cell received the right-click. Previously each
 * cell had its own Radix ContextMenu — at ~25 visible rows × ~15 cols
 * that meant ~375 ContextMenu Roots mounted at once, with every scroll
 * tick triggering mount/unmount cycles of ~15 Roots per row moved. Per-
 * row consolidation drops that by 15× and most of the lifecycle cost
 * with it. Memoized so unrelated state changes (sort, filter, distant
 * column resize) don't re-render rows whose data didn't move.
 */
function ResultRowImpl({
  row,
  columns,
  totalWidth,
  translateY,
  zebra,
  rowIndex,
  selected,
  onIndexMouseDown,
  onIndexMouseEnter,
}: ResultRowProps) {
  const { t } = useTranslation("result");
  const tz = useDisplayPrefs((s) => s.tz);
  // Which column the user right-clicked. Tracked via a ref because we
  // only need it at menu-open time — putting it in state would force a
  // re-render on every right-click and undo the memoization gains.
  const activeColRef = useRef<number | null>(null);

  const original = row.original;

  function copyWithToast(text: string, successLabel: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(successLabel))
      .catch(() => toast.error(t("toast.failed-to-copy")));
  }

  function handleCopyValue() {
    const idx = activeColRef.current;
    if (idx == null) return;
    const col = columns[idx];
    if (!col) return;
    const text = serializeValue(original[idx], col, tz);
    const preview = previewValue(text);
    const label =
      preview === ""
        ? t("toast.copied-empty")
        : t("toast.copied-quoted", { value: preview });
    copyWithToast(text, label);
  }

  function handleCopyTsv() {
    copyWithToast(rowToTsv(original, columns, tz), t("toast.copied-row"));
  }

  function handleCopyJson() {
    copyWithToast(rowToJson(original, columns, tz), t("toast.copied-row-json"));
  }

  function handleCopyColumnName() {
    const idx = activeColRef.current;
    if (idx == null) return;
    const col = columns[idx];
    if (!col) return;
    copyWithToast(col.name, t("toast.copied-quoted", { value: col.name }));
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          className={cn(
            "border-border/50 border-b hover:bg-muted/30",
            zebra && "bg-foreground/[0.03]",
            selected && "bg-primary/10 hover:bg-primary/15",
          )}
          style={{
            display: "flex",
            position: "absolute",
            top: 0,
            left: 0,
            transform: `translateY(${translateY}px)`,
            height: 28,
            width: totalWidth,
          }}
        >
          <td
            onMouseDown={(e) => onIndexMouseDown(rowIndex, e)}
            onMouseEnter={() => onIndexMouseEnter(rowIndex)}
            title={t("selection.toggle-row")}
            className={cn(
              "border-border/30 text-muted-foreground/70 flex shrink-0 cursor-pointer items-center justify-center border-r text-[11px] tabular-nums select-none",
              selected && "bg-primary/25 text-foreground font-medium",
            )}
            style={{ width: INDEX_COL_WIDTH }}
          >
            {rowIndex + 1}
          </td>
          {row.getVisibleCells().map((cell, idx) => {
            const col = columns[idx];
            const numeric = col ? isNumericColumn(col) : false;
            return (
              <ResultCell
                key={cell.id}
                content={flexRender(
                  cell.column.columnDef.cell,
                  cell.getContext(),
                )}
                col={col}
                width={cell.column.getSize()}
                numeric={numeric}
                colIndex={idx}
                onContextMenuCapture={(i) => {
                  activeColRef.current = i;
                }}
              />
            );
          })}
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopyValue}>
          {t("context-menu.copy-value")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyTsv}>
          {t("context-menu.copy-row-tsv")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyJson}>
          {t("context-menu.copy-row-json")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleCopyColumnName}>
          {t("context-menu.copy-column-name")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const ResultRow = memo(ResultRowImpl);
