import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LineChart, Table as TableIcon } from "lucide-react";

import type { QueryResult } from "@/datasource/types";
import { useAppState } from "@/store/appState";
import { cn } from "@/lib/utils";
import { ChartView } from "@/components/console/ChartView";
import { ResultExportBar } from "@/components/console/ResultExportBar";
import { ResultGrid } from "@/components/console/ResultGrid";
import { ResultStatsPill } from "@/components/layout/StatusBar";

type DataView = "table" | "chart";

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground/60 text-xs">{children}</p>
    </div>
  );
}

const TIMEOUT_ERROR_PREFIX = "Query timeout after ";

function parseTimeoutSeconds(message: string): number | null {
  if (!message.startsWith(TIMEOUT_ERROR_PREFIX)) return null;
  const m = /Query timeout after (\d+)ms/.exec(message);
  if (!m || !m[1]) return null;
  const ms = Number.parseInt(m[1], 10);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

function FullScreenError({ message }: { message: string }) {
  const { t } = useTranslation("result");
  const timeoutSec = parseTimeoutSeconds(message);
  if (timeoutSec !== null) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <p className="text-amber-700 dark:text-amber-300 text-xs">
          <span className="mr-1">⏱</span>
          {t("error.timeout", { seconds: timeoutSec })}
        </p>
      </div>
    );
  }
  if (message.startsWith("Query cancelled")) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <p className="text-muted-foreground text-xs">{t("error.cancelled")}</p>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-4">
      <p className="text-destructive text-xs">
        <span className="mr-1">✕</span>
        {t("error.failed-prefix")}{" "}
        <span className="font-mono">{message}</span>
      </p>
    </div>
  );
}

function AffectedRowsBanner({ result }: { result: QueryResult }) {
  const { t } = useTranslation("result");
  const affected = result.affectedRows ?? 0;
  const text =
    affected > 0
      ? t("affected.rows", {
          count: affected,
          ms: result.elapsedMs,
        })
      : t("affected.success", { ms: result.elapsedMs });
  return (
    <div className="flex h-full items-center justify-center px-4">
      <p className="text-emerald-600 dark:text-emerald-400 text-xs">
        <span className="mr-1">✓</span>
        {text}
      </p>
    </div>
  );
}

function GridWithBanners({ result }: { result: QueryResult }) {
  const { t } = useTranslation("result");
  const [filterQuery, setFilterQuery] = useState("");
  // Highlighted rows, by original data index. Reset whenever a new result
  // arrives so a fresh query never inherits a stale selection.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    setFilterQuery("");
    setSelectedIds(new Set());
  }, [result]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ResultExportBar
        result={result}
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        selectedIds={selectedIds}
      />
      {result.truncated && (
        <div className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 flex shrink-0 items-center gap-1.5 border-b px-3 py-1 text-xs">
          <span>⚠</span>
          <span>
            {t("banner.truncated", { cap: 1000, limit: "LIMIT" })}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ResultGrid
          result={result}
          filterQuery={filterQuery}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
        />
      </div>
    </div>
  );
}

function ViewSidebar({
  view,
  onChange,
}: {
  view: DataView;
  onChange: (v: DataView) => void;
}) {
  const { t } = useTranslation("result");
  const items: { key: DataView; icon: ReactNode; label: string }[] = [
    {
      key: "table",
      icon: <TableIcon className="h-4 w-4" />,
      label: t("view-tabs.table"),
    },
    {
      key: "chart",
      icon: <LineChart className="h-4 w-4" />,
      label: t("view-tabs.chart"),
    },
  ];
  // Capsule width + horizontal offset are tuned to vertically column with the
  // CodeMirror line-number gutter above (~44px wide, sitting 9px in from the
  // editor panel's outer border = 8px panel padding + 1px CM border). The
  // capsule stretches the full available height (matching the data box's
  // my-2 inset on the right) so the two rounded boxes feel like a single
  // bracketed unit. Icons stay pinned to the top of the capsule.
  return (
    <div
      className="flex h-full shrink-0 flex-col"
      style={{
        paddingLeft: 9,
        paddingRight: 9,
        paddingTop: 8,
        paddingBottom: 8,
      }}
    >
      <div
        className="border-border/60 bg-muted/30 flex flex-1 flex-col items-center gap-1 rounded-md border p-1 shadow-sm backdrop-blur-sm"
        style={{ width: 44 }}
      >
        {items.map((it) => {
          const active = view === it.key;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => onChange(it.key)}
              title={it.label}
              aria-label={it.label}
              aria-pressed={active}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                active
                  ? "bg-accent text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {it.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ResultPanel() {
  const { t } = useTranslation("result");
  const activeConsoleId = useAppState((s) => s.activeConsoleId);
  const runtime = useAppState((s) =>
    activeConsoleId ? s.consoleRuntime[activeConsoleId] : undefined,
  );
  const [view, setView] = useState<DataView>("table");

  let body: ReactNode;
  if (!activeConsoleId) {
    body = <EmptyHint>{t("empty.no-console")}</EmptyHint>;
  } else if (!runtime) {
    body = <EmptyHint>{t("empty.loading")}</EmptyHint>;
  } else {
    const { execStatus, execError, lastResult } = runtime;

    if (execStatus === "idle" && !lastResult) {
      body = <EmptyHint>{t("empty.run-prompt")}</EmptyHint>;
    } else if (execStatus === "running" && !lastResult) {
      body = <EmptyHint>{t("empty.running")}</EmptyHint>;
    } else if (execStatus === "running" && lastResult) {
      body =
        view === "chart" ? (
          <ChartView result={lastResult} />
        ) : (
          <GridWithBanners result={lastResult} />
        );
    } else if (execStatus === "ok" && lastResult?.affectedRows != null) {
      // Write/DDL statement: no result set, show an affected-rows banner.
      body = <AffectedRowsBanner result={lastResult} />;
    } else if (execStatus === "ok" && lastResult) {
      // Always render the grid on success — even with 0 rows, the column
      // headers tell the user what the query *would* have returned, which is
      // useful schema info. ResultGrid surfaces a "No rows" placeholder when
      // rows.length === 0.
      body =
        view === "chart" ? (
          <ChartView result={lastResult} />
        ) : (
          <GridWithBanners result={lastResult} />
        );
    } else if (execStatus === "error") {
      // Don't keep showing the previous query's grid behind a red banner —
      // that misleads the user into thinking the failed query "returned" those
      // columns. Show the error full-screen, regardless of whether a stale
      // lastResult is still around.
      body = <FullScreenError message={execError ?? t("error.unknown")} />;
    } else {
      body = <EmptyHint>—</EmptyHint>;
    }
  }

  return (
    <div className="border-border/70 bg-card relative flex h-full min-h-0 flex-row overflow-hidden rounded-lg border shadow-[0_4px_16px_-4px_rgba(0,0,0,0.45),inset_0_1px_0_0_hsl(0_0%_100%/0.05)]">
      <ViewSidebar view={view} onChange={setView} />
      <div className="border-border my-2 mr-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
        {body}
      </div>
      {/* Stats pill floats over the body. Hidden in Chart view because
          the chart canvas has no scroll affordance to dodge it — the
          pill would permanently sit over the lines and the bottom-axis
          tick labels. Table view scrolls, so it's not a problem there. */}
      {view !== "chart" && <ResultStatsPill />}
    </div>
  );
}
