import type { Column, QueryResult } from "@/datasource/types";
import { formatTimestamp } from "@/lib/timezone";
import type { TzPref } from "@/state/displayPrefs";

const BOM = "﻿";
const NEEDS_QUOTE = /["\r\n,]/;

const DEFAULT_TZ: TzPref = { kind: "utc" };

export function serializeValue(
  value: unknown,
  col: Column,
  tz: TzPref = DEFAULT_TZ,
): string {
  if (value === null || value === undefined) return "";
  // WS transport returns TIMESTAMP as epoch-ms number; HTTP REST returns
  // ISO strings. Both must be re-formatted under the active tz so CSV /
  // TSV / copy-to-clipboard exports match what the grid shows.
  if (
    col.type === "TIMESTAMP" &&
    (typeof value === "number" || typeof value === "string")
  ) {
    return formatTimestamp(value, tz);
  }
  if (col.type === "BOOL") return value ? "true" : "false";
  return String(value);
}

function quoteCsvField(s: string): string {
  if (!NEEDS_QUOTE.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(result: QueryResult, tz: TzPref = DEFAULT_TZ): string {
  const header = result.columns.map((c) => quoteCsvField(c.name)).join(",");
  const dataLines = result.rows.map((row) =>
    result.columns
      .map((col, idx) => quoteCsvField(serializeValue(row[idx], col, tz)))
      .join(","),
  );
  return BOM + [header, ...dataLines].join("\r\n");
}

function jsonValue(value: unknown, col: Column, tz: TzPref): unknown {
  if (value === null || value === undefined) return null;
  // Same dual-shape handling as serializeValue — see comment there.
  if (
    col.type === "TIMESTAMP" &&
    (typeof value === "number" || typeof value === "string")
  ) {
    return formatTimestamp(value, tz);
  }
  return value;
}

export function toJson(result: QueryResult, tz: TzPref = DEFAULT_TZ): string {
  const arr = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, idx) => {
      obj[col.name] = jsonValue(row[idx], col, tz);
    });
    return obj;
  });
  return JSON.stringify(arr, null, 2);
}

export function rowToTsv(
  row: unknown[],
  columns: Column[],
  tz: TzPref = DEFAULT_TZ,
): string {
  return columns
    .map((col, idx) =>
      serializeValue(row[idx], col, tz).replace(/[\t\r\n]/g, " "),
    )
    .join("\t");
}

export function columnToText(
  rows: unknown[][],
  colIndex: number,
  col: Column,
  tz: TzPref = DEFAULT_TZ,
): string {
  return rows.map((row) => serializeValue(row[colIndex], col, tz)).join("\n");
}

export function rowToJson(
  row: unknown[],
  columns: Column[],
  tz: TzPref = DEFAULT_TZ,
): string {
  const obj: Record<string, unknown> = {};
  columns.forEach((col, idx) => {
    obj[col.name] = jsonValue(row[idx], col, tz);
  });
  return JSON.stringify(obj, null, 2);
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function buildFilename(ext: "csv" | "json"): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(
    now.getDate(),
  )}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(
    now.getSeconds(),
  )}`;
  return `taoscope-result-${date}-${time}.${ext}`;
}
