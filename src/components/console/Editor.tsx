import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { sql } from "@codemirror/lang-sql";
import { TDengineDialect } from "./tdengineDialect";
import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  toggleLineComment,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { useDataSource } from "@/datasource/context";
import { useAppState } from "@/store/appState";
import { hashString } from "@/lib/hashString";
import * as editorBridge from "./editorBridge";
import { useExplainActiveConsole } from "./useExplainActiveConsole";
import { useRunActiveConsole } from "./useRunActiveConsole";
import { taoscopeEditorExtensions, taoscopeEditorTheme } from "./sqlEditorTheme";
import { createSqlCompletionSource } from "./sqlCompletionSource";
import { useEditorSchemaContext } from "./useEditorSchemaContext";

const SCRATCH_DEBOUNCE_MS = 400;

export function Editor() {
  const { t, i18n } = useTranslation("console");
  const { t: tCommon } = useTranslation("common");
  const ds = useDataSource();
  const activeConsoleId = useAppState((s) => s.activeConsoleId);
  const runtime = useAppState((s) =>
    activeConsoleId ? s.consoleRuntime[activeConsoleId] : undefined,
  );
  const hydrateConsoleRuntime = useAppState((s) => s.hydrateConsoleRuntime);
  const setScratch = useAppState((s) => s.setScratch);
  const setPrimedRange = useAppState((s) => s.setPrimedRange);
  const pendingAppendAndRun = useAppState((s) => s.pendingAppendAndRun);
  const clearPendingAppendAndRun = useAppState(
    (s) => s.clearPendingAppendAndRun,
  );

  // Refs let CodeMirror's keymap and updateListener (built once via
  // useMemo) read the latest activeConsoleId without rebuilding extensions
  // on every console switch.
  const activeConsoleIdRef = useRef<string | null>(activeConsoleId);
  useEffect(() => {
    activeConsoleIdRef.current = activeConsoleId;
  }, [activeConsoleId]);

  const setPrimedRangeRef = useRef(setPrimedRange);
  useEffect(() => {
    setPrimedRangeRef.current = setPrimedRange;
  }, [setPrimedRange]);

  const { run } = useRunActiveConsole();
  const runRef = useRef<() => void>(() => {});
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const { explain } = useExplainActiveConsole();
  const explainRef = useRef<() => void>(() => {});
  useEffect(() => {
    explainRef.current = explain;
  }, [explain]);

  const schemaCtx = useEditorSchemaContext();
  const editorCtxRef = useRef<{ connectionId: string | null; db: string | null }>(
    { connectionId: schemaCtx.connectionId, db: schemaCtx.db },
  );
  useEffect(() => {
    editorCtxRef.current = {
      connectionId: schemaCtx.connectionId,
      db: schemaCtx.db,
    };
  }, [schemaCtx.connectionId, schemaCtx.db]);

  const sqlSource = useMemo(
    () =>
      createSqlCompletionSource({
        ds,
        getContext: () => editorCtxRef.current,
      }),
    [ds],
  );

  const viewRef = useRef<EditorView | null>(null);
  const [viewReady, setViewReady] = useState(false);
  const handleCreateEditor = (view: EditorView) => {
    viewRef.current = view;
    editorBridge.registerView(view);
    setViewReady(true);
  };

  useEffect(() => {
    return () => {
      editorBridge.unregisterView();
    };
  }, []);

  // Append-and-run handoff. Two-phase to keep CodeMirror's controlled `value`
  // prop authoritative:
  //   1. Once the target console is active and its scratch is hydrated, write
  //      the new scratch into the store. This is what the editor renders, so
  //      the appended SELECT is guaranteed to be visible — no race against
  //      CodeMirror's internal value-reconcile effect (which would otherwise
  //      reset a directly-dispatched doc whenever the store hadn't caught up
  //      yet, e.g. on the very first mount of a new console).
  //   2. Once CodeMirror has propagated the new value into the view's doc,
  //      select the appended statement (so the run hook picks it up via the
  //      live selection) and trigger run.
  const [pendingSelection, setPendingSelection] = useState<{
    consoleId: string;
    from: number;
    to: number;
    expectedScratch: string;
  } | null>(null);

  // Phase 1: write scratch.
  useEffect(() => {
    if (!pendingAppendAndRun) return;
    if (!activeConsoleId) return;
    if (pendingAppendAndRun.consoleId !== activeConsoleId) return;
    if (!runtime) return;
    if (pendingSelection?.consoleId === activeConsoleId) return;
    const oldScratch = runtime.scratch;
    const needsBlankLine =
      oldScratch.length > 0 && !/(?:^|\n)\s*$/.test(oldScratch);
    const prefix = oldScratch.length === 0 ? "" : needsBlankLine ? "\n\n" : "";
    const newScratch = `${oldScratch}${prefix}${pendingAppendAndRun.sql}`;
    setPendingSelection({
      consoleId: activeConsoleId,
      from: oldScratch.length + prefix.length,
      to: newScratch.length,
      expectedScratch: newScratch,
    });
    setScratch(activeConsoleId, newScratch);
    clearPendingAppendAndRun();
  }, [
    pendingAppendAndRun,
    activeConsoleId,
    runtime,
    pendingSelection,
    setScratch,
    clearPendingAppendAndRun,
  ]);

  // Phase 2: select + run, once the view's doc reflects the new scratch.
  useEffect(() => {
    if (!pendingSelection) return;
    if (!viewReady) return;
    if (pendingSelection.consoleId !== activeConsoleId) {
      setPendingSelection(null);
      return;
    }
    if (!runtime) return;
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== pendingSelection.expectedScratch) return;
    const { from, to } = pendingSelection;
    setPendingSelection(null);
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: true,
    });
    view.focus();
    runRef.current();
  }, [pendingSelection, viewReady, activeConsoleId, runtime]);

  // Drop any residual non-collapsed selection when the active console
  // changes. CM keeps a single EditorView across console switches, so a
  // drag-select left over in console A would otherwise survive into
  // console B and get scooped up by exec's CASE A path — silently
  // executing the wrong SQL.
  useEffect(() => {
    if (!viewReady) return;
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.from !== sel.to) {
      view.dispatch({ selection: { anchor: sel.head, head: sel.head } });
    }
  }, [activeConsoleId, viewReady]);

  // Track which console ids have been hydration-started this session to
  // avoid double-fetching during re-renders.
  const hydratingRef = useRef<Set<string>>(new Set());

  // Hydrate runtime on first activation of a console.
  useEffect(() => {
    if (!activeConsoleId) return;
    if (runtime) return;
    if (hydratingRef.current.has(activeConsoleId)) return;
    hydratingRef.current.add(activeConsoleId);
    let cancelled = false;
    Promise.all([
      ds.loadScratch(activeConsoleId),
      ds.loadResult(activeConsoleId),
      ds.loadHistory(activeConsoleId),
    ]).then(([scratch, lastResult, history]) => {
      if (cancelled) return;
      hydrateConsoleRuntime(activeConsoleId, {
        scratch,
        lastResult,
        execStatus: "idle",
        execError: null,
        history,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [ds, activeConsoleId, runtime, hydrateConsoleRuntime]);

  // Debounced scratch persistence.
  useEffect(() => {
    if (!activeConsoleId) return;
    if (!runtime) return;
    const id = activeConsoleId;
    const value = runtime.scratch;
    const handle = window.setTimeout(() => {
      void ds.saveScratch(id, value);
    }, SCRATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [ds, activeConsoleId, runtime]);

  const extensions = useMemo(() => {
    const sqlExt = sql({ dialect: TDengineDialect });
    return [
      sqlExt,
      sqlExt.language.data.of({ autocomplete: sqlSource }),
      history(),
      bracketMatching(),
      indentOnInput(),
      autocompletion(),
      highlightActiveLine(),
      lineNumbers(),
      placeholder(t("editor.placeholder")),
      EditorView.contentAttributes.of({ spellcheck: "false" }),
      // Mod-Enter has to outrank the default Enter handler (which inserts a
      // newline) and the autocompletion Enter handler (which accepts a
      // suggestion). Prec.high + explicit preventDefault makes this
      // unambiguous regardless of how the other extensions register theirs.
      Prec.high(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              runRef.current();
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            preventDefault: true,
            run: () => {
              explainRef.current();
              return true;
            },
          },
          {
            key: "Escape",
            run: (view) => {
              const id = activeConsoleIdRef.current;
              if (!id) return false;
              const primed = useAppState.getState().primedRanges[id];
              const sel = view.state.selection.main;
              const hasSelection = sel.from !== sel.to;
              // Only intercept when there's something to clear — primed
              // state or a non-empty selection. Otherwise let CM's default
              // Escape handler run.
              if (!primed && !hasSelection) return false;
              if (primed) setPrimedRangeRef.current(id, null);
              // Collapse selection to its head so any residual range —
              // whether the visual prime or an unrelated drag-select that
              // would otherwise be picked up by CASE A on the next Run —
              // goes away.
              view.dispatch({ selection: { anchor: sel.head, head: sel.head } });
              return true;
            },
          },
        ]),
      ),
      // Selection-change observer: any movement that no longer matches the
      // primed range invalidates it. Edits invalidate via the dedicated
      // hash check in onChange below.
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const id = activeConsoleIdRef.current;
        if (!id) return;
        const primed = useAppState.getState().primedRanges[id];
        if (!primed) return;
        const sel = update.state.selection.main;
        if (sel.from !== primed.from || sel.to !== primed.to) {
          setPrimedRangeRef.current(id, null);
        }
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...completionKeymap,
        { key: "Mod-/", run: toggleLineComment },
        { key: "Mod-d", run: copyLineDown, preventDefault: true },
      ]),
      ...taoscopeEditorExtensions,
    ];
    // i18n.language is included so a locale switch rebuilds the CodeMirror
    // extension list, picking up the new placeholder string. The other deps
    // are stable across locale changes; their inclusion is the existing
    // behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sqlSource, i18n.language]);

  if (!activeConsoleId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-3">
        <p className="text-muted-foreground/60 text-xs">
          {t("editor.empty-state")}
        </p>
      </div>
    );
  }

  if (!runtime) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-3">
        <p className="text-muted-foreground/60 text-xs">
          {tCommon("status.loading")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 p-2">
      <CodeMirror
        value={runtime.scratch}
        onChange={(v) => {
          setScratch(activeConsoleId, v);
          // Any edit that changes the scratch hash invalidates the primed
          // range — the user's "what's about to run" no longer matches
          // what we captured. The selection listener handles cursor moves
          // separately; this branch fires even when selection is unchanged
          // (e.g. typing inside the primed selection's boundaries).
          const primed = useAppState.getState().primedRanges[activeConsoleId];
          if (primed && primed.scratchHash !== hashString(v)) {
            setPrimedRange(activeConsoleId, null);
          }
        }}
        onCreateEditor={handleCreateEditor}
        height="100%"
        theme={taoscopeEditorTheme}
        extensions={extensions}
        basicSetup={false}
        className="border-border h-full w-full overflow-hidden rounded-md border"
      />
    </div>
  );
}
