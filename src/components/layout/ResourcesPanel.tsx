import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Database as DbIcon,
  FilePlus,
  FileText,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useDataSource } from "@/datasource/context";
import { useAppState } from "@/store/appState";
import type {
  Column,
  Connection,
  Database,
  STable,
  Table,
} from "@/datasource/types";
import { cn } from "@/lib/utils";
import { useCreateConsole } from "@/components/console/useCreateConsole";
import {
  buildDrop,
  quoteIdent,
  type DropKind,
} from "@/components/console/ddlBuilder";
import { ConnectionFormDialog } from "@/components/layout/ConnectionFormDialog";
import { ResourcesFooter } from "@/components/layout/StatusBar";
import {
  TableDesignerDialog,
  type DesignerMode,
} from "@/components/layout/TableDesignerDialog";
import {
  loadPersistedExpansion,
  pruneByConnIds,
  savePersistedExpansion,
} from "@/components/layout/treeExpandPersist";
import { confirm } from "@/components/ui/confirm";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const CHILD_PAGE_SIZE = 50;

/** Small chip next to each connection name indicating which transport the
 *  connection uses. When `reconnecting` is true (backend is mid-reconnect),
 *  it picks up an amber tint and shows a spinner so the user has visible
 *  confirmation that a transient ws drop is being recovered. */
function TransportBadge({
  transport,
  reconnecting,
}: {
  transport: "http" | "ws";
  reconnecting: boolean;
}) {
  const { t } = useTranslation("connection");
  const label = transport === "ws" ? "WS" : "HTTP";
  const tooltipKey =
    transport === "ws"
      ? "resources-panel.transport-badge.tooltip.ws"
      : "resources-panel.transport-badge.tooltip.http";
  return (
    <span
      title={t(tooltipKey)}
      className={cn(
        "ml-1 inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono text-[10px] leading-4 tabular-nums",
        reconnecting
          ? "bg-amber-500/20 text-amber-600 dark:text-amber-300"
          : "bg-muted/40 text-muted-foreground/70",
      )}
    >
      {label}
      {reconnecting ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
      ) : null}
    </span>
  );
}

interface DialogState {
  open: boolean;
  mode: "create" | "edit";
  conn?: Connection;
}

interface DesignerState {
  open: boolean;
  mode: DesignerMode | null;
  connId: string;
  db: string;
  targetName?: string;
  stableName?: string;
}

export interface OpenDesignerArgs {
  mode: DesignerMode;
  connId: string;
  db: string;
  targetName?: string;
  stableName?: string;
}

export interface DropArgs {
  kind: DropKind;
  connId: string;
  db: string;
  name: string;
}

// A single action descriptor rendered identically into both the hover "⋯"
// dropdown and the right-click context menu, so the two menus never drift.
interface MenuAction {
  key: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Render a separator immediately before this item. */
  separatorBefore?: boolean;
}

function DropdownActions({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Fragment key={a.key}>
          {a.separatorBefore && <DropdownMenuSeparator />}
          <DropdownMenuItem
            disabled={a.disabled}
            onSelect={a.onSelect}
            className={cn(
              a.danger && "text-destructive focus:text-destructive",
            )}
          >
            {a.icon}
            {a.label}
          </DropdownMenuItem>
        </Fragment>
      ))}
    </>
  );
}

// The hover "⋯" dropdown shared by every tree row, kept in lock-step with the
// right-click menu by rendering the same MenuAction[].
function TreeRowMenu({
  name,
  actions,
}: {
  name: string;
  actions: MenuAction[];
}) {
  const { t } = useTranslation("connection");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="hidden mr-1 shrink-0 rounded-sm p-1 text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground focus-visible:flex group-hover:flex data-[state=open]:flex"
          aria-label={t("resources-panel.tooltip.actions-for", { name })}
          title={t("resources-panel.tooltip.actions-for", { name })}
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownActions actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextActions({ actions }: { actions: MenuAction[] }) {
  return (
    <>
      {actions.map((a) => (
        <Fragment key={a.key}>
          {a.separatorBefore && <ContextMenuSeparator />}
          <ContextMenuItem
            disabled={a.disabled}
            onSelect={a.onSelect}
            className={cn(
              a.danger && "text-destructive focus:text-destructive",
            )}
          >
            {a.label}
          </ContextMenuItem>
        </Fragment>
      ))}
    </>
  );
}

// The chevron is the ONLY expand affordance: clicking a node's label never
// toggles the tree, only this icon does (and it expands immediately).
function ExpandChevron({
  open,
  onToggle,
  label,
  depth,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  depth: number;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={indentStyle(depth)}
      className="flex shrink-0 items-center py-1 pr-1 text-muted-foreground/80 hover:text-foreground"
      aria-label={label}
      aria-expanded={open}
    >
      {open ? (
        <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronRight className="h-3 w-3" />
      )}
    </button>
  );
}

// Indentation is applied to a row's *content* (not the row box), so the
// highlight pill always spans the full panel width regardless of nesting depth.
const ROW_INDENT_STEP = 16;
const ROW_INDENT_BASE = 8;
function indentStyle(depth: number) {
  return { paddingLeft: ROW_INDENT_BASE + depth * ROW_INDENT_STEP };
}

// Single-selection highlight shared across the whole tree. Clicking a node's
// label selects it (visual highlight); expansion stays on the chevron /
// double-click. A context keeps every nested row in sync without prop drilling.
const SelectionContext = createContext<{
  selected: string | null;
  select: (key: string) => void;
}>({ selected: null, select: () => {} });

function useSelection() {
  return useContext(SelectionContext);
}

// Row container styling: an inset, rounded full-width pill that highlights when
// selected and on hover (with a small side gap from the panel edges).
function rowClass(selected: boolean) {
  return cn(
    "group mx-1 flex items-center rounded-md",
    selected
      ? "bg-accent text-foreground"
      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
  );
}

type ColumnsState = Column[] | "loading" | "error";

interface ChildLoadState {
  items: Table[];
  /** Definite total once known (last page came back short, or the async
   *  `countTables` round-trip resolved). `undefined` while the total is
   *  unknown — usually paired with `countLoading: true`. */
  total?: number;
  /** True while the async `countTables` query is in flight. */
  countLoading: boolean;
  nextPage: number;
  loading: boolean;
  error: string | null;
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/30 px-0.5 text-foreground">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function nameMatches(name: string, q: string): boolean {
  if (!q) return true;
  return name.toLowerCase().includes(q.toLowerCase());
}

export function ResourcesPanel() {
  const { t } = useTranslation("connection");
  const { t: td } = useTranslation("designer");
  const ds = useDataSource();
  const connections = useAppState((s) => s.connections);
  const setConnections = useAppState((s) => s.setConnections);
  const connectionRuntime = useAppState((s) => s.connectionRuntime);
  const consoles = useAppState((s) => s.consoles);
  const setActiveConsole = useAppState((s) => s.setActiveConsole);
  const removeConsolesByConnection = useAppState(
    (s) => s.removeConsolesByConnection,
  );
  const resourceFocus = useAppState((s) => s.resourceFocus);
  const pulseActiveConsole = useAppState((s) => s.pulseActiveConsole);
  const requestAppendAndRun = useAppState((s) => s.requestAppendAndRun);
  const createConsole = useCreateConsole();

  // Double-click a database: reuse the existing console bound to that db if
  // there is one, otherwise create and open a fresh one bound to it. Either
  // way the console side should flash — when reusing the already-active one
  // its id doesn't change, so pulse explicitly to still draw the eye.
  function openConsoleForDb(connId: string, db: string) {
    const existing = consoles.find(
      (c) => c.connectionId === connId && c.currentDb === db,
    );
    if (existing) {
      setActiveConsole(existing.id);
      pulseActiveConsole();
    } else {
      void createConsole(connId, { db });
    }
  }

  // Double-click a (sub)table: reuse or create a console bound to its db
  // (mirroring openConsoleForDb), then queue a `SELECT * FROM <table>;` to be
  // appended to the editor and executed once the editor is ready.
  async function openQueryForTable(connId: string, db: string, table: string) {
    const sql = `SELECT * FROM ${quoteIdent(table)};`;
    const existing = consoles.find(
      (c) => c.connectionId === connId && c.currentDb === db,
    );
    let targetId: string;
    if (existing) {
      setActiveConsole(existing.id);
      pulseActiveConsole();
      targetId = existing.id;
    } else {
      const created = await createConsole(connId, { db });
      targetId = created.id;
    }
    requestAppendAndRun(targetId, sql);
  }

  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<DialogState>({
    open: false,
    mode: "create",
  });
  const [designer, setDesigner] = useState<DesignerState>({
    open: false,
    mode: null,
    connId: "",
    db: "",
  });

  function openDesigner(args: OpenDesignerArgs) {
    setDesigner({ open: true, ...args });
  }

  function refreshAfterSchemaChange(connId: string, db: string) {
    void handleRefreshDatabase(connId, db);
  }

  function handleDesignerSaved() {
    if (designer.mode === "create-database") {
      const c = connections.find((x) => x.id === designer.connId);
      if (c) void handleRefreshConnection(c);
    } else {
      refreshAfterSchemaChange(designer.connId, designer.db);
    }
  }

  async function handleDrop(args: DropArgs) {
    const ok = await confirm({
      title: td(`drop-confirm.${args.kind}-title`, { name: args.name }),
      description: td(`drop-confirm.${args.kind}-description`),
      confirmLabel: td("drop-confirm.confirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      const db = args.kind === "database" ? null : args.db;
      await ds.runSql(
        args.connId,
        db,
        buildDrop(args.kind, args.db, args.name),
      );
      toast.success(td("toast.dropped"));
      if (args.kind === "database") {
        const c = connections.find((x) => x.id === args.connId);
        if (c) void handleRefreshConnection(c);
      } else {
        refreshAfterSchemaChange(args.connId, args.db);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Expansion sets keyed by path (lazy-initialized from localStorage).
  // conns: connId
  // dbs:   connId|db
  // tables: connId|db|table  (the table row itself, revealing the group nodes)
  // columns: connId|db|table  (the "Columns & tags" group)
  // children: connId|db|stable (the "Child tables" group)
  const [expandedConns, setExpandedConns] = useState<Set<string>>(
    () => new Set(loadPersistedExpansion().conns),
  );
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(
    () => new Set(loadPersistedExpansion().dbs),
  );
  const [expandedTables, setExpandedTables] = useState<Set<string>>(
    () => new Set(loadPersistedExpansion().tables),
  );
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(
    () => new Set(loadPersistedExpansion().columns),
  );
  const [expandedChildren, setExpandedChildren] = useState<Set<string>>(
    () => new Set(loadPersistedExpansion().children),
  );
  const [restored, setRestored] = useState(false);

  // Lazy caches
  const [dbsByConn, setDbsByConn] = useState<
    Record<string, Database[] | "loading">
  >({});
  const [stablesByDb, setStablesByDb] = useState<
    Record<string, STable[] | "loading">
  >({});
  const [tablesByDb, setTablesByDb] = useState<
    Record<string, Table[] | "loading">
  >({});
  const [columnsByTable, setColumnsByTable] = useState<
    Record<string, ColumnsState>
  >({});
  const [childrenByStable, setChildrenByStable] = useState<
    Record<string, ChildLoadState>
  >({});

  useEffect(() => {
    if (connections.length > 0) return;
    let cancelled = false;
    ds.listConnections().then((list) => {
      if (!cancelled) setConnections(list);
    });
    return () => {
      cancelled = true;
    };
  }, [ds, connections.length, setConnections]);

  useEffect(() => {
    savePersistedExpansion({
      conns: [...expandedConns],
      dbs: [...expandedDbs],
      tables: [...expandedTables],
      columns: [...expandedColumns],
      children: [...expandedChildren],
    });
  }, [
    expandedConns,
    expandedDbs,
    expandedTables,
    expandedColumns,
    expandedChildren,
  ]);

  // One-shot restore: after connections load, prune stale connId-prefixed
  // keys and refetch the data needed to render the persisted expanded paths.
  useEffect(() => {
    if (restored) return;
    if (connections.length === 0) return;

    const valid = new Set(connections.map((c) => c.id));

    const cleanConns = pruneByConnIds([...expandedConns], valid);
    const cleanDbs = pruneByConnIds([...expandedDbs], valid);
    const cleanTables = pruneByConnIds([...expandedTables], valid);
    const cleanColumns = pruneByConnIds([...expandedColumns], valid);
    const cleanChildren = pruneByConnIds([...expandedChildren], valid);

    if (cleanConns.length !== expandedConns.size) {
      setExpandedConns(new Set(cleanConns));
    }
    if (cleanDbs.length !== expandedDbs.size) {
      setExpandedDbs(new Set(cleanDbs));
    }
    if (cleanTables.length !== expandedTables.size) {
      setExpandedTables(new Set(cleanTables));
    }
    if (cleanColumns.length !== expandedColumns.size) {
      setExpandedColumns(new Set(cleanColumns));
    }
    if (cleanChildren.length !== expandedChildren.size) {
      setExpandedChildren(new Set(cleanChildren));
    }

    for (const connId of cleanConns) {
      const conn = connections.find((c) => c.id === connId);
      if (!conn || conn.status !== "online") continue;
      if (dbsByConn[connId]) continue;
      setDbsByConn((prev) => ({ ...prev, [connId]: "loading" }));
      ds.listDatabases(connId)
        .then((list) => {
          setDbsByConn((prev) => ({ ...prev, [connId]: list }));
        })
        .catch(() => {
          setDbsByConn((prev) => ({ ...prev, [connId]: [] }));
        });
    }
    for (const key of cleanDbs) {
      if (stablesByDb[key] || tablesByDb[key]) continue;
      const [connId, db] = key.split("|");
      if (!connId || !db) continue;
      const conn = connections.find((c) => c.id === connId);
      if (!conn || conn.status !== "online") continue;
      setStablesByDb((prev) => ({ ...prev, [key]: "loading" }));
      setTablesByDb((prev) => ({ ...prev, [key]: "loading" }));
      Promise.all([
        ds.listSTables(connId, db),
        ds.listTables(connId, db, { page: 1, pageSize: 200 }),
      ])
        .then(([stbs, paged]) => {
          setStablesByDb((prev) => ({ ...prev, [key]: stbs }));
          setTablesByDb((prev) => ({ ...prev, [key]: paged.items }));
        })
        .catch(() => {
          setStablesByDb((prev) => ({ ...prev, [key]: [] }));
          setTablesByDb((prev) => ({ ...prev, [key]: [] }));
        });
    }
    for (const key of cleanColumns) {
      if (columnsByTable[key]) continue;
      const [connId, db, table] = key.split("|");
      if (!connId || !db || !table) continue;
      void loadColumns(connId, db, table);
    }
    for (const key of cleanChildren) {
      if (childrenByStable[key]) continue;
      const [connId, db, stable] = key.split("|");
      if (!connId || !db || !stable) continue;
      void loadChildren(connId, db, stable);
    }

    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, restored]);

  // Reveal + highlight a database when something elsewhere (e.g. the SQL
  // toolbar's locate button) requests focus: expand its connection, ensure the
  // db list is loaded, select the row, and scroll it into view.
  useEffect(() => {
    if (!resourceFocus) return;
    const { connId, db } = resourceFocus;
    let cancelled = false;
    void (async () => {
      setExpandedConns((prev) =>
        prev.has(connId) ? prev : new Set([...prev, connId]),
      );
      if (!dbsByConn[connId]) {
        setDbsByConn((prev) => ({ ...prev, [connId]: "loading" }));
        try {
          const list = await ds.listDatabases(connId);
          if (cancelled) return;
          setDbsByConn((prev) => ({ ...prev, [connId]: list }));
        } catch {
          if (!cancelled) setDbsByConn((prev) => ({ ...prev, [connId]: [] }));
        }
      }
      if (cancelled) return;
      const key = `db|${connId}|${db}`;
      setSelectedKey(key);
      setTimeout(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-rkey="${CSS.escape(key)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      }, 60);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceFocus?.nonce]);

  // Filter-induced auto-expansion: when filter is active, every loaded level
  // is visible regardless of explicit expansion state.
  const filterActive = query.trim() !== "";

  async function refreshConnections() {
    const list = await ds.listConnections();
    setConnections(list);
  }

  function clearConnCache(connId: string) {
    setDbsByConn((prev) => {
      const next = { ...prev };
      delete next[connId];
      return next;
    });
    const dropPrefix = <V,>(
      map: Record<string, V>,
      prefix: string,
    ): Record<string, V> =>
      Object.fromEntries(
        Object.entries(map).filter(([k]) => !k.startsWith(prefix)),
      );
    const prefix = `${connId}|`;
    setStablesByDb((prev) => dropPrefix(prev, prefix));
    setTablesByDb((prev) => dropPrefix(prev, prefix));
    setColumnsByTable((prev) => dropPrefix(prev, prefix));
    setChildrenByStable((prev) => dropPrefix(prev, prefix));
  }

  /** Drop every entry in a Set whose key starts with the given prefix. Used
   *  to cascade-collapse all descendants when a parent is collapsed or its
   *  connection is refreshed — we deliberately discard the prior expanded
   *  state so re-opening shows a clean fully-collapsed sub-tree. */
  function pruneExpandedByPrefix(prefix: string) {
    const drop = (prev: Set<string>) => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (k.startsWith(prefix)) {
          changed = true;
          continue;
        }
        next.add(k);
      }
      return changed ? next : prev;
    };
    setExpandedDbs(drop);
    setExpandedTables(drop);
    setExpandedColumns(drop);
    setExpandedChildren(drop);
  }

  async function handleDeleteConnection(c: Connection) {
    const consoleCount = consoles.filter((k) => k.connectionId === c.id).length;
    const ok = await confirm({
      title: t("resources-panel.delete-confirm.title", { name: c.name }),
      description: t("resources-panel.delete-confirm.description", {
        count: consoleCount,
      }),
      confirmLabel: t("resources-panel.context-menu.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await ds.deleteConnection(c.id);
      removeConsolesByConnection(c.id);
      await refreshConnections();
      clearConnCache(c.id);
      toast.success(t("toast.deleted"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    }
  }

  async function handleRefreshConnection(c: Connection) {
    if (c.status === "offline") {
      toast.error(t("toast.offline", { name: c.name }));
      return;
    }
    clearConnCache(c.id);
    // Refresh wipes every cached descendant; collapse the matching expand
    // state so the user gets a clean re-render rather than empty placeholders
    // for the previously-expanded nodes.
    pruneExpandedByPrefix(`${c.id}|`);
    setExpandedConns((prev) => {
      if (prev.has(c.id)) return prev;
      const next = new Set(prev);
      next.add(c.id);
      return next;
    });
    setDbsByConn((prev) => ({ ...prev, [c.id]: "loading" }));
    try {
      const list = await ds.listDatabases(c.id);
      setDbsByConn((prev) => ({ ...prev, [c.id]: list }));
      toast.success(t("toast.refreshed", { name: c.name }));
    } catch (err) {
      setDbsByConn((prev) => ({ ...prev, [c.id]: [] }));
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    }
  }

  async function handleRefreshDatabase(connId: string, db: string) {
    const key = `${connId}|${db}`;
    setExpandedDbs((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
    const dropDbPrefix = `${key}|`;
    setColumnsByTable((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([k]) => !k.startsWith(dropDbPrefix)),
      ),
    );
    setChildrenByStable((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([k]) => !k.startsWith(dropDbPrefix)),
      ),
    );
    // Collapse every descendant of this database; re-expanding starts fresh.
    pruneExpandedByPrefix(dropDbPrefix);
    setStablesByDb((prev) => ({ ...prev, [key]: "loading" }));
    setTablesByDb((prev) => ({ ...prev, [key]: "loading" }));

    try {
      const [stbs, paged] = await Promise.all([
        ds.listSTables(connId, db),
        ds.listTables(connId, db, { page: 1, pageSize: 200 }),
      ]);
      setStablesByDb((prev) => ({ ...prev, [key]: stbs }));
      setTablesByDb((prev) => ({ ...prev, [key]: paged.items }));
      toast.success(t("toast.refreshed", { name: db }));
    } catch (err) {
      setStablesByDb((prev) => ({ ...prev, [key]: [] }));
      setTablesByDb((prev) => ({ ...prev, [key]: [] }));
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    }
  }

  async function toggleConn(c: Connection) {
    const isOpen = expandedConns.has(c.id);
    setExpandedConns((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
    if (isOpen) {
      // Collapsing the connection cascades collapse to every descendant —
      // next time the user expands, the sub-tree starts fully collapsed.
      pruneExpandedByPrefix(`${c.id}|`);
      return;
    }
    if (c.status === "offline") return;
    if (dbsByConn[c.id]) return;
    setDbsByConn((prev) => ({ ...prev, [c.id]: "loading" }));
    try {
      const list = await ds.listDatabases(c.id);
      setDbsByConn((prev) => ({ ...prev, [c.id]: list }));
    } catch {
      setDbsByConn((prev) => ({ ...prev, [c.id]: [] }));
    }
  }

  async function toggleDb(connId: string, db: string) {
    const key = `${connId}|${db}`;
    const isOpen = expandedDbs.has(key);
    setExpandedDbs((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    if (isOpen) {
      pruneExpandedByPrefix(`${key}|`);
      return;
    }
    if (stablesByDb[key] || tablesByDb[key]) return;
    setStablesByDb((prev) => ({ ...prev, [key]: "loading" }));
    setTablesByDb((prev) => ({ ...prev, [key]: "loading" }));
    try {
      const [stbs, paged] = await Promise.all([
        ds.listSTables(connId, db),
        ds.listTables(connId, db, { page: 1, pageSize: 200 }),
      ]);
      setStablesByDb((prev) => ({ ...prev, [key]: stbs }));
      setTablesByDb((prev) => ({ ...prev, [key]: paged.items }));
    } catch {
      setStablesByDb((prev) => ({ ...prev, [key]: [] }));
      setTablesByDb((prev) => ({ ...prev, [key]: [] }));
    }
  }

  function toggleTable(connId: string, db: string, table: string) {
    const key = `${connId}|${db}|${table}`;
    const wasOpen = expandedTables.has(key);
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (wasOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    if (wasOpen) {
      // Collapsing the table row also collapses its Columns & tags / Child
      // tables panes — re-opening should start cleanly closed.
      setExpandedColumns((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setExpandedChildren((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function toggleColumns(connId: string, db: string, table: string) {
    const key = `${connId}|${db}|${table}`;
    const isOpen = expandedColumns.has(key);
    setExpandedColumns((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!isOpen) void loadColumns(connId, db, table);
  }

  function toggleChildren(connId: string, db: string, stable: string) {
    const key = `${connId}|${db}|${stable}`;
    const isOpen = expandedChildren.has(key);
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!isOpen) void loadChildren(connId, db, stable);
  }

  async function loadColumns(
    connId: string,
    db: string,
    table: string,
    force = false,
  ) {
    const key = `${connId}|${db}|${table}`;
    const existing = columnsByTable[key];
    if (!force && existing && existing !== "error") return;
    setColumnsByTable((prev) => ({ ...prev, [key]: "loading" }));
    try {
      const cols = await ds.describeTable(connId, db, table);
      setColumnsByTable((prev) => ({ ...prev, [key]: cols }));
    } catch {
      setColumnsByTable((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  async function loadChildren(
    connId: string,
    db: string,
    stable: string,
    force = false,
  ) {
    const key = `${connId}|${db}|${stable}`;
    const existing = childrenByStable[key];
    if (!force && existing && !existing.error && existing.items.length > 0)
      return;
    setChildrenByStable((prev) => ({
      ...prev,
      [key]: {
        items: [],
        total: undefined,
        countLoading: false,
        nextPage: 1,
        loading: true,
        error: null,
      },
    }));
    try {
      const paged = await ds.listTables(connId, db, {
        stable,
        page: 1,
        pageSize: CHILD_PAGE_SIZE,
      });
      // Full page back → kick off the async COUNT(*) so the badge fills in
      // later without blocking the items render. Short page → total is
      // already definite and equals items.length.
      const needsCount = paged.total === undefined;
      setChildrenByStable((prev) => ({
        ...prev,
        [key]: {
          items: paged.items,
          total: paged.total,
          countLoading: needsCount,
          nextPage: 2,
          loading: false,
          error: null,
        },
      }));
      if (needsCount) {
        void (async () => {
          try {
            const total = await ds.countTables(connId, db, { stable });
            setChildrenByStable((prev) => {
              const cur = prev[key];
              if (!cur) return prev;
              return {
                ...prev,
                [key]: { ...cur, total, countLoading: false },
              };
            });
          } catch {
            setChildrenByStable((prev) => {
              const cur = prev[key];
              if (!cur) return prev;
              return { ...prev, [key]: { ...cur, countLoading: false } };
            });
          }
        })();
      }
    } catch {
      setChildrenByStable((prev) => ({
        ...prev,
        [key]: {
          items: [],
          total: undefined,
          countLoading: false,
          nextPage: 1,
          loading: false,
          error: t("resources-panel.tree.error"),
        },
      }));
    }
  }

  async function loadMoreChildren(connId: string, db: string, stable: string) {
    const key = `${connId}|${db}|${stable}`;
    const state = childrenByStable[key];
    if (!state || state.loading) return;
    if (state.total !== undefined && state.items.length >= state.total) return;
    setChildrenByStable((prev) => {
      const cur = prev[key];
      if (!cur) return prev;
      return { ...prev, [key]: { ...cur, loading: true, error: null } };
    });
    try {
      const paged = await ds.listTables(connId, db, {
        stable,
        page: state.nextPage,
        pageSize: CHILD_PAGE_SIZE,
      });
      setChildrenByStable((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        // A subsequent page coming back short upgrades us from "unknown" to
        // a definite total — adopt it. Otherwise keep whatever total we had
        // (the async count may already have populated it).
        const total = paged.total !== undefined ? paged.total : cur.total;
        return {
          ...prev,
          [key]: {
            ...cur,
            items: [...cur.items, ...paged.items],
            total,
            nextPage: cur.nextPage + 1,
            loading: false,
            error: null,
          },
        };
      });
    } catch {
      setChildrenByStable((prev) => {
        const cur = prev[key];
        if (!cur) return prev;
        return {
          ...prev,
          [key]: {
            ...cur,
            loading: false,
            error: t("resources-panel.tree.error"),
          },
        };
      });
    }
  }

  const visibleConnections = useMemo(() => {
    if (!filterActive) return connections;
    const q = query.toLowerCase();
    return connections.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      const dbs = dbsByConn[c.id];
      if (Array.isArray(dbs)) {
        for (const db of dbs) {
          if (db.name.toLowerCase().includes(q)) return true;
          const key = `${c.id}|${db.name}`;
          const stbs = stablesByDb[key];
          if (Array.isArray(stbs)) {
            for (const s of stbs) {
              if (s.name.toLowerCase().includes(q)) return true;
            }
          }
          const tbls = tablesByDb[key];
          if (Array.isArray(tbls)) {
            for (const t of tbls) {
              if (t.name.toLowerCase().includes(q)) return true;
            }
          }
          for (const colKey of Object.keys(columnsByTable)) {
            if (colKey.startsWith(`${key}|`)) {
              const cols = columnsByTable[colKey];
              if (Array.isArray(cols)) {
                for (const col of cols) {
                  if (col.name.toLowerCase().includes(q)) return true;
                }
              }
            }
          }
          for (const childKey of Object.keys(childrenByStable)) {
            if (childKey.startsWith(`${key}|`)) {
              const cs = childrenByStable[childKey];
              if (cs) {
                for (const child of cs.items) {
                  if (child.name.toLowerCase().includes(q)) return true;
                }
              }
            }
          }
        }
      }
      return false;
    });
  }, [
    connections,
    filterActive,
    query,
    dbsByConn,
    stablesByDb,
    tablesByDb,
    columnsByTable,
    childrenByStable,
  ]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-[0_2px_8px_-2px_rgba(0,0,0,0.35),inset_0_1px_0_0_hsl(0_0%_100%/0.04)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-gradient-to-b from-white/[0.03] to-transparent pl-3 pr-1">
        <h2 className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide">
          {t("resources-panel.title")}
        </h2>
        <button
          type="button"
          onClick={() => setDialogState({ open: true, mode: "create" })}
          className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-primary hover:bg-muted/50"
          aria-label={t("resources-panel.new")}
          title={t("resources-panel.new")}
        >
          <Plus className="h-4 w-4 shrink-0" />
        </button>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("resources-panel.filter-placeholder")}
          className="h-7 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={t("resources-panel.filter-placeholder")}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <SelectionContext.Provider
        value={{ selected: selectedKey, select: setSelectedKey }}
      >
        <div className="flex-1 select-none overflow-y-auto py-1 text-xs">
          {connections.length === 0 ? (
            <p className="p-3 text-muted-foreground">
              {t("resources-panel.empty")}
            </p>
          ) : visibleConnections.length === 0 ? (
            <p className="px-3 py-1 italic text-muted-foreground/70">
              {t("resources-panel.empty")}
            </p>
          ) : (
            visibleConnections.map((c) => {
              const isOpen = filterActive || expandedConns.has(c.id);
              const isOffline = c.status === "offline";
              const connActions: MenuAction[] = [
                {
                  key: "new-console",
                  icon: <FilePlus className="h-3.5 w-3.5" />,
                  label: t("resources-panel.context-menu.new-console"),
                  disabled: isOffline,
                  onSelect: () => void createConsole(c.id),
                },
                {
                  key: "new-database",
                  icon: <DbIcon className="h-3.5 w-3.5" />,
                  label: t("resources-panel.context-menu.new-database"),
                  disabled: isOffline,
                  onSelect: () =>
                    openDesigner({
                      mode: "create-database",
                      connId: c.id,
                      db: "",
                    }),
                },
                {
                  key: "refresh",
                  separatorBefore: true,
                  icon: <RefreshCw className="h-3.5 w-3.5" />,
                  label: t("resources-panel.context-menu.refresh"),
                  disabled: isOffline,
                  onSelect: () => void handleRefreshConnection(c),
                },
                {
                  key: "edit",
                  icon: <Pencil className="h-3.5 w-3.5" />,
                  label: t("resources-panel.context-menu.edit"),
                  onSelect: () =>
                    setDialogState({ open: true, mode: "edit", conn: c }),
                },
                {
                  key: "delete",
                  separatorBefore: true,
                  icon: <Trash2 className="h-3.5 w-3.5" />,
                  label: t("resources-panel.context-menu.delete"),
                  danger: true,
                  onSelect: () => void handleDeleteConnection(c),
                },
              ];
              const connKey = `conn|${c.id}`;
              return (
                <div key={c.id}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className={rowClass(selectedKey === connKey)}>
                        <ExpandChevron
                          open={isOpen}
                          onToggle={() => void toggleConn(c)}
                          label={c.name}
                          depth={0}
                        />
                        <div
                          onClick={() => setSelectedKey(connKey)}
                          onDoubleClick={() => void toggleConn(c)}
                          className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2"
                        >
                          <span
                            className="min-w-0 truncate font-medium"
                            title={c.name}
                          >
                            {highlight(c.name, query)}
                          </span>
                          <TransportBadge
                            transport={c.transport}
                            reconnecting={
                              connectionRuntime[c.id]?.reconnecting ?? false
                            }
                          />
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              className="hidden mr-1 shrink-0 rounded-sm p-1 text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground focus-visible:flex group-hover:flex data-[state=open]:flex"
                              aria-label={t(
                                "resources-panel.tooltip.actions-for",
                                {
                                  name: c.name,
                                },
                              )}
                              title={t("resources-panel.tooltip.actions-for", {
                                name: c.name,
                              })}
                            >
                              <MoreHorizontal className="h-3 w-3" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownActions actions={connActions} />
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextActions actions={connActions} />
                    </ContextMenuContent>
                  </ContextMenu>

                  {isOpen && (
                    <ConnectionBody
                      conn={c}
                      query={query}
                      filterActive={filterActive}
                      dbsByConn={dbsByConn}
                      stablesByDb={stablesByDb}
                      tablesByDb={tablesByDb}
                      expandedDbs={expandedDbs}
                      expandedTables={expandedTables}
                      expandedColumns={expandedColumns}
                      expandedChildren={expandedChildren}
                      columnsByTable={columnsByTable}
                      childrenByStable={childrenByStable}
                      onToggleDb={toggleDb}
                      onRefreshDb={handleRefreshDatabase}
                      onCreateConsoleInDb={(connId, db) =>
                        void createConsole(connId, { db })
                      }
                      onOpenConsoleForDb={openConsoleForDb}
                      onOpenQueryForTable={(connId, db, table) =>
                        void openQueryForTable(connId, db, table)
                      }
                      onToggleTable={toggleTable}
                      onToggleColumns={toggleColumns}
                      onToggleChildren={toggleChildren}
                      onLoadMoreChildren={loadMoreChildren}
                      onRefreshColumns={(connId, db, table) =>
                        void loadColumns(connId, db, table, true)
                      }
                      onRefreshChildren={(connId, db, stable) =>
                        void loadChildren(connId, db, stable, true)
                      }
                      onOpenDesigner={openDesigner}
                      onDrop={handleDrop}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </SelectionContext.Provider>

      <ResourcesFooter />

      <ConnectionFormDialog
        open={dialogState.open}
        mode={dialogState.mode}
        initial={dialogState.conn}
        onOpenChange={(open) => setDialogState((s) => ({ ...s, open }))}
        onSaved={() => {
          void refreshConnections();
        }}
      />

      <TableDesignerDialog
        open={designer.open}
        mode={designer.mode}
        connId={designer.connId}
        db={designer.db}
        targetName={designer.targetName}
        stableName={designer.stableName}
        onOpenChange={(open) => setDesigner((s) => ({ ...s, open }))}
        onSaved={handleDesignerSaved}
      />
    </section>
  );
}

interface ConnectionBodyProps {
  conn: Connection;
  query: string;
  filterActive: boolean;
  dbsByConn: Record<string, Database[] | "loading">;
  stablesByDb: Record<string, STable[] | "loading">;
  tablesByDb: Record<string, Table[] | "loading">;
  expandedDbs: Set<string>;
  expandedTables: Set<string>;
  expandedColumns: Set<string>;
  expandedChildren: Set<string>;
  columnsByTable: Record<string, ColumnsState>;
  childrenByStable: Record<string, ChildLoadState>;
  onToggleDb: (connId: string, db: string) => void;
  onRefreshDb: (connId: string, db: string) => void;
  onCreateConsoleInDb: (connId: string, db: string) => void;
  onOpenConsoleForDb: (connId: string, db: string) => void;
  onOpenQueryForTable: (connId: string, db: string, table: string) => void;
  onToggleTable: (connId: string, db: string, table: string) => void;
  onToggleColumns: (connId: string, db: string, table: string) => void;
  onToggleChildren: (connId: string, db: string, stable: string) => void;
  onLoadMoreChildren: (connId: string, db: string, stable: string) => void;
  onRefreshColumns: (connId: string, db: string, table: string) => void;
  onRefreshChildren: (connId: string, db: string, stable: string) => void;
  onOpenDesigner: (args: OpenDesignerArgs) => void;
  onDrop: (args: DropArgs) => void;
}

function ConnectionBody({
  conn,
  query,
  filterActive,
  dbsByConn,
  stablesByDb,
  tablesByDb,
  expandedDbs,
  expandedTables,
  expandedColumns,
  expandedChildren,
  columnsByTable,
  childrenByStable,
  onToggleDb,
  onRefreshDb,
  onCreateConsoleInDb,
  onOpenConsoleForDb,
  onOpenQueryForTable,
  onToggleTable,
  onToggleColumns,
  onToggleChildren,
  onLoadMoreChildren,
  onRefreshColumns,
  onRefreshChildren,
  onOpenDesigner,
  onDrop,
}: ConnectionBodyProps) {
  const { t } = useTranslation("connection");
  const { selected, select } = useSelection();
  const resourceFocus = useAppState((s) => s.resourceFocus);
  // Double-click a database label opens a console and toggles the node, so it
  // expands/collapses just like every other row's double-click.
  function handleDbDoubleClick(db: string) {
    onOpenConsoleForDb(conn.id, db);
    onToggleDb(conn.id, db);
  }
  if (conn.status === "offline") {
    return (
      <div>
        <p
          style={indentStyle(1)}
          className="py-1 pr-3 text-[11px] italic text-muted-foreground/70"
        >
          {t("resources-panel.tree.disconnected")}
        </p>
      </div>
    );
  }
  const dbs = dbsByConn[conn.id];
  if (dbs === undefined) return null;
  if (dbs === "loading") {
    return (
      <div>
        <p
          style={indentStyle(1)}
          className="py-1 pr-3 text-[11px] text-muted-foreground"
        >
          {t("resources-panel.tree.loading")}
        </p>
      </div>
    );
  }
  if (dbs.length === 0) {
    return (
      <div>
        <p
          style={indentStyle(1)}
          className="py-1 pr-3 text-[11px] italic text-muted-foreground/70"
        >
          {t("resources-panel.tree.no-databases")}
        </p>
      </div>
    );
  }
  return (
    <div>
      {dbs.map((db) => {
        const dbKey = `${conn.id}|${db.name}`;
        const dbOpen = filterActive || expandedDbs.has(dbKey);
        const dbActions: MenuAction[] = [
          {
            key: "new-console",
            icon: <FilePlus className="h-3.5 w-3.5" />,
            label: t("resources-panel.context-menu.new-console"),
            onSelect: () => onCreateConsoleInDb(conn.id, db.name),
          },
          {
            key: "new-stable",
            icon: <Layers className="h-3.5 w-3.5" />,
            label: t("resources-panel.context-menu.new-stable"),
            onSelect: () =>
              onOpenDesigner({
                mode: "create-stable",
                connId: conn.id,
                db: db.name,
              }),
          },
          {
            key: "new-table",
            icon: <FileText className="h-3.5 w-3.5" />,
            label: t("resources-panel.context-menu.new-table"),
            onSelect: () =>
              onOpenDesigner({
                mode: "create-table",
                connId: conn.id,
                db: db.name,
              }),
          },
          {
            key: "refresh",
            separatorBefore: true,
            icon: <RefreshCw className="h-3.5 w-3.5" />,
            label: t("resources-panel.context-menu.refresh"),
            onSelect: () => onRefreshDb(conn.id, db.name),
          },
          {
            key: "drop-database",
            separatorBefore: true,
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: t("resources-panel.context-menu.drop-database"),
            danger: true,
            onSelect: () =>
              onDrop({
                kind: "database",
                connId: conn.id,
                db: db.name,
                name: db.name,
              }),
          },
        ];
        const dbRowKey = `db|${conn.id}|${db.name}`;
        const doFocusFlash =
          resourceFocus?.connId === conn.id && resourceFocus?.db === db.name;
        return (
          <div key={db.name}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  key={doFocusFlash ? `flash-${resourceFocus.nonce}` : dbRowKey}
                  data-rkey={dbRowKey}
                  className={cn(
                    rowClass(selected === dbRowKey),
                    doFocusFlash && "animate-attention-flash",
                  )}
                >
                  <ExpandChevron
                    open={dbOpen}
                    onToggle={() => onToggleDb(conn.id, db.name)}
                    label={db.name}
                    depth={1}
                  />
                  <div
                    onClick={() => select(dbRowKey)}
                    onDoubleClick={() => handleDbDoubleClick(db.name)}
                    className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2"
                    title={db.name}
                  >
                    <DbIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      {highlight(db.name, query)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenConsoleForDb(conn.id, db.name);
                    }}
                    className="hidden shrink-0 rounded-sm p-1 text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground focus-visible:flex group-hover:flex"
                    aria-label={t("resources-panel.tooltip.open-console", {
                      name: db.name,
                    })}
                    title={t("resources-panel.tooltip.open-console", {
                      name: db.name,
                    })}
                  >
                    <Crosshair className="h-3 w-3" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => e.stopPropagation()}
                        className="hidden mr-1 shrink-0 rounded-sm p-1 text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground focus-visible:flex group-hover:flex data-[state=open]:flex"
                        aria-label={t("resources-panel.tooltip.actions-for", {
                          name: db.name,
                        })}
                        title={t("resources-panel.tooltip.actions-for", {
                          name: db.name,
                        })}
                      >
                        <MoreHorizontal className="h-3 w-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownActions actions={dbActions} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextActions actions={dbActions} />
              </ContextMenuContent>
            </ContextMenu>
            {dbOpen && (
              <DatabaseBody
                connId={conn.id}
                dbName={db.name}
                query={query}
                filterActive={filterActive}
                stablesByDb={stablesByDb}
                tablesByDb={tablesByDb}
                expandedTables={expandedTables}
                expandedColumns={expandedColumns}
                expandedChildren={expandedChildren}
                columnsByTable={columnsByTable}
                childrenByStable={childrenByStable}
                onToggleTable={onToggleTable}
                onToggleColumns={onToggleColumns}
                onToggleChildren={onToggleChildren}
                onLoadMoreChildren={onLoadMoreChildren}
                onRefreshColumns={onRefreshColumns}
                onRefreshChildren={onRefreshChildren}
                onOpenDesigner={onOpenDesigner}
                onOpenQueryForTable={onOpenQueryForTable}
                onDrop={onDrop}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface DatabaseBodyProps {
  connId: string;
  dbName: string;
  query: string;
  filterActive: boolean;
  stablesByDb: Record<string, STable[] | "loading">;
  tablesByDb: Record<string, Table[] | "loading">;
  expandedTables: Set<string>;
  expandedColumns: Set<string>;
  expandedChildren: Set<string>;
  columnsByTable: Record<string, ColumnsState>;
  childrenByStable: Record<string, ChildLoadState>;
  onToggleTable: (connId: string, db: string, table: string) => void;
  onToggleColumns: (connId: string, db: string, table: string) => void;
  onToggleChildren: (connId: string, db: string, stable: string) => void;
  onLoadMoreChildren: (connId: string, db: string, stable: string) => void;
  onRefreshColumns: (connId: string, db: string, table: string) => void;
  onRefreshChildren: (connId: string, db: string, stable: string) => void;
  onOpenDesigner: (args: OpenDesignerArgs) => void;
  onOpenQueryForTable: (connId: string, db: string, table: string) => void;
  onDrop: (args: DropArgs) => void;
}

function DatabaseBody({
  connId,
  dbName,
  query,
  filterActive,
  stablesByDb,
  tablesByDb,
  expandedTables,
  expandedColumns,
  expandedChildren,
  columnsByTable,
  childrenByStable,
  onToggleTable,
  onToggleColumns,
  onToggleChildren,
  onLoadMoreChildren,
  onRefreshColumns,
  onRefreshChildren,
  onOpenDesigner,
  onOpenQueryForTable,
  onDrop,
}: DatabaseBodyProps) {
  const { t: tr } = useTranslation("connection");
  const { selected, select } = useSelection();
  const dbKey = `${connId}|${dbName}`;
  const stbs = stablesByDb[dbKey];
  const tbls = tablesByDb[dbKey];
  if (stbs === "loading" || tbls === "loading" || !stbs || !tbls) {
    return (
      <div>
        <p
          style={indentStyle(2)}
          className="py-1 pr-3 text-[11px] text-muted-foreground"
        >
          {tr("resources-panel.tree.loading")}
        </p>
      </div>
    );
  }
  const visibleStables = stbs.filter((s) => nameMatches(s.name, query));
  const visibleTables = tbls.filter((t) => nameMatches(t.name, query));
  if (stbs.length === 0 && tbls.length === 0) {
    return (
      <div>
        <p
          style={indentStyle(2)}
          className="py-1 pr-3 italic text-muted-foreground/70"
        >
          {tr("resources-panel.tree.no-tables")}
        </p>
      </div>
    );
  }
  return (
    <div>
      {visibleStables.map((stb) => {
        const tblKey = `${connId}|${dbName}|${stb.name}`;
        const tblOpen = filterActive || expandedTables.has(tblKey);
        const editArgs: OpenDesignerArgs = {
          mode: "alter-stable",
          connId,
          db: dbName,
          targetName: stb.name,
        };
        const stableActions: MenuAction[] = [
          {
            key: "edit-stable",
            icon: <Pencil className="h-3.5 w-3.5" />,
            label: tr("resources-panel.context-menu.edit-stable"),
            onSelect: () => onOpenDesigner(editArgs),
          },
          {
            key: "new-child",
            icon: <FileText className="h-3.5 w-3.5" />,
            label: tr("resources-panel.context-menu.new-child"),
            onSelect: () =>
              onOpenDesigner({
                mode: "create-child",
                connId,
                db: dbName,
                stableName: stb.name,
              }),
          },
          {
            key: "drop-stable",
            separatorBefore: true,
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: tr("resources-panel.context-menu.drop-stable"),
            danger: true,
            onSelect: () =>
              onDrop({ kind: "stable", connId, db: dbName, name: stb.name }),
          },
        ];
        const stbRowKey = `tbl|${tblKey}`;
        return (
          <div key={stb.name}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className={rowClass(selected === stbRowKey)}>
                  <ExpandChevron
                    open={tblOpen}
                    onToggle={() => onToggleTable(connId, dbName, stb.name)}
                    label={stb.name}
                    depth={2}
                  />
                  <div
                    onClick={() => select(stbRowKey)}
                    onDoubleClick={() =>
                      onToggleTable(connId, dbName, stb.name)
                    }
                    className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2"
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate" title={stb.name}>
                      {highlight(stb.name, query)}
                    </span>
                    <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-muted-foreground/70">
                      {tr("resources-panel.tree.stable-badge")}
                    </span>
                  </div>
                  <TreeRowMenu name={stb.name} actions={stableActions} />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextActions actions={stableActions} />
              </ContextMenuContent>
            </ContextMenu>
            {tblOpen && (
              <TableBody
                connId={connId}
                dbName={dbName}
                tableName={stb.name}
                isStable
                editArgs={editArgs}
                query={query}
                filterActive={filterActive}
                expandedColumns={expandedColumns}
                expandedChildren={expandedChildren}
                columnsByTable={columnsByTable}
                childrenByStable={childrenByStable}
                onToggleColumns={onToggleColumns}
                onToggleChildren={onToggleChildren}
                onLoadMoreChildren={onLoadMoreChildren}
                onRefreshColumns={onRefreshColumns}
                onRefreshChildren={onRefreshChildren}
                onOpenDesigner={onOpenDesigner}
                onOpenQueryForTable={onOpenQueryForTable}
                onDrop={onDrop}
              />
            )}
          </div>
        );
      })}
      {visibleStables.length === 0 && stbs.length > 0 && (
        <p
          style={indentStyle(2)}
          className="py-1 pr-3 italic text-muted-foreground/70"
        >
          {tr("resources-panel.tree.no-matches")}
        </p>
      )}

      {visibleTables.map((tbl) => {
        const tblKey = `${connId}|${dbName}|${tbl.name}`;
        const tblOpen = filterActive || expandedTables.has(tblKey);
        const editArgs: OpenDesignerArgs = {
          mode: tbl.isChild ? "alter-child-tags" : "alter-table",
          connId,
          db: dbName,
          targetName: tbl.name,
          stableName: tbl.stableName,
        };
        const tableActions: MenuAction[] = [
          {
            key: "edit",
            icon: <Pencil className="h-3.5 w-3.5" />,
            label: tbl.isChild
              ? tr("resources-panel.context-menu.edit-child-tags")
              : tr("resources-panel.context-menu.edit-table"),
            onSelect: () => onOpenDesigner(editArgs),
          },
          {
            key: "drop-table",
            separatorBefore: true,
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: tr("resources-panel.context-menu.drop-table"),
            danger: true,
            onSelect: () =>
              onDrop({ kind: "table", connId, db: dbName, name: tbl.name }),
          },
        ];
        const tblRowKey = `tbl|${tblKey}`;
        return (
          <div key={tbl.name}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className={rowClass(selected === tblRowKey)}>
                  <ExpandChevron
                    open={tblOpen}
                    onToggle={() => onToggleTable(connId, dbName, tbl.name)}
                    label={tbl.name}
                    depth={2}
                  />
                  <div
                    onClick={() => select(tblRowKey)}
                    onDoubleClick={() =>
                      onToggleTable(connId, dbName, tbl.name)
                    }
                    className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate" title={tbl.name}>
                      {highlight(tbl.name, query)}
                    </span>
                  </div>
                  <TreeRowMenu name={tbl.name} actions={tableActions} />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextActions actions={tableActions} />
              </ContextMenuContent>
            </ContextMenu>
            {tblOpen && (
              <TableBody
                connId={connId}
                dbName={dbName}
                tableName={tbl.name}
                isStable={false}
                editArgs={editArgs}
                query={query}
                filterActive={filterActive}
                expandedColumns={expandedColumns}
                expandedChildren={expandedChildren}
                columnsByTable={columnsByTable}
                childrenByStable={childrenByStable}
                onToggleColumns={onToggleColumns}
                onToggleChildren={onToggleChildren}
                onLoadMoreChildren={onLoadMoreChildren}
                onRefreshColumns={onRefreshColumns}
                onRefreshChildren={onRefreshChildren}
                onOpenDesigner={onOpenDesigner}
                onOpenQueryForTable={onOpenQueryForTable}
                onDrop={onDrop}
              />
            )}
          </div>
        );
      })}
      {visibleTables.length === 0 && tbls.length > 0 && (
        <p
          style={indentStyle(2)}
          className="py-1 pr-3 italic text-muted-foreground/70"
        >
          {tr("resources-panel.tree.no-matches")}
        </p>
      )}
    </div>
  );
}

interface TableBodyProps {
  connId: string;
  dbName: string;
  tableName: string;
  isStable: boolean;
  editArgs: OpenDesignerArgs;
  query: string;
  filterActive: boolean;
  expandedColumns: Set<string>;
  expandedChildren: Set<string>;
  columnsByTable: Record<string, ColumnsState>;
  childrenByStable: Record<string, ChildLoadState>;
  onToggleColumns: (connId: string, db: string, table: string) => void;
  onToggleChildren: (connId: string, db: string, stable: string) => void;
  onLoadMoreChildren: (connId: string, db: string, stable: string) => void;
  onRefreshColumns: (connId: string, db: string, table: string) => void;
  onRefreshChildren: (connId: string, db: string, stable: string) => void;
  onOpenDesigner: (args: OpenDesignerArgs) => void;
  onOpenQueryForTable: (connId: string, db: string, table: string) => void;
  onDrop: (args: DropArgs) => void;
}

function TableBody({
  connId,
  dbName,
  tableName,
  isStable,
  editArgs,
  query,
  filterActive,
  expandedColumns,
  expandedChildren,
  columnsByTable,
  childrenByStable,
  onToggleColumns,
  onToggleChildren,
  onLoadMoreChildren,
  onRefreshColumns,
  onRefreshChildren,
  onOpenDesigner,
  onOpenQueryForTable,
  onDrop,
}: TableBodyProps) {
  const { t } = useTranslation("connection");
  const { selected, select } = useSelection();
  const key = `${connId}|${dbName}|${tableName}`;
  const colsKey = `cols|${key}`;
  const childrenKey = `children|${key}`;
  const colsOpen = filterActive || expandedColumns.has(key);
  const childrenOpen = filterActive || expandedChildren.has(key);

  const columnsActions: MenuAction[] = [
    {
      key: "edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      label:
        editArgs.mode === "alter-stable"
          ? t("resources-panel.context-menu.edit-stable")
          : editArgs.mode === "alter-child-tags"
            ? t("resources-panel.context-menu.edit-child-tags")
            : t("resources-panel.context-menu.edit-table"),
      onSelect: () => onOpenDesigner(editArgs),
    },
    {
      key: "refresh",
      separatorBefore: true,
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      label: t("resources-panel.context-menu.refresh"),
      onSelect: () => onRefreshColumns(connId, dbName, tableName),
    },
  ];

  const childrenActions: MenuAction[] = [
    {
      key: "new-child",
      icon: <FileText className="h-3.5 w-3.5" />,
      label: t("resources-panel.context-menu.new-child"),
      onSelect: () =>
        onOpenDesigner({
          mode: "create-child",
          connId,
          db: dbName,
          stableName: tableName,
        }),
    },
    {
      key: "refresh",
      separatorBefore: true,
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      label: t("resources-panel.context-menu.refresh"),
      onSelect: () => onRefreshChildren(connId, dbName, tableName),
    },
  ];

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={rowClass(selected === colsKey)}>
            <ExpandChevron
              open={colsOpen}
              onToggle={() => onToggleColumns(connId, dbName, tableName)}
              label={t("resources-panel.tree.columns-tags")}
              depth={3}
            />
            <div
              onClick={() => select(colsKey)}
              onDoubleClick={() => onToggleColumns(connId, dbName, tableName)}
              className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2"
            >
              <span className="min-w-0 truncate">
                {t("resources-panel.tree.columns-tags")}
              </span>
            </div>
            <TreeRowMenu
              name={t("resources-panel.tree.columns-tags")}
              actions={columnsActions}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextActions actions={columnsActions} />
        </ContextMenuContent>
      </ContextMenu>
      {colsOpen && (
        <ColumnsList state={columnsByTable[key]} query={query} pathKey={key} />
      )}

      {isStable && (
        <>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className={rowClass(selected === childrenKey)}>
                <ExpandChevron
                  open={childrenOpen}
                  onToggle={() => onToggleChildren(connId, dbName, tableName)}
                  label={t("resources-panel.tree.child-tables")}
                  depth={3}
                />
                <div
                  onClick={() => select(childrenKey)}
                  onDoubleClick={() =>
                    onToggleChildren(connId, dbName, tableName)
                  }
                  className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2"
                >
                  <span className="min-w-0 truncate">
                    {t("resources-panel.tree.child-tables")}
                  </span>
                  {(() => {
                    const cs = childrenByStable[key];
                    if (!cs || cs.loading || cs.error) return null;
                    if (cs.total === undefined && !cs.countLoading) return null;
                    const label = cs.countLoading ? "…" : String(cs.total);
                    // Use a CSS-only group-hover tooltip rather than the
                    // native `title` attribute so the hint appears with no
                    // browser-imposed 500ms+ delay.
                    return (
                      <span className="group/count relative ml-auto shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRefreshChildren(connId, dbName, tableName);
                          }}
                          aria-label={t(
                            "resources-panel.tree.child-count-tooltip",
                          )}
                          className="whitespace-nowrap rounded-sm px-1 font-mono text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground"
                        >
                          {label}
                        </button>
                        <span className="pointer-events-none invisible absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md group-hover/count:visible">
                          {t("resources-panel.tree.child-count-tooltip")}
                        </span>
                      </span>
                    );
                  })()}
                </div>
                <TreeRowMenu
                  name={t("resources-panel.tree.child-tables")}
                  actions={childrenActions}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextActions actions={childrenActions} />
            </ContextMenuContent>
          </ContextMenu>
          {childrenOpen && (
            <ChildrenList
              state={childrenByStable[key]}
              query={query}
              connId={connId}
              dbName={dbName}
              stableName={tableName}
              onLoadMore={() => onLoadMoreChildren(connId, dbName, tableName)}
              onOpenDesigner={onOpenDesigner}
              onOpenQueryForTable={onOpenQueryForTable}
              onDrop={onDrop}
            />
          )}
        </>
      )}
    </div>
  );
}

function ColumnsList({
  state,
  query,
  pathKey,
}: {
  state: ColumnsState | undefined;
  query: string;
  pathKey: string;
}) {
  const { t: tr } = useTranslation("connection");
  const { selected, select } = useSelection();
  if (!state || state === "loading") {
    return (
      <div>
        <p
          style={indentStyle(4)}
          className="py-1 pr-3 text-[11px] text-muted-foreground"
        >
          {tr("resources-panel.tree.loading")}
        </p>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div>
        <p
          style={indentStyle(4)}
          className="py-1 pr-3 text-[11px] text-destructive"
        >
          {tr("resources-panel.tree.failed-columns")}
        </p>
      </div>
    );
  }
  if (state.length === 0) {
    return (
      <div>
        <p
          style={indentStyle(4)}
          className="py-1 pr-3 text-[11px] italic text-muted-foreground/70"
        >
          {tr("resources-panel.tree.no-columns")}
        </p>
      </div>
    );
  }
  return (
    <div>
      {state.map((c) => {
        const colKey = `col|${pathKey}|${c.name}`;
        return (
          <div
            key={c.name}
            onClick={() => select(colKey)}
            style={indentStyle(4)}
            className={cn(
              "mx-1 flex items-center gap-2 rounded-md py-0.5 pr-2",
              selected === colKey
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted/40",
            )}
            title={`${c.name} ${c.type}${c.length ? `(${c.length})` : ""}`}
          >
            <span className="w-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-mono">
              {highlight(c.name, query)}
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-muted-foreground/70">
              {c.type}
              {c.length ? `(${c.length})` : ""}
              {c.isPrimaryTs ? " · pk" : c.isTag ? " · tag" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ChildrenList({
  state,
  query,
  connId,
  dbName,
  stableName,
  onLoadMore,
  onOpenDesigner,
  onOpenQueryForTable,
  onDrop,
}: {
  state: ChildLoadState | undefined;
  query: string;
  connId: string;
  dbName: string;
  stableName: string;
  onLoadMore: () => void;
  onOpenDesigner: (args: OpenDesignerArgs) => void;
  onOpenQueryForTable: (connId: string, db: string, table: string) => void;
  onDrop: (args: DropArgs) => void;
}) {
  const { t: tr } = useTranslation("connection");
  const { selected, select } = useSelection();
  if (!state) {
    return (
      <div>
        <p
          style={indentStyle(4)}
          className="py-1 pr-3 text-[11px] text-muted-foreground"
        >
          {tr("resources-panel.tree.loading")}
        </p>
      </div>
    );
  }
  if (state.error && state.items.length === 0) {
    return (
      <div style={indentStyle(4)} className="py-1 pr-3">
        <p className="text-[11px] text-destructive">{state.error}</p>
        <button
          type="button"
          onClick={onLoadMore}
          className="mt-1 text-[11px] text-muted-foreground underline hover:text-foreground"
        >
          {tr("resources-panel.tree.retry")}
        </button>
      </div>
    );
  }
  if (state.items.length === 0 && !state.loading) {
    return (
      <div>
        <p
          style={indentStyle(4)}
          className="py-1 pr-3 text-[11px] italic text-muted-foreground/70"
        >
          {tr("resources-panel.tree.no-child-tables")}
        </p>
      </div>
    );
  }
  // `state.total` is `undefined` when the backend skipped the COUNT scan
  // and the last page came back full — we know there might be more, but
  // not how many. `remaining === undefined` in that case; the load-more
  // button is shown without a remaining-count suffix.
  const remaining =
    state.total !== undefined ? state.total - state.items.length : undefined;
  const hasMore = remaining === undefined || remaining > 0;
  return (
    <div>
      {state.items.map((t) => {
        const childKey = `child|${connId}|${dbName}|${t.name}`;
        return (
          <ContextMenu key={t.name}>
            <ContextMenuTrigger asChild>
              <div
                onClick={() => select(childKey)}
                onDoubleClick={() => onOpenQueryForTable(connId, dbName, t.name)}
                style={indentStyle(4)}
                className={cn(
                  "mx-1 flex items-center gap-2 rounded-md py-0.5 pr-2",
                  selected === childKey
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted/40",
                )}
                title={t.name}
              >
                <span className="w-3 shrink-0" aria-hidden />
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate font-mono">
                  {highlight(t.name, query)}
                </span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={() =>
                  onOpenDesigner({
                    mode: "alter-child-tags",
                    connId,
                    db: dbName,
                    targetName: t.name,
                    stableName,
                  })
                }
              >
                {tr("resources-panel.context-menu.edit-child-tags")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  onDrop({ kind: "table", connId, db: dbName, name: t.name })
                }
                className="text-destructive focus:text-destructive"
              >
                {tr("resources-panel.context-menu.drop-table")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {state.loading && (
        <p
          style={indentStyle(4)}
          className="py-1 pr-3 text-[11px] text-muted-foreground"
        >
          {tr("resources-panel.tree.loading")}
        </p>
      )}
      {hasMore && !state.loading && (
        <button
          type="button"
          onClick={onLoadMore}
          style={indentStyle(4)}
          className="w-full py-1 pr-3 text-left text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          {remaining !== undefined
            ? tr("resources-panel.tree.load-more", {
                n: CHILD_PAGE_SIZE,
                remaining,
              })
            : tr("resources-panel.tree.load-more-unknown", {
                n: CHILD_PAGE_SIZE,
              })}
        </button>
      )}
    </div>
  );
}
