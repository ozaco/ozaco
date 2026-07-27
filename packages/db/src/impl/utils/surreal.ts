import type { Query, QueryResultRow } from 'db:core'

/** Translate a Postgres-shaped query (the core `sql` tag's output) to SurrealQL — the degrade layer.
 * Two rewrites: the engine's `$1..$n` placeholders become named vars `$p1..$pn`, and double-quoted
 * identifiers become backtick-quoted ones. The latter is safe because the `sql` tag parameterizes
 * every value (`$n`) and escapes string literals with single quotes, so any `"…"` run left in the
 * baked SQL is ALWAYS an identifier — in SurrealQL `"…"` is a string, and names are `` `…` ``. */
export const toSurreal = (query: Query): { text: string; bindings: Record<string, unknown> } => {
  const bindings: Record<string, unknown> = {}
  for (const [index, value] of query.values.entries()) {
    bindings[`p${index + 1}`] = value
  }
  const text = query.sql
    .replaceAll(/"((?:[^"]|"")*)"/gu, (_match, name: string) => `\`${name.replaceAll('""', '"')}\``)
    .replaceAll(/\$(\d+)/gu, (_match, digits: string) => `$p${digits}`)
  return { text, bindings }
}

/** Backtick-quote a SurrealQL identifier (namespace/database names in DDL) so reserved words and
 * special characters can't break out of the name position — same backtick form `toSurreal` emits. */
export const escapeIdent = (name: string): string =>
  `\`${name.replaceAll('\\', String.raw`\\`).replaceAll('`', String.raw`\``)}\``

/** SurrealDB returns one result set per statement; take the first statement's rows. */
export const firstResultSet = (result: unknown): readonly QueryResultRow[] =>
  Array.isArray(result) && Array.isArray(result[0])
    ? (result[0] as readonly QueryResultRow[])
    : Array.isArray(result)
      ? (result as readonly QueryResultRow[])
      : []
