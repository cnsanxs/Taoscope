export interface StatementRange {
  start: number;
  end: number;
  text: string;
}

type State =
  | "CODE"
  | "STRING"
  | "DQSTRING"
  | "BACKTICK"
  | "LINE_COMMENT"
  | "BLOCK_COMMENT";

// Token-aware splitter: only `;` encountered in CODE state produces a
// statement boundary. Strings and comments hide their contents from the
// boundary scanner, so `INSERT … VALUES ('a;b')` and `-- foo; bar` stay as
// one statement.
export function splitStatements(sql: string): StatementRange[] {
  const ranges: StatementRange[] = [];
  let start = 0;
  let state: State = "CODE";

  const pushRange = (segStart: number, segEnd: number) => {
    const text = sql.slice(segStart, segEnd).trim();
    if (text.length > 0) ranges.push({ start: segStart, end: segEnd, text });
  };

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    switch (state) {
      case "CODE":
        if (ch === ";") {
          // Extend `end` past the `;` + same-line whitespace + the
          // following newline, so a cursor sitting at the visual end of
          // "SELECT 1;" resolves to that statement instead of the next
          // one. `text` still stops at `i` so the trailing `;` isn't part
          // of the executable SQL.
          let consume = i + 1;
          while (
            consume < sql.length &&
            (sql[consume] === " " || sql[consume] === "\t")
          ) {
            consume++;
          }
          if (sql[consume] === "\r") consume++;
          if (sql[consume] === "\n") consume++;
          const text = sql.slice(start, i).trim();
          if (text.length > 0)
            ranges.push({ start, end: consume, text });
          start = consume;
          i = consume - 1;
        } else if (ch === "'") {
          state = "STRING";
        } else if (ch === '"') {
          state = "DQSTRING";
        } else if (ch === "`") {
          state = "BACKTICK";
        } else if (ch === "-" && next === "-") {
          state = "LINE_COMMENT";
          i += 1;
        } else if (ch === "/" && next === "*") {
          state = "BLOCK_COMMENT";
          i += 1;
        }
        break;
      case "STRING":
        if (ch === "'") {
          // SQL standard: '' inside a single-quoted string is an escaped
          // literal quote, not the end of the string.
          if (next === "'") {
            i += 1;
          } else {
            state = "CODE";
          }
        }
        break;
      case "DQSTRING":
        if (ch === '"') {
          if (next === '"') {
            i += 1;
          } else {
            state = "CODE";
          }
        }
        break;
      case "BACKTICK":
        // TDengine backtick identifiers have no escape syntax — first
        // closing backtick wins.
        if (ch === "`") state = "CODE";
        break;
      case "LINE_COMMENT":
        if (ch === "\n") state = "CODE";
        break;
      case "BLOCK_COMMENT":
        if (ch === "*" && next === "/") {
          state = "CODE";
          i += 1;
        }
        break;
    }
  }

  // Trailing range — anything from the last `;` (or doc start) to EOF,
  // even when the trailing state is an unterminated string/comment.
  pushRange(start, sql.length);
  return ranges;
}

export function findStatementAt(
  sql: string,
  cursorPos: number,
): StatementRange | null {
  const ranges = splitStatements(sql);
  if (ranges.length === 0) return null;
  // Half-open `[start, end)` so that when adjacent ranges share a boundary
  // (range.end === nextRange.start, which now happens for `SELECT 1;\n`),
  // the cursor at that boundary snaps to the next statement rather than
  // ambiguously matching both. The final tail keeps the inclusive upper
  // bound via the fallback below so `cursorPos === sql.length` still
  // resolves.
  for (const r of ranges) {
    if (cursorPos >= r.start && cursorPos < r.end) return r;
  }
  return ranges[ranges.length - 1] ?? null;
}

export function isSingleLineStatement(range: StatementRange): boolean {
  // Based on `range.text` (trimmed) rather than the raw slice. The raw
  // slice now includes the `;` + trailing newline that splitStatements
  // folds into `range.end` (so a cursor at the visual end of "SELECT 1;"
  // still resolves to that statement); checking it directly would
  // wrongly flag "SELECT 1;\n" as multi-line.
  return range.text.indexOf("\n") === -1;
}
