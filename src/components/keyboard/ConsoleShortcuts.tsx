import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import * as editorBridge from "@/components/console/editorBridge";
import { formatScratch } from "@/components/console/formatScratch";
import { useExplainActiveConsole } from "@/components/console/useExplainActiveConsole";
import { useDataSource } from "@/datasource/context";
import type { DataSource } from "@/datasource/types";
import {
  useAppState,
  type ConsoleRuntimeEntry,
} from "@/store/appState";
import type { Connection, Console } from "@/datasource/types";
import { confirm } from "@/components/ui/confirm";

interface ShortcutState {
  consoles: Console[];
  activeConsoleId: string | null;
  connections: Connection[];
  consoleRuntime: Record<string, ConsoleRuntimeEntry>;
  ds: DataSource;
  addConsole: (c: Console) => void;
  setActiveConsole: (id: string | null) => void;
  removeConsole: (id: string) => void;
  setScratch: (id: string, scratch: string) => void;
  explain: () => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

export function ConsoleShortcuts() {
  const { t } = useTranslation("console");
  const ds = useDataSource();
  const consoles = useAppState((s) => s.consoles);
  const activeConsoleId = useAppState((s) => s.activeConsoleId);
  const connections = useAppState((s) => s.connections);
  const consoleRuntime = useAppState((s) => s.consoleRuntime);
  const addConsole = useAppState((s) => s.addConsole);
  const setActiveConsole = useAppState((s) => s.setActiveConsole);
  const removeConsole = useAppState((s) => s.removeConsole);
  const setScratch = useAppState((s) => s.setScratch);
  const { explain } = useExplainActiveConsole();

  const stateRef = useRef<ShortcutState>({
    consoles,
    activeConsoleId,
    connections,
    consoleRuntime,
    ds,
    addConsole,
    setActiveConsole,
    removeConsole,
    setScratch,
    explain,
    t: t as ShortcutState["t"],
  });

  useEffect(() => {
    stateRef.current = {
      consoles,
      activeConsoleId,
      connections,
      consoleRuntime,
      ds,
      addConsole,
      setActiveConsole,
      removeConsole,
      setScratch,
      explain,
      t: t as ShortcutState["t"],
    };
  });

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const modOn = e.metaKey || e.ctrlKey;
      const bothMod = e.metaKey && e.ctrlKey;
      if (!modOn || bothMod) return;
      if (e.altKey) return;
      // The editor's CM keymap already handles Mod+Shift+Enter (with
      // `preventDefault: true`) when focused. Without this guard the
      // window-level fallback fires a second `explain()` for the same
      // press, which collides with the prime/execute state machine.
      if (e.defaultPrevented) return;

      const s = stateRef.current;

      if (e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        s.explain();
        return;
      }

      if (e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        const { activeConsoleId, consoleRuntime, setScratch } = s;
        if (!activeConsoleId) return;
        const runtime = consoleRuntime[activeConsoleId];
        if (!runtime || runtime.scratch.trim().length === 0) return;

        const sel = editorBridge.getSelectionRange();
        if (sel) {
          const selText = editorBridge.getSelectionText();
          const result = formatScratch(selText);
          if (result.ok) {
            editorBridge.replaceRange(sel.from, sel.to, result.formatted);
          } else {
            toast.error(s.t("format.failed", { message: result.message }));
          }
          return;
        }

        const result = formatScratch(runtime.scratch);
        if (result.ok) {
          setScratch(activeConsoleId, result.formatted);
        } else {
          toast.error(s.t("format.failed", { message: result.message }));
        }
        return;
      }

      if (e.shiftKey) return;

      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number.parseInt(e.key, 10);
        const ordered = [...s.consoles].sort(
          (a, b) => a.createdAt - b.createdAt,
        );
        const target = ordered[n - 1];
        if (target) s.setActiveConsole(target.id);
        return;
      }

      const key = e.key.toLowerCase();

      if (key === "t") {
        e.preventDefault();
        let connId: string | null = null;
        if (s.activeConsoleId) {
          connId =
            s.consoles.find((c) => c.id === s.activeConsoleId)
              ?.connectionId ?? null;
        }
        if (!connId) {
          connId =
            s.connections.find((c) => c.status === "online")?.id ?? null;
        }
        if (!connId) return;
        s.ds
          .createConsole({ connectionId: connId })
          .then((created) => {
            s.addConsole(created);
            s.setActiveConsole(created.id);
          })
          .catch(() => {
            // silent
          });
        return;
      }

      if (key === "w") {
        e.preventDefault();
        if (!s.activeConsoleId) return;
        const active = s.consoles.find((c) => c.id === s.activeConsoleId);
        if (!active) return;
        void (async () => {
          const ok = await confirm({
            title: s.t("delete-confirm.title", { name: active.name }),
            description: s.t("delete-confirm.description"),
            confirmLabel: s.t("consoles-panel.menu.delete"),
            danger: true,
          });
          if (!ok) return;
          try {
            await s.ds.deleteConsole(active.id);
            s.removeConsole(active.id);
          } catch {
            // silent
          }
        })();
        return;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return null;
}
