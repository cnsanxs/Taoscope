// TDengine 3.x WebSocket client built on the official `taos` crate
// (feature `ws-rustls`).
//
// `taos::TaosBuilder` parses a DSN of the form `ws://user:pass@host:port` (or
// `wss://...` when `Connection.protocol == Https`) and yields a `Taos` handle
// that internally manages the WebSocket connection, frame multiplexing, and
// binary block decoding. We translate each of our seven schema/query
// operations into the trait methods exposed by `AsyncQueryable` +
// `AsyncFetchable`, mapping their results into the same Rust types the
// HTTP REST client uses — so callers above this layer never see a
// transport-shaped difference.
//
// The pool entries carry a monotonic `version` per key so that concurrent
// stale-channel callers cooperate during reconnect (see `with_reconnect`).
// Reconnect lifecycle (`connection:reconnecting`/`reconnected`/
// `reconnect-failed`) is emitted to the front end via Tauri events.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::Value as JsonValue;
use std::sync::Mutex;
use taos::taos_query::common::Value as TaosValue;
use taos::{AsyncFetchable, AsyncQueryable, AsyncTBuilder, TaosBuilder};
use tauri::{AppHandle, Emitter};

use crate::datasource::error::DataSourceError;
use crate::datasource::sql_builder::{
    assemble_stables, build_count_child_tables_sql, build_count_normal_tables_sql,
    build_describe_sql, build_list_child_tables_sql, build_list_normal_tables_sql,
    derive_total_from_short_page, parse_databases, parse_describe, parse_first_column_strings,
    parse_scalar_count, parse_stable_names, SQL_SHOW_DATABASES, SQL_SHOW_STABLES,
};
use crate::datasource::types::{
    AuthMode, Column, Connection, CountTablesOpts, Database, ListTablesOpts, Paged, Protocol,
    QueryResult, STable, Table, TestConnectionResult,
};

// ── Connection pool ─────────────────────────────────────────────────────

/// Pool entry: the live `Taos` handle plus a monotonic version that
/// increments every time the handle is replaced by a successful reconnect.
/// `with_reconnect` snapshots the version before running an op so that only
/// the first concurrent stale caller actually evicts and reconnects; later
/// callers observe a higher version and skip the redundant eviction.
struct PoolEntry {
    handle: std::sync::Arc<taos::Taos>,
    version: u64,
}

static POOL: OnceLock<Mutex<HashMap<String, PoolEntry>>> = OnceLock::new();

fn pool() -> &'static Mutex<HashMap<String, PoolEntry>> {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dsn_for(conn: &Connection) -> String {
    let scheme = match conn.protocol {
        Protocol::Https => "wss",
        Protocol::Http => "ws",
    };
    let user = urlencoding::encode(&conn.user);
    let creds = match conn.auth_mode {
        AuthMode::Basic => {
            let pwd = urlencoding::encode(&conn.password);
            format!("{}:{}@", user, pwd)
        }
        AuthMode::Token => {
            // Token authentication is appended as a query string per
            // TDengine Cloud's DSN convention.
            user.to_string() + "@"
        }
    };
    let base = format!("{}://{}{}:{}", scheme, creds, conn.host, conn.port);
    match conn.auth_mode {
        AuthMode::Token => {
            let token = conn.token.as_deref().unwrap_or("");
            format!("{}?token={}", base, urlencoding::encode(token))
        }
        AuthMode::Basic => base,
    }
}

fn pool_key(conn: &Connection) -> String {
    if !conn.id.is_empty() {
        conn.id.clone()
    } else {
        // Synthesise a fingerprint for the ephemeral "Test connection" case.
        format!("test::{}::{}::{}", conn.host, conn.port, conn.user)
    }
}

/// Get or build a `Taos` handle, returning the handle and the version
/// observed at the moment of lookup. Building (handshake) happens outside
/// the pool lock so concurrent first-callers don't serialise.
async fn get_or_connect(
    conn: &Connection,
) -> Result<(std::sync::Arc<taos::Taos>, u64), DataSourceError> {
    let key = pool_key(conn);
    {
        let cache = pool().lock().unwrap();
        if let Some(entry) = cache.get(&key) {
            return Ok((entry.handle.clone(), entry.version));
        }
    }
    let dsn = dsn_for(conn);
    let builder = TaosBuilder::from_dsn(&dsn)
        .map_err(|e| DataSourceError::Other(format!("ws DSN error: {}", e)))?;
    let taos = builder.build().await.map_err(map_taos_err)?;
    let arc = std::sync::Arc::new(taos);
    let mut cache = pool().lock().unwrap();
    // Another thread may have raced ahead and installed an entry while we
    // were handshaking; honour the newer one rather than overwriting it.
    if let Some(entry) = cache.get(&key) {
        return Ok((entry.handle.clone(), entry.version));
    }
    let entry = PoolEntry {
        handle: arc.clone(),
        version: 0,
    };
    cache.insert(key, entry);
    Ok((arc, 0))
}

/// Remove the pool entry for `key` only when its current version still
/// matches the snapshot the caller took before its op failed. Returns true
/// when the entry was actually removed (i.e. the caller is now responsible
/// for reconnecting). Returns false when a concurrent reconnect has already
/// replaced the entry — the caller should retry from `get_or_connect`.
fn evict_if_version(key: &str, snapshot_version: u64) -> bool {
    let mut cache = pool().lock().unwrap();
    match cache.get(key) {
        Some(entry) if entry.version == snapshot_version => {
            cache.remove(key);
            true
        }
        _ => false,
    }
}

/// Build a fresh `Taos` handle and install it into the pool with a bumped
/// version. Returns the new handle + version. The previous entry (if any)
/// must already have been removed by the caller via `evict_if_version`.
async fn reconnect(
    conn: &Connection,
) -> Result<(std::sync::Arc<taos::Taos>, u64), DataSourceError> {
    let dsn = dsn_for(conn);
    let builder = TaosBuilder::from_dsn(&dsn)
        .map_err(|e| DataSourceError::Other(format!("ws DSN error: {}", e)))?;
    let taos = builder.build().await.map_err(map_taos_err)?;
    let arc = std::sync::Arc::new(taos);
    let key = pool_key(conn);
    let mut cache = pool().lock().unwrap();
    // Compute next version. If a concurrent caller has already inserted a
    // newer entry, defer to it instead of clobbering.
    if let Some(entry) = cache.get(&key) {
        return Ok((entry.handle.clone(), entry.version));
    }
    let next_version = 1u64; // first reconnect after eviction starts at 1
    cache.insert(
        key,
        PoolEntry {
            handle: arc.clone(),
            version: next_version,
        },
    );
    Ok((arc, next_version))
}

/// Detect taos errors that indicate the underlying WebSocket session is no
/// longer usable and the cached handle must be discarded. Matched against
/// the `Display` form (case-insensitive) of `taos::Error`. The taos crate
/// does not expose a stable enum variant for this class — we inspect text.
///
/// Patterns observed in `taos` 0.12 with TDengine 3.x:
/// - `channel closed`     — the internal mpsc to the ws reader/writer task
///                          has been dropped (server-side close, network
///                          drop, or taosAdapter restart).
/// - `connection reset`   — TCP RST from server or proxy.
/// - `connection closed`  — graceful TCP close from server (idle timeout).
/// - `broken pipe`        — local write to a half-closed socket.
/// - `websocket closed`   — explicit ws frame Close from the peer.
/// - `[0xE003]`           — taos-ws internal code stamped on `channel closed`.
fn is_stale_channel(err: &taos::Error) -> bool {
    let s = err.to_string().to_ascii_lowercase();
    s.contains("channel closed")
        || s.contains("connection reset")
        || s.contains("connection closed")
        || s.contains("broken pipe")
        || s.contains("websocket closed")
        || s.contains("[0xe003]")
}

/// Same stale-channel patterns, but applied to an already-stringified error
/// (used by `map_err` so the error classification stays in sync with the
/// reconnect trigger).
fn is_stale_channel_str(msg: &str) -> bool {
    let s = msg.to_ascii_lowercase();
    s.contains("channel closed")
        || s.contains("connection reset")
        || s.contains("connection closed")
        || s.contains("broken pipe")
        || s.contains("websocket closed")
        || s.contains("[0xe003]")
}

/// Convert a raw `taos::Error` into our user-facing `DataSourceError`.
/// Auth-bearing messages take precedence; stale-channel + classic network
/// keywords route to `Network`; everything else falls back to `Sql` so the
/// frontend's "SQL" badge stays meaningful.
fn map_taos_err(e: taos::Error) -> DataSourceError {
    let msg = e.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("auth") || lower.contains("password") || lower.contains("401") {
        DataSourceError::Auth(msg)
    } else if is_stale_channel_str(&lower)
        || lower.contains("network")
        || lower.contains("connect")
        || lower.contains("websocket")
        || lower.contains("timeout")
    {
        DataSourceError::Network(msg)
    } else {
        DataSourceError::Sql(msg)
    }
}

/// Internal error type used by the with_reconnect wrapper so it can inspect
/// the original `taos::Error` (for staleness) before the conversion to
/// `DataSourceError`. Not exposed outside this module.
enum WsOpError {
    Taos(taos::Error),
    Timeout(u32),
}

impl WsOpError {
    fn is_stale(&self) -> bool {
        matches!(self, WsOpError::Taos(e) if is_stale_channel(e))
    }
    fn into_data_source(self) -> DataSourceError {
        match self {
            WsOpError::Taos(e) => map_taos_err(e),
            WsOpError::Timeout(ms) => {
                DataSourceError::Other(format!("Query timeout after {}ms", ms))
            }
        }
    }
}

/// Drop the cached `Taos` for a given connection id (called on update /
/// delete, and on cancel of a ws query to avoid state pollution).
pub fn forget(conn_id: &str) {
    if conn_id.is_empty() {
        return;
    }
    let mut cache = pool().lock().unwrap();
    cache.remove(conn_id);
}

// ── Reconnect lifecycle events ──────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReconnectEvent<'a> {
    conn_id: &'a str,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReconnectFailedEvent<'a> {
    conn_id: &'a str,
    error: String,
}

fn emit_reconnecting(app: &AppHandle, conn_id: &str) {
    let _ = app.emit("connection:reconnecting", ReconnectEvent { conn_id });
}
fn emit_reconnected(app: &AppHandle, conn_id: &str) {
    let _ = app.emit("connection:reconnected", ReconnectEvent { conn_id });
}
fn emit_reconnect_failed(app: &AppHandle, conn_id: &str, error: &DataSourceError) {
    let _ = app.emit(
        "connection:reconnect-failed",
        ReconnectFailedEvent {
            conn_id,
            error: error.to_string(),
        },
    );
}

// ── with_reconnect wrapper ──────────────────────────────────────────────

/// Run `op` against a cached `Taos`. On stale-channel failure, evict (under
/// version guard), reconnect, and try `op` exactly once more. Emits the
/// reconnect lifecycle events to the front end. A second failure surfaces
/// the error to the caller without further retries.
async fn with_reconnect<F, Fut, T>(
    conn: &Connection,
    app: &AppHandle,
    op: F,
) -> Result<T, DataSourceError>
where
    F: Fn(std::sync::Arc<taos::Taos>) -> Fut,
    Fut: std::future::Future<Output = Result<T, WsOpError>>,
{
    let (handle, version_seen) = get_or_connect(conn).await?;
    match op(handle).await {
        Ok(v) => Ok(v),
        Err(e) if e.is_stale() => {
            // Stale: evict under version guard, reconnect, retry once.
            let key = pool_key(conn);
            emit_reconnecting(app, &conn.id);
            evict_if_version(&key, version_seen);
            match reconnect(conn).await {
                Ok((new_handle, _)) => match op(new_handle).await {
                    Ok(v) => {
                        emit_reconnected(app, &conn.id);
                        Ok(v)
                    }
                    Err(retry_err) => {
                        let mapped = retry_err.into_data_source();
                        emit_reconnect_failed(app, &conn.id, &mapped);
                        Err(mapped)
                    }
                },
                Err(reconnect_err) => {
                    emit_reconnect_failed(app, &conn.id, &reconnect_err);
                    Err(reconnect_err)
                }
            }
        }
        Err(e) => Err(e.into_data_source()),
    }
}

// ── Value conversion ────────────────────────────────────────────────────

fn taos_value_to_json(v: TaosValue) -> JsonValue {
    // `taos_query::common::Value` derives the default externally-tagged
    // Serialize impl, so `serde_json::to_value` would wrap scalars in
    // `{"VarChar": "..."}` envelopes. Unwrap to bare JSON scalars so the
    // ws transport matches the REST envelope shape.
    use serde_json::Number;
    match v {
        TaosValue::Null(_) => JsonValue::Null,
        TaosValue::Bool(b) => JsonValue::Bool(b),
        TaosValue::TinyInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::SmallInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::Int(n) => JsonValue::Number(Number::from(n)),
        TaosValue::BigInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::UTinyInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::USmallInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::UInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::UBigInt(n) => JsonValue::Number(Number::from(n)),
        TaosValue::Float(f) => Number::from_f64(f as f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        TaosValue::Double(f) => Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        TaosValue::VarChar(s) => JsonValue::String(s),
        TaosValue::NChar(s) => JsonValue::String(s),
        TaosValue::Timestamp(ts) => JsonValue::Number(Number::from(ts.as_raw_i64())),
        TaosValue::Json(j) => j,
        TaosValue::VarBinary(b) => JsonValue::String(hex_encode(&b)),
        TaosValue::Geometry(b) => JsonValue::String(hex_encode(&b)),
        TaosValue::Blob(b) => JsonValue::String(hex_encode(&b)),
        TaosValue::MediumBlob(b) => JsonValue::String(hex_encode(&b)),
        TaosValue::Decimal(d) => JsonValue::String(d.to_string()),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

struct ResultRows {
    columns: Vec<Column>,
    rows: Vec<Vec<JsonValue>>,
    row_count: u32,
    /// `Some` for write/DDL statements (no fields); `None` for result sets.
    affected_rows: Option<u32>,
}

async fn run_inner(
    taos: &taos::Taos,
    db: Option<&str>,
    sql: &str,
) -> Result<ResultRows, WsOpError> {
    if let Some(d) = db {
        // This `USE` result is discarded; the affected-rows detection below
        // only inspects the user statement's own ResultSet.
        let use_sql = format!("USE `{}`", d.replace('`', "``"));
        let _ = AsyncQueryable::exec(taos, &use_sql)
            .await
            .map_err(WsOpError::Taos)?;
    }
    let mut rs = AsyncQueryable::query(taos, sql)
        .await
        .map_err(WsOpError::Taos)?;

    let fields = rs.fields();

    // Write/DDL statements produce a ResultSet with no fields; surface the
    // affected-row count instead of an (empty) result set.
    if fields.is_empty() {
        return Ok(ResultRows {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            affected_rows: Some(rs.affected_rows() as u32),
        });
    }

    let columns: Vec<Column> = fields
        .iter()
        .map(|f| Column {
            name: f.name().to_string(),
            data_type: f.ty().name().to_string(),
            length: {
                let bytes = f.bytes();
                if bytes > 0 {
                    Some(bytes as u32)
                } else {
                    None
                }
            },
            is_tag: None,
            is_primary_ts: None,
        })
        .collect();

    let records = rs.to_records().await.map_err(WsOpError::Taos)?;
    let mut rows: Vec<Vec<JsonValue>> = Vec::with_capacity(records.len());
    for row in records {
        rows.push(row.into_iter().map(taos_value_to_json).collect());
    }
    let row_count = rows.len() as u32;
    Ok(ResultRows {
        columns,
        rows,
        row_count,
        affected_rows: None,
    })
}

async fn run(
    taos: &taos::Taos,
    timeout_ms: u32,
    db: Option<&str>,
    sql: &str,
) -> Result<ResultRows, WsOpError> {
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms as u64),
        run_inner(taos, db, sql),
    )
    .await
    {
        Ok(res) => res,
        Err(_) => Err(WsOpError::Timeout(timeout_ms)),
    }
}

fn effective_timeout(conn: &Connection) -> u32 {
    conn.timeout_ms
        .unwrap_or(crate::datasource::http_client::DEFAULT_TIMEOUT_MS)
}

// ── Public methods ──────────────────────────────────────────────────────

pub async fn test_connection(conn: &Connection, app: &AppHandle) -> TestConnectionResult {
    // Reconnect wrapper still applies: a stale cached handle from a prior
    // test must not poison the "Test connection" button forever.
    let outcome = with_reconnect(conn, app, |taos| async move {
        AsyncQueryable::server_version(taos.as_ref())
            .await
            .map(|cow| cow.into_owned())
            .map_err(WsOpError::Taos)
    })
    .await;
    match outcome {
        Ok(v) => TestConnectionResult {
            ok: true,
            message: Some(v),
        },
        Err(e) => TestConnectionResult {
            ok: false,
            message: Some(e.to_string()),
        },
    }
}

pub async fn list_databases(
    conn: &Connection,
    app: &AppHandle,
) -> Result<Vec<Database>, DataSourceError> {
    let timeout_ms = effective_timeout(conn);
    let result = with_reconnect(conn, app, |taos| async move {
        run(taos.as_ref(), timeout_ms, None, SQL_SHOW_DATABASES).await
    })
    .await?;
    Ok(parse_databases(&result.columns, &result.rows))
}

pub async fn list_stables(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
) -> Result<Vec<STable>, DataSourceError> {
    let timeout_ms = effective_timeout(conn);
    let db_owned = db.to_string();
    let result = with_reconnect(conn, app, |taos| {
        let db_for_op = db_owned.clone();
        async move { run(taos.as_ref(), timeout_ms, Some(&db_for_op), SQL_SHOW_STABLES).await }
    })
    .await?;
    let names = parse_stable_names(&result.columns, &result.rows);
    Ok(assemble_stables(names))
}

pub async fn list_tables(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
    opts: &ListTablesOpts,
) -> Result<Paged<Table>, DataSourceError> {
    let page = opts.page.max(1);
    let page_size = opts.page_size.max(1);
    let offset = (page - 1) * page_size;

    if let Some(search) = &opts.search {
        if search.contains(';') {
            return Err(DataSourceError::Other(
                "invalid search character: ';'".into(),
            ));
        }
    }

    let timeout_ms = effective_timeout(conn);
    let db_owned = db.to_string();
    let search_owned = opts.search.clone();

    if let Some(stable) = &opts.stable {
        let stable_owned = stable.clone();
        let items_sql =
            build_list_child_tables_sql(db, stable, opts.search.as_deref(), page_size, offset);
        let items_resp = with_reconnect(conn, app, |taos| {
            let sql = items_sql.clone();
            async move { run(taos.as_ref(), timeout_ms, None, &sql).await }
        })
        .await?;
        let items: Vec<Table> = parse_first_column_strings(&items_resp.rows)
            .into_iter()
            .map(|name| Table {
                name,
                is_child: true,
                stable_name: Some(stable_owned.clone()),
            })
            .collect();
        // Skip the explicit `COUNT(*)` round-trip — it's a full scan of
        // `information_schema.ins_tables` and dominates the latency. Only
        // fall through to a definite total when the page came back short,
        // because that proves there are no further rows.
        let total = derive_total_from_short_page(items.len() as u32, page_size, offset);
        return Ok(Paged {
            items,
            total,
            page,
            page_size,
        });
    }

    let items_sql =
        build_list_normal_tables_sql(&db_owned, search_owned.as_deref(), page_size, offset);
    let items_resp = with_reconnect(conn, app, |taos| {
        let sql = items_sql.clone();
        async move { run(taos.as_ref(), timeout_ms, None, &sql).await }
    })
    .await?;
    let items: Vec<Table> = parse_first_column_strings(&items_resp.rows)
        .into_iter()
        .map(|name| Table {
            name,
            is_child: false,
            stable_name: None,
        })
        .collect();

    let total = derive_total_from_short_page(items.len() as u32, page_size, offset);
    Ok(Paged {
        items,
        total,
        page,
        page_size,
    })
}

/// Run only the `COUNT(*)` query for child tables (when `opts.stable` is set)
/// or normal tables (otherwise). Returns 0 when the count cell can't be
/// parsed — callers treat this as "unknown" but should still propagate it
/// to the UI rather than fall back to a synthesised number.
pub async fn count_tables(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
    opts: &CountTablesOpts,
) -> Result<u32, DataSourceError> {
    if let Some(search) = &opts.search {
        if search.contains(';') {
            return Err(DataSourceError::Other(
                "invalid search character: ';'".into(),
            ));
        }
    }
    let timeout_ms = effective_timeout(conn);
    let sql = match &opts.stable {
        Some(stable) => build_count_child_tables_sql(db, stable, opts.search.as_deref()),
        None => build_count_normal_tables_sql(db, opts.search.as_deref()),
    };
    let resp = with_reconnect(conn, app, |taos| {
        let sql_for_op = sql.clone();
        async move { run(taos.as_ref(), timeout_ms, None, &sql_for_op).await }
    })
    .await?;
    Ok(parse_scalar_count(&resp.rows).unwrap_or(0))
}

pub async fn describe_table(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
    table: &str,
) -> Result<Vec<Column>, DataSourceError> {
    let timeout_ms = effective_timeout(conn);
    let sql = build_describe_sql(db, table);
    let result = with_reconnect(conn, app, |taos| {
        let sql_for_op = sql.clone();
        async move { run(taos.as_ref(), timeout_ms, None, &sql_for_op).await }
    })
    .await?;
    Ok(parse_describe(&result.columns, &result.rows))
}

pub async fn run_sql(
    conn: &Connection,
    app: &AppHandle,
    db: Option<&str>,
    sql: &str,
) -> Result<QueryResult, DataSourceError> {
    let timeout_ms = effective_timeout(conn);
    let db_owned = db.map(|s| s.to_string());
    let sql_owned = sql.to_string();
    let start = Instant::now();
    let result = with_reconnect(conn, app, |taos| {
        let db_for_op = db_owned.clone();
        let sql_for_op = sql_owned.clone();
        async move {
            run(
                taos.as_ref(),
                timeout_ms,
                db_for_op.as_deref(),
                &sql_for_op,
            )
            .await
        }
    })
    .await?;
    let elapsed_ms = start.elapsed().as_millis() as u32;
    Ok(QueryResult {
        columns: result.columns,
        rows: result.rows,
        row_count: result.row_count,
        elapsed_ms,
        truncated: false,
        affected_rows: result.affected_rows,
    })
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_str_matches_channel_closed() {
        assert!(is_stale_channel_str(
            "[0xE003] Internal error: `channel closed`"
        ));
    }

    #[test]
    fn stale_str_matches_connection_reset() {
        assert!(is_stale_channel_str("transport: connection reset by peer"));
    }

    #[test]
    fn stale_str_matches_broken_pipe() {
        assert!(is_stale_channel_str("write failed: broken pipe"));
    }

    #[test]
    fn stale_str_matches_websocket_closed() {
        assert!(is_stale_channel_str("WebSocket closed gracefully"));
    }

    #[test]
    fn stale_str_matches_0xe003_uppercase() {
        assert!(is_stale_channel_str("[0xE003] something"));
    }

    #[test]
    fn stale_str_does_not_match_syntax_error() {
        assert!(!is_stale_channel_str("syntax error near 'FORM'"));
    }
}
