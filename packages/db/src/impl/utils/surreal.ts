import type { Query, QueryResultRow } from 'db:core'

/** Translate the engine's Postgres-style `$1..$n` placeholders to SurrealQL named vars `$p1..$pn`
 * with a bindings bag — the degrade layer for a Postgres-shaped query on SurrealDB. */
export const toSurreal = (query: Query): { text: string; bindings: Record<string, unknown> } => {
  const bindings: Record<string, unknown> = {}
  for (const [index, value] of query.values.entries()) {
    bindings[`p${index + 1}`] = value
  }
  const text = query.sql.replaceAll(/\$(\d+)/gu, (_match, digits: string) => `$p${digits}`)
  return { text, bindings }
}

/** SurrealDB returns one result set per statement; take the first statement's rows. */
export const firstResultSet = (result: unknown): readonly QueryResultRow[] =>
  Array.isArray(result) && Array.isArray(result[0])
    ? (result[0] as readonly QueryResultRow[])
    : Array.isArray(result)
      ? (result as readonly QueryResultRow[])
      : []
