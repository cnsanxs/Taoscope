import type { ReactNode } from "react";
import type { Column } from "@/datasource/types";
import { formatTimestamp } from "@/lib/timezone";
import type { TzPref } from "@/state/displayPrefs";

export function formatCell(
  value: unknown,
  col: Column,
  tz: TzPref = { kind: "utc" },
): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/60 italic">NULL</span>;
  }
  switch (col.type) {
    case "TIMESTAMP":
      // Run formatTimestamp regardless of the underlying JS type. The WS
      // transport returns TIMESTAMP cells as epoch-ms `number`, but the
      // HTTP REST transport returns them as ISO strings like
      // "2026-04-26T22:19:38.106Z" — formatTimestamp's `string` branch
      // re-parses those via Date.parse before applying tz, so both shapes
      // honor the active picker. Anything that fails to parse falls
      // through to `String(value)` inside formatTimestamp.
      if (typeof value === "number" || typeof value === "string") {
        return (
          <span className="font-mono">{formatTimestamp(value, tz)}</span>
        );
      }
      return <span className="font-mono">{String(value)}</span>;
    case "BOOL":
      return (
        <span className="font-mono">{value ? "true" : "false"}</span>
      );
    case "INT":
    case "BIGINT":
    case "SMALLINT":
    case "TINYINT":
    case "INT UNSIGNED":
    case "BIGINT UNSIGNED":
    case "SMALLINT UNSIGNED":
    case "TINYINT UNSIGNED":
    case "FLOAT":
    case "DOUBLE":
      return (
        <span className="font-mono tabular-nums">{String(value)}</span>
      );
    default:
      return <span className="font-mono">{String(value)}</span>;
  }
}

export function isNumericColumn(col: Column): boolean {
  return /^(INT|BIGINT|SMALLINT|TINYINT|FLOAT|DOUBLE)( UNSIGNED)?$/.test(
    col.type,
  );
}
