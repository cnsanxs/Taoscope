// Transport dispatch: route each schema/query call to the http or ws client
// based on `Connection.transport`. Callers above this layer are
// transport-agnostic. `AppHandle` is threaded through so the ws path can
// emit reconnect lifecycle events; the http path ignores it.

use tauri::AppHandle;

use crate::datasource::error::DataSourceError;
use crate::datasource::types::{
    Column, Connection, CountTablesOpts, Database, ListTablesOpts, Paged, QueryResult, STable,
    Table, TestConnectionResult, Transport,
};
use crate::datasource::{http_client, ws_client};

pub async fn test_connection(conn: &Connection, app: &AppHandle) -> TestConnectionResult {
    match conn.transport {
        Transport::Http => http_client::test_connection(conn).await,
        Transport::Ws => ws_client::test_connection(conn, app).await,
    }
}

pub async fn list_databases(
    conn: &Connection,
    app: &AppHandle,
) -> Result<Vec<Database>, DataSourceError> {
    match conn.transport {
        Transport::Http => http_client::list_databases(conn).await,
        Transport::Ws => ws_client::list_databases(conn, app).await,
    }
}

pub async fn list_stables(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
) -> Result<Vec<STable>, DataSourceError> {
    match conn.transport {
        Transport::Http => http_client::list_stables(conn, db).await,
        Transport::Ws => ws_client::list_stables(conn, app, db).await,
    }
}

pub async fn list_tables(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
    opts: &ListTablesOpts,
) -> Result<Paged<Table>, DataSourceError> {
    match conn.transport {
        Transport::Http => http_client::list_tables(conn, db, opts).await,
        Transport::Ws => ws_client::list_tables(conn, app, db, opts).await,
    }
}

pub async fn describe_table(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
    table: &str,
) -> Result<Vec<Column>, DataSourceError> {
    match conn.transport {
        Transport::Http => http_client::describe_table(conn, db, table).await,
        Transport::Ws => ws_client::describe_table(conn, app, db, table).await,
    }
}

pub async fn count_tables(
    conn: &Connection,
    app: &AppHandle,
    db: &str,
    opts: &CountTablesOpts,
) -> Result<u32, DataSourceError> {
    match conn.transport {
        Transport::Http => http_client::count_tables(conn, db, opts).await,
        Transport::Ws => ws_client::count_tables(conn, app, db, opts).await,
    }
}

pub async fn run_sql(
    conn: &Connection,
    app: &AppHandle,
    db: Option<&str>,
    sql: &str,
) -> Result<QueryResult, DataSourceError> {
    match conn.transport {
        Transport::Http => http_client::run_sql(conn, db, sql).await,
        Transport::Ws => ws_client::run_sql(conn, app, db, sql).await,
    }
}
