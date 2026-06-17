import { useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Download, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { QueryResult } from "@/datasource/types";
import { cn } from "@/lib/utils";
import {
  buildFilename,
  serializeValue,
  toCsv,
  toJson,
} from "@/components/console/resultExport";
import { useDisplayPrefs } from "@/state/displayPrefs";

type Feedback = "idle" | "success" | "fail";
type ButtonKey = "copyCsv" | "downloadCsv" | "copyJson" | "downloadJson";

function downloadBlob(text: string, mime: string, filename: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ResultExportBar({
  result,
  filterQuery,
  onFilterChange,
  selectedIds,
}: {
  result: QueryResult;
  filterQuery: string;
  onFilterChange: (q: string) => void;
  selectedIds: Set<number>;
}) {
  const { t } = useTranslation("result");
  const tz = useDisplayPrefs((s) => s.tz);

  // When the user has highlighted rows, every export / copy operates on just
  // that subset (kept in original data order); otherwise on the full result.
  const hasSelection = selectedIds.size > 0;
  const exportResult = useMemo<QueryResult>(() => {
    if (!hasSelection) return result;
    return {
      ...result,
      rows: result.rows.filter((_, i) => selectedIds.has(i)),
    };
  }, [result, selectedIds, hasSelection]);
  const [feedback, setFeedback] = useState<Record<ButtonKey, Feedback>>({
    copyCsv: "idle",
    downloadCsv: "idle",
    copyJson: "idle",
    downloadJson: "idle",
  });
  const [filterExpanded, setFilterExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matchCount = useMemo(() => {
    if (!filterQuery) return result.rowCount;
    const q = filterQuery.toLowerCase();
    let n = 0;
    for (const row of result.rows) {
      for (let i = 0; i < result.columns.length; i++) {
        const col = result.columns[i];
        if (!col) continue;
        if (serializeValue(row[i], col, tz).toLowerCase().includes(q)) {
          n++;
          break;
        }
      }
    }
    return n;
  }, [filterQuery, result, tz]);

  if (result.rows.length === 0) return null;

  const SUCCESS_LABEL: Record<ButtonKey, string> = {
    copyCsv: t("export-bar.feedback-copied"),
    downloadCsv: t("export-bar.feedback-downloaded"),
    copyJson: t("export-bar.feedback-copied"),
    downloadJson: t("export-bar.feedback-downloaded"),
  };

  const FORMAT_LABEL: Record<ButtonKey, string> = {
    copyCsv: t("export-bar.format-csv"),
    downloadCsv: t("export-bar.format-csv"),
    copyJson: t("export-bar.format-json"),
    downloadJson: t("export-bar.format-json"),
  };

  function flash(key: ButtonKey, status: Feedback) {
    setFeedback((prev) => ({ ...prev, [key]: status }));
    window.setTimeout(() => {
      setFeedback((prev) => ({ ...prev, [key]: "idle" }));
    }, 1500);
  }

  async function handleCopy(key: ButtonKey, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      flash(key, "success");
    } catch {
      flash(key, "fail");
    }
  }

  function handleDownload(
    key: ButtonKey,
    text: string,
    mime: string,
    filename: string,
  ) {
    try {
      downloadBlob(text, mime, filename);
      flash(key, "success");
    } catch {
      flash(key, "fail");
    }
  }

  function labelFor(key: ButtonKey): string {
    const state = feedback[key];
    if (state === "success") return SUCCESS_LABEL[key];
    if (state === "fail") return t("export-bar.feedback-failed");
    return FORMAT_LABEL[key];
  }

  function renderButton(
    actionKey: ButtonKey,
    icon: ReactNode,
    onClick: () => void,
  ) {
    const state = feedback[actionKey];
    const busy = state !== "idle";
    return (
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        className={cn(
          "text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-center gap-1 rounded-sm px-2 py-1 text-xs disabled:opacity-80",
          state === "success" && "text-emerald-600 dark:text-emerald-400",
          state === "fail" && "text-destructive",
        )}
      >
        {icon}
        <span>{labelFor(actionKey)}</span>
      </button>
    );
  }

  function toggleFilter() {
    if (filterExpanded) {
      onFilterChange("");
      setFilterExpanded(false);
    } else {
      setFilterExpanded(true);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  const showInput = filterExpanded || !!filterQuery;

  const rightMeta = hasSelection
    ? t("export-bar.selected-meta", {
        selected: selectedIds.size,
        total: result.rowCount,
      })
    : filterQuery
      ? t("filter.matching", { matched: matchCount, total: result.rowCount })
      : t("export-bar.row-count-meta", {
          n: result.rowCount,
          detail: result.truncated
            ? t("export-bar.row-count-meta-capped", { cap: 1000 })
            : t("export-bar.row-count-meta-all"),
        });

  return (
    <div className="border-border flex shrink-0 items-center gap-1 border-b bg-gradient-to-b from-white/[0.03] to-transparent px-2 py-1">
      {renderButton(
        "copyCsv",
        <Copy className="h-3 w-3" />,
        () => void handleCopy("copyCsv", toCsv(exportResult, tz)),
      )}
      {renderButton(
        "downloadCsv",
        <Download className="h-3 w-3" />,
        () =>
          handleDownload(
            "downloadCsv",
            toCsv(exportResult, tz),
            "text/csv;charset=utf-8",
            buildFilename("csv"),
          ),
      )}
      <span className="text-muted-foreground/40 px-1">·</span>
      {renderButton(
        "copyJson",
        <Copy className="h-3 w-3" />,
        () => void handleCopy("copyJson", toJson(exportResult, tz)),
      )}
      {renderButton(
        "downloadJson",
        <Download className="h-3 w-3" />,
        () =>
          handleDownload(
            "downloadJson",
            toJson(exportResult, tz),
            "application/json",
            buildFilename("json"),
          ),
      )}
      <span className="text-muted-foreground/40 px-1">·</span>
      <button
        type="button"
        onClick={toggleFilter}
        title={t("filter.title")}
        className={cn(
          "text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-center gap-1 rounded-sm px-2 py-1 text-xs",
          showInput && "text-foreground bg-muted/50",
        )}
      >
        <Search className="h-3 w-3" />
      </button>
      {showInput && (
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={filterQuery}
            onChange={(e) => onFilterChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onFilterChange("");
                setFilterExpanded(false);
              }
            }}
            placeholder={t("filter.placeholder")}
            className="bg-background text-foreground placeholder:text-muted-foreground/60 focus:outline-none border-border h-6 w-48 rounded-sm border px-1.5 text-xs"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => onFilterChange("")}
              className="text-muted-foreground hover:text-foreground rounded-sm p-0.5"
              aria-label={t("filter.clear-aria")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      <span className="text-muted-foreground/60 ml-auto text-xs">
        {rightMeta}
      </span>
    </div>
  );
}
