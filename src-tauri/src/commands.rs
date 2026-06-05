// Thin Tauri command wrappers.
//
// 7 schema/query commands route through the HTTP REST client and are `async`.
// 15 in-memory-state commands delegate to `Store` (SQLite-backed) and are
// synchronous.
//
// Both flavors take a brief lock on `Mutex<Store>` and never hold it across
// an `.await`.

use std::sync::Mutex;

use tauri::{AppHandle, State};

use crate::datasource::error::DataSourceError;
use crate::datasource::inflight::InFlightRegistry;
use crate::datasource::state::Store;
use crate::datasource::types::{
    Column, Connection, ConnectionInput, Console, CountTablesOpts, CreateConsoleInput, Database,
    HistoryEntry, ListTablesOpts, Paged, QueryResult, STable, Table, TestConnectionResult,
    Transport,
};
use crate::datasource::{transport, ws_client};

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clone_connection(
    state: &Mutex<Store>,
    conn_id: &str,
) -> Result<Connection, DataSourceError> {
    let s = state.lock().unwrap();
    s.get_connection(conn_id)
}

// ── Connections ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_connections(
    state: State<'_, Mutex<Store>>,
) -> Result<Vec<Connection>, DataSourceError> {
    state.lock().unwrap().list_connections()
}

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    conn_id: String,
) -> Result<TestConnectionResult, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    Ok(transport::test_connection(&conn, &app).await)
}

#[tauri::command]
pub fn create_connection(
    state: State<'_, Mutex<Store>>,
    input: ConnectionInput,
) -> Result<Connection, DataSourceError> {
    state.lock().unwrap().create_connection(input)
}

#[tauri::command]
pub fn update_connection(
    state: State<'_, Mutex<Store>>,
    id: String,
    input: ConnectionInput,
) -> Result<(), DataSourceError> {
    let res = state.lock().unwrap().update_connection(&id, input);
    // Invalidate any cached ws Taos client; the new host/port/credentials
    // may differ and the next call must redial against the fresh config.
    ws_client::forget(&id);
    res
}

#[tauri::command]
pub fn delete_connection(
    state: State<'_, Mutex<Store>>,
    id: String,
) -> Result<(), DataSourceError> {
    let res = state.lock().unwrap().delete_connection(&id);
    ws_client::forget(&id);
    res
}

#[tauri::command]
pub async fn test_connection_config(
    app: AppHandle,
    input: ConnectionInput,
) -> Result<TestConnectionResult, DataSourceError> {
    let conn = Connection {
        id: String::new(),
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        password: input.password,
        color: input.color,
        status: crate::datasource::types::ConnectionStatus::Online,
        auth_mode: input.auth_mode,
        token: input.token,
        protocol: input.protocol,
        allow_invalid_certs: input.allow_invalid_certs,
        transport: input.transport,
        timeout_ms: input.timeout_ms,
    };
    Ok(transport::test_connection(&conn, &app).await)
}

// ── Schema (HTTP-backed) ────────────────────────────────────────────────

#[tauri::command]
pub async fn list_databases(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    conn_id: String,
) -> Result<Vec<Database>, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    transport::list_databases(&conn, &app).await
}

#[tauri::command]
pub async fn list_stables(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    conn_id: String,
    db: String,
) -> Result<Vec<STable>, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    transport::list_stables(&conn, &app, &db).await
}

#[tauri::command]
pub async fn list_tables(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    conn_id: String,
    db: String,
    opts: ListTablesOpts,
) -> Result<Paged<Table>, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    transport::list_tables(&conn, &app, &db, &opts).await
}

#[tauri::command]
pub async fn count_tables(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    conn_id: String,
    db: String,
    opts: CountTablesOpts,
) -> Result<u32, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    transport::count_tables(&conn, &app, &db, &opts).await
}

#[tauri::command]
pub async fn describe_table(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    conn_id: String,
    db: String,
    table: String,
) -> Result<Vec<Column>, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    transport::describe_table(&conn, &app, &db, &table).await
}

// ── SQL execution (HTTP-backed) ─────────────────────────────────────────

#[tauri::command]
pub async fn run_sql(
    app: AppHandle,
    state: State<'_, Mutex<Store>>,
    registry: State<'_, InFlightRegistry>,
    conn_id: String,
    db: Option<String>,
    sql: String,
    query_id: String,
) -> Result<QueryResult, DataSourceError> {
    let conn = clone_connection(&state, &conn_id)?;
    let token = registry.register(&query_id);
    let result = tokio::select! {
        res = transport::run_sql(&conn, &app, db.as_deref(), &sql) => res,
        _ = token.cancelled() => {
            // Dropping the in-flight future does NOT tell the taos client to
            // stop — the ws session may still receive the cancelled query's
            // tail bytes. Reusing the same handle for the next query risks
            // reading those bytes as the new response. For ws transport,
            // evict the cached handle so the next call performs a fresh
            // handshake. HTTP has no equivalent pollution (each call is a
            // self-contained POST), so we skip the eviction there.
            if conn.transport == Transport::Ws {
                ws_client::forget(&conn_id);
            }
            Err(DataSourceError::Other("Query cancelled".into()))
        }
    };
    registry.unregister(&query_id);
    result
}

#[tauri::command]
pub fn cancel_query(
    registry: State<'_, InFlightRegistry>,
    query_id: String,
) -> Result<bool, DataSourceError> {
    Ok(registry.cancel(&query_id))
}

// ── Scratch ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn load_scratch(
    state: State<'_, Mutex<Store>>,
    console_id: String,
) -> Result<String, DataSourceError> {
    state.lock().unwrap().load_scratch(&console_id)
}

#[tauri::command]
pub fn save_scratch(
    state: State<'_, Mutex<Store>>,
    console_id: String,
    content: String,
) -> Result<(), DataSourceError> {
    state.lock().unwrap().save_scratch(&console_id, &content)
}

// ── Consoles ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_consoles(
    state: State<'_, Mutex<Store>>,
) -> Result<Vec<Console>, DataSourceError> {
    state.lock().unwrap().list_consoles()
}

#[tauri::command]
pub fn create_console(
    state: State<'_, Mutex<Store>>,
    input: CreateConsoleInput,
) -> Result<Console, DataSourceError> {
    let now = now_millis();
    state.lock().unwrap().create_console(input, now)
}

#[tauri::command]
pub fn rename_console(
    state: State<'_, Mutex<Store>>,
    id: String,
    name: String,
) -> Result<(), DataSourceError> {
    state.lock().unwrap().rename_console(&id, &name)
}

#[tauri::command]
pub fn update_console_db(
    state: State<'_, Mutex<Store>>,
    id: String,
    db: Option<String>,
) -> Result<(), DataSourceError> {
    state.lock().unwrap().update_console_db(&id, db.as_deref())
}

#[tauri::command]
pub fn delete_console(
    state: State<'_, Mutex<Store>>,
    id: String,
) -> Result<(), DataSourceError> {
    state.lock().unwrap().delete_console(&id)
}

// ── Result + history ────────────────────────────────────────────────────

#[tauri::command]
pub fn load_result(
    state: State<'_, Mutex<Store>>,
    console_id: String,
) -> Result<Option<QueryResult>, DataSourceError> {
    state.lock().unwrap().load_result(&console_id)
}

#[tauri::command]
pub fn save_result(
    state: State<'_, Mutex<Store>>,
    console_id: String,
    result: QueryResult,
) -> Result<(), DataSourceError> {
    state.lock().unwrap().save_result(&console_id, &result)
}

#[tauri::command]
pub fn load_history(
    state: State<'_, Mutex<Store>>,
    console_id: String,
) -> Result<Vec<HistoryEntry>, DataSourceError> {
    state.lock().unwrap().load_history(&console_id)
}

#[tauri::command]
pub fn save_history(
    state: State<'_, Mutex<Store>>,
    console_id: String,
    entries: Vec<HistoryEntry>,
) -> Result<(), DataSourceError> {
    state.lock().unwrap().save_history(&console_id, &entries)
}
