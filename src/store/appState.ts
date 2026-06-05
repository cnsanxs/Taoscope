import { create } from "zustand";
import type {
  Connection,
  Console,
  HistoryEntry,
  QueryResult,
} from "@/datasource/types";

export type ExecStatus = "idle" | "running" | "ok" | "error";

export interface GridState {
  sorting: { id: string; desc: boolean }[];
  columnSizing: Record<string, number>;
}

const DEFAULT_GRID_STATE: GridState = {
  sorting: [],
  columnSizing: {},
};

export interface ConsoleRuntimeEntry {
  scratch: string;
  lastResult: QueryResult | null;
  execStatus: ExecStatus;
  execError: string | null;
  gridState: GridState;
  history: HistoryEntry[];
  /** UUID of the currently in-flight runSql; null when idle. */
  runningQueryId: string | null;
}

const DEFAULT_RUNTIME: ConsoleRuntimeEntry = {
  scratch: "",
  lastResult: null,
  execStatus: "idle",
  execError: null,
  gridState: DEFAULT_GRID_STATE,
  history: [],
  runningQueryId: null,
};

/** Ephemeral per-connection runtime state. Not persisted; rebuilt from
 *  backend reconnect events on each session. */
export interface ConnectionRuntimeEntry {
  /** True between `connection:reconnecting` and the next
   *  `connection:reconnected` / `connection:reconnect-failed` event. */
  reconnecting: boolean;
}

interface AppState {
  connections: Connection[];
  setConnections: (connections: Connection[]) => void;
  /** Update one connection's `status` field in place. Used by the reconnect
   *  event subscriber to flip a connection to `offline` when reconnect fails. */
  setConnectionStatus: (connId: string, status: "online" | "offline") => void;

  /** Ephemeral, not persisted. Keyed by connection id. */
  connectionRuntime: Record<string, ConnectionRuntimeEntry>;
  setReconnecting: (connId: string, value: boolean) => void;

  consoles: Console[];
  setConsoles: (list: Console[]) => void;
  addConsole: (c: Console) => void;
  removeConsole: (id: string) => void;
  removeConsolesByConnection: (connectionId: string) => void;
  renameConsoleLocal: (id: string, name: string) => void;
  setConsoleDbLocal: (id: string, db: string | null) => void;

  activeConsoleId: string | null;
  setActiveConsole: (id: string | null) => void;

  /** Transient request to reveal + highlight a database in the resource tree.
   *  The nonce makes repeated requests for the same target re-fire. */
  resourceFocus: { connId: string; db: string; nonce: number } | null;
  requestResourceFocus: (connId: string, db: string) => void;

  /** Bumped to force the active console (item + db badge) to flash even when
   *  the active console id didn't change (e.g. re-selecting the bound one). */
  consoleFlashNonce: number;
  pulseActiveConsole: () => void;

  /** Queued request to append a SQL snippet to the given console's editor and
   *  immediately execute it. Picked up by the Editor once that console is
   *  active and its runtime + EditorView are ready. The nonce lets repeated
   *  requests for the same (consoleId, sql) re-fire. */
  pendingAppendAndRun: {
    consoleId: string;
    sql: string;
    nonce: number;
  } | null;
  requestAppendAndRun: (consoleId: string, sql: string) => void;
  clearPendingAppendAndRun: () => void;

  consoleRuntime: Record<string, ConsoleRuntimeEntry>;

  /** Ephemeral per-console "primed" range for the two-stage smart-exec flow.
   *  Set when the user presses Run on a multi-line statement; cleared on
   *  edit, selection change, console/db switch, Esc, or successful execute. */
  primedRanges: Record<
    string,
    { from: number; to: number; scratchHash: number } | undefined
  >;
  setPrimedRange: (
    consoleId: string,
    range: { from: number; to: number; scratchHash: number } | null,
  ) => void;

  hydrateConsoleRuntime: (
    id: string,
    init: Partial<ConsoleRuntimeEntry>,
  ) => void;
  setScratch: (id: string, scratch: string) => void;
  setRunStarted: (id: string, queryId: string) => void;
  setRunOk: (id: string, result: QueryResult) => void;
  setRunError: (id: string, message: string) => void;
  setGridState: (id: string, state: GridState) => void;
  setHistory: (id: string, entries: HistoryEntry[]) => void;
}

export const useAppState = create<AppState>((set) => ({
  connections: [],
  setConnections: (connections) => set({ connections }),
  setConnectionStatus: (connId, status) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === connId ? { ...c, status } : c,
      ),
    })),

  connectionRuntime: {},
  setReconnecting: (connId, value) =>
    set((state) => {
      const prev = state.connectionRuntime[connId];
      // Avoid producing a new object when the value isn't actually changing —
      // keeps subscribers from re-rendering on duplicate events.
      if (prev?.reconnecting === value) return state;
      return {
        connectionRuntime: {
          ...state.connectionRuntime,
          [connId]: { reconnecting: value },
        },
      };
    }),

  consoles: [],
  setConsoles: (list) => set({ consoles: list }),
  addConsole: (c) => set((state) => ({ consoles: [...state.consoles, c] })),
  removeConsole: (id) =>
    set((state) => {
      const consoles = state.consoles.filter((c) => c.id !== id);
      const activeConsoleId =
        state.activeConsoleId === id ? null : state.activeConsoleId;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [id]: _dropped, ...consoleRuntime } = state.consoleRuntime;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [id]: _droppedPrime, ...primedRanges } = state.primedRanges;
      return { consoles, activeConsoleId, consoleRuntime, primedRanges };
    }),
  removeConsolesByConnection: (connectionId) =>
    set((state) => {
      const dropped = new Set(
        state.consoles
          .filter((c) => c.connectionId === connectionId)
          .map((c) => c.id),
      );
      if (dropped.size === 0) return state;
      const consoles = state.consoles.filter((c) => !dropped.has(c.id));
      const activeConsoleId =
        state.activeConsoleId && dropped.has(state.activeConsoleId)
          ? null
          : state.activeConsoleId;
      const consoleRuntime = Object.fromEntries(
        Object.entries(state.consoleRuntime).filter(
          ([cid]) => !dropped.has(cid),
        ),
      );
      const primedRanges = Object.fromEntries(
        Object.entries(state.primedRanges).filter(([cid]) => !dropped.has(cid)),
      );
      return { consoles, activeConsoleId, consoleRuntime, primedRanges };
    }),
  renameConsoleLocal: (id, name) =>
    set((state) => ({
      consoles: state.consoles.map((c) => (c.id === id ? { ...c, name } : c)),
    })),
  setConsoleDbLocal: (id, db) =>
    set((state) => {
      // A db switch invalidates any primed range — the user's mental model
      // of "what's about to run" no longer holds.
      let primedRanges = state.primedRanges;
      if (primedRanges[id]) {
        const next = { ...primedRanges };
        delete next[id];
        primedRanges = next;
      }
      return {
        consoles: state.consoles.map((c) =>
          c.id === id ? { ...c, currentDb: db } : c,
        ),
        primedRanges,
      };
    }),

  activeConsoleId: null,
  setActiveConsole: (id) =>
    set((state) => {
      const prevId = state.activeConsoleId;
      // Defense in depth: clear primed on both the leaving and the arriving
      // console so a stale prime can never bleed across tabs.
      let primedRanges = state.primedRanges;
      if (prevId && primedRanges[prevId]) {
        const next = { ...primedRanges };
        delete next[prevId];
        primedRanges = next;
      }
      if (id && primedRanges[id]) {
        const next = { ...primedRanges };
        delete next[id];
        primedRanges = next;
      }
      return { activeConsoleId: id, primedRanges };
    }),

  resourceFocus: null,
  requestResourceFocus: (connId, db) =>
    set((state) => ({
      resourceFocus: {
        connId,
        db,
        nonce: (state.resourceFocus?.nonce ?? 0) + 1,
      },
    })),

  consoleFlashNonce: 0,
  pulseActiveConsole: () =>
    set((state) => ({ consoleFlashNonce: state.consoleFlashNonce + 1 })),

  pendingAppendAndRun: null,
  requestAppendAndRun: (consoleId, sql) =>
    set((state) => ({
      pendingAppendAndRun: {
        consoleId,
        sql,
        nonce: (state.pendingAppendAndRun?.nonce ?? 0) + 1,
      },
    })),
  clearPendingAppendAndRun: () => set({ pendingAppendAndRun: null }),

  consoleRuntime: {},

  primedRanges: {},
  setPrimedRange: (consoleId, range) =>
    set((state) => {
      const existing = state.primedRanges[consoleId];
      if (range === null) {
        if (!existing) return state;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [consoleId]: _dropped, ...rest } = state.primedRanges;
        return { primedRanges: rest };
      }
      if (
        existing &&
        existing.from === range.from &&
        existing.to === range.to &&
        existing.scratchHash === range.scratchHash
      ) {
        return state;
      }
      return {
        primedRanges: { ...state.primedRanges, [consoleId]: range },
      };
    }),

  hydrateConsoleRuntime: (id, init) =>
    set((state) => {
      if (state.consoleRuntime[id]) return state;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: { ...DEFAULT_RUNTIME, ...init },
        },
      };
    }),
  setScratch: (id, scratch) =>
    set((state) => {
      const prev = state.consoleRuntime[id] ?? DEFAULT_RUNTIME;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: { ...prev, scratch },
        },
      };
    }),
  setRunStarted: (id, queryId) =>
    set((state) => {
      const prev = state.consoleRuntime[id] ?? DEFAULT_RUNTIME;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: {
            ...prev,
            execStatus: "running",
            execError: null,
            runningQueryId: queryId,
          },
        },
      };
    }),
  setRunOk: (id, result) =>
    set((state) => {
      const prev = state.consoleRuntime[id] ?? DEFAULT_RUNTIME;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: {
            ...prev,
            execStatus: "ok",
            execError: null,
            lastResult: result,
            gridState: DEFAULT_GRID_STATE,
            runningQueryId: null,
          },
        },
      };
    }),
  setRunError: (id, message) =>
    set((state) => {
      const prev = state.consoleRuntime[id] ?? DEFAULT_RUNTIME;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: {
            ...prev,
            execStatus: "error",
            execError: message,
            runningQueryId: null,
          },
        },
      };
    }),
  setGridState: (id, gridState) =>
    set((state) => {
      const prev = state.consoleRuntime[id];
      if (!prev) return state;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: { ...prev, gridState },
        },
      };
    }),
  setHistory: (id, entries) =>
    set((state) => {
      const prev = state.consoleRuntime[id];
      if (!prev) return state;
      return {
        consoleRuntime: {
          ...state.consoleRuntime,
          [id]: { ...prev, history: entries },
        },
      };
    }),
}));
