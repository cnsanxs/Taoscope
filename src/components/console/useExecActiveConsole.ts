import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import type { HistoryEntry } from "@/datasource/types";
import { useDataSource } from "@/datasource/context";
import { useAppState } from "@/store/appState";
import { confirm } from "@/components/ui/confirm";
import { fmtShortcut } from "@/lib/platform";
import { hashString } from "@/lib/hashString";
import * as editorBridge from "./editorBridge";
import {
  applyRowCap,
  ensureExplainPrefix,
  injectRowCapLimit,
  isDestructiveStatement,
  leadingKeyword,
} from "./rowCapInjector";
import {
  findStatementAt,
  isSingleLineStatement,
  splitStatements,
} from "./splitStatements";

export type ExecMode = "run" | "explain";

export interface UseExecActiveConsoleResult {
  canRun: boolean;
  isRunning: boolean;
  exec: () => void;
  cancel: () => void;
}

const HISTORY_LIMIT = 50;

export function useExecActiveConsole(
  mode: ExecMode,
): UseExecActiveConsoleResult {
  const { t } = useTranslation("console");
  const ds = useDataSource();
  const activeConsoleId = useAppState((s) => s.activeConsoleId);
  const activeConsole = useAppState((s) =>
    activeConsoleId
      ? (s.consoles.find((c) => c.id === activeConsoleId) ?? null)
      : null,
  );
  const connection = useAppState((s) =>
    activeConsole
      ? (s.connections.find((c) => c.id === activeConsole.connectionId) ?? null)
      : null,
  );
  const runtime = useAppState((s) =>
    activeConsoleId ? s.consoleRuntime[activeConsoleId] : undefined,
  );
  const setRunStarted = useAppState((s) => s.setRunStarted);
  const setRunOk = useAppState((s) => s.setRunOk);
  const setRunError = useAppState((s) => s.setRunError);
  const setHistory = useAppState((s) => s.setHistory);
  const setPrimedRange = useAppState((s) => s.setPrimedRange);

  const canRun =
    !!activeConsoleId &&
    !!activeConsole &&
    !!connection &&
    connection.status === "online" &&
    runtime?.execStatus !== "running";

  const isRunning = runtime?.execStatus === "running";

  async function exec() {
    if (!canRun || !activeConsole || !connection || !activeConsoleId) return;
    const id = activeConsoleId;
    const fullScratch = runtime?.scratch ?? "";

    const sel = editorBridge.getSelectionRange();
    const cursor = editorBridge.getCursorPos();

    let chosenSql: string;

    if (sel) {
      // CASE A (selection differs from primed) and CASE B (selection
      // exactly matches primed and scratch is unchanged) both execute the
      // current selection and drop primed afterward. The distinction
      // matters for the "what got primed" mental model but not for the
      // dispatch path.
      chosenSql = editorBridge.getSelectionText();
      setPrimedRange(id, null);
    } else if (cursor !== null) {
      const range = findStatementAt(fullScratch, cursor);
      if (!range) {
        // CASE D: no resolvable statement (empty / whitespace scratch).
        setPrimedRange(id, null);
        return;
      }

      if (isSingleLineStatement(fullScratch, range)) {
        // CASE C — single-line: execute immediately, drop any stale prime.
        setPrimedRange(id, null);
        chosenSql = range.text;
      } else {
        // CASE C — multi-line: prime, do not execute.
        editorBridge.setSelection(range.start, range.end);
        setPrimedRange(id, {
          from: range.start,
          to: range.end,
          scratchHash: hashString(fullScratch),
        });
        toast.info(
          t("exec.primed-toast", {
            shortcut: fmtShortcut(
              mode === "explain" ? ["Mod", "Shift", "Enter"] : ["Mod", "Enter"],
            ),
          }),
          {
            id: `primed-${id}`,
            duration: 4000,
          },
        );
        return;
      }
    } else {
      // CASE D fallback — editor not mounted yet; run whatever scratch we have.
      setPrimedRange(id, null);
      chosenSql = fullScratch;
    }

    if (chosenSql.trim().length === 0) return;

    // Multi-statement guard. If `chosenSql` parses into >1 statements
    // (e.g. a stale selection covering several `;`-separated SQLs, or a
    // CASE D fallback to the whole scratch), sending it as a `;`-joined
    // blob would dispatch only the first statement on the TDengine REST
    // path and leave the appended `LIMIT 1001` bound to nothing — the
    // user then sees an uncapped result they didn't ask for. Snap the
    // choice down to the statement at the document cursor (or the first
    // statement if no cursor) and warn.
    const parsed = splitStatements(chosenSql);
    if (parsed.length > 1) {
      const docCursor = editorBridge.getCursorPos();
      const focused =
        docCursor !== null
          ? findStatementAt(fullScratch, docCursor)
          : null;
      chosenSql = focused?.text ?? parsed[0]?.text ?? chosenSql;
      toast.warning(t("exec.multi-stmt-warning"), {
        id: `multi-stmt-${id}`,
        duration: 4000,
      });
    }

    // For explain mode, prepend EXPLAIN if absent. History stores the
    // dispatched SQL (with prefix) so replaying from history reproduces the
    // plan-query semantics.
    const dispatchSql =
      mode === "explain" ? ensureExplainPrefix(chosenSql) : chosenSql;

    // Irreversible statements (DROP / DELETE) require confirmation before
    // dispatch. EXPLAIN mode never executes the statement, so it is exempt.
    // The prime step never reaches this point — confirmation only fires on
    // the actual execute press.
    if (mode === "run" && isDestructiveStatement(chosenSql)) {
      const ok = await confirm({
        title: t("destructive-confirm.title", {
          keyword: leadingKeyword(chosenSql),
        }),
        description: t("destructive-confirm.description"),
        confirmLabel: t("destructive-confirm.confirm"),
        danger: true,
      });
      if (!ok) return;
    }

    const prevHistory = runtime?.history ?? [];
    const injected = injectRowCapLimit(dispatchSql);
    const queryId = crypto.randomUUID();
    setRunStarted(id, queryId);
    ds.runSql(connection.id, activeConsole.currentDb, injected, queryId)
      .then((r) => {
        // Write/DDL results carry affectedRows and no result set; the row cap
        // only applies to read queries.
        const capped = r.affectedRows != null ? r : applyRowCap(r);
        const entry: HistoryEntry = {
          sql: dispatchSql,
          runAt: Date.now(),
          rowCount: capped.rowCount,
          elapsedMs: capped.elapsedMs,
          truncated: capped.truncated,
        };
        const next = [entry, ...prevHistory].slice(0, HISTORY_LIMIT);
        setHistory(id, next);
        setRunOk(id, capped);
        void ds.saveResult(id, capped);
        void ds.saveHistory(id, next);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setRunError(id, message);
      });
  }

  function cancel() {
    const queryId = runtime?.runningQueryId;
    if (!queryId) return;
    // Fire and forget: the UI reverts to idle as soon as the in-flight
    // promise rejects (via setRunError on "Query cancelled").
    void ds.cancelQuery(queryId);
  }

  return { canRun, isRunning, exec, cancel };
}
