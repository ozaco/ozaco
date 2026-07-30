import type { Query, QueryResultRow } from 'db:core'

/** How one `LIKE` pattern translates: a `string::` function over a plain term, an equality (no
 * wildcard at all), or a full regex `string::matches` when wildcards sit INSIDE the pattern. */
interface LikePlan {
  readonly kind: 'contains' | 'starts_with' | 'ends_with' | 'eq' | 'matches'
  readonly term: string
}

const likePlan = (pattern: string): LikePlan => {
  const leading = pattern.startsWith('%')
  const trailing = pattern.length > (leading ? 1 : 0) && pattern.endsWith('%')
  const body = pattern.slice(leading ? 1 : 0, pattern.length - (trailing ? 1 : 0))
  if (/[%_]/u.test(body)) {
    return { kind: 'matches', term: pattern }
  }
  if (leading && trailing) {
    return { kind: 'contains', term: body }
  }
  if (trailing) {
    return { kind: 'starts_with', term: body }
  }
  if (leading) {
    return { kind: 'ends_with', term: body }
  }
  return { kind: 'eq', term: body }
}

/** Compile a general `LIKE` pattern to the anchored regex `string::matches` takes (Rust regex):
 * `%` → `.*`, `_` → `.`, everything else literal; `(?i)` carries the case-insensitive variant. */
const likeRegex = (pattern: string, insensitive: boolean): string => {
  let source = ''
  for (const char of pattern) {
    if (char === '%') {
      source += '.*'
    } else if (char === '_') {
      source += '.'
    } else {
      source += /[.*+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char
    }
  }
  return `${insensitive ? '(?i)' : ''}^${source}$`
}

/**
 * SurrealQL has no `LIKE` — its parser rejects the token outright, which used to 500 every wizard
 * `q` search and Mongo `$like`/`$contains`/… on this driver. Each parameterized comparison becomes
 * the `string::` call its PATTERN means (read from — and rewritten into — the binding): `%t%` →
 * `contains`, `t%` → `starts_with`, `%t` → `ends_with`, no wildcard → `=`, wildcards inside the
 * pattern → `string::matches` on the {@link likeRegex} translation. The `lower(x) LIKE lower($pn)`
 * form (`ilike`) lowercases the column via `string::lowercase` and the bound term with it (regex
 * form: `(?i)`), preserving its case-insensitive contract. Rewriting the binding in place is safe
 * because the `sql` tag emits every placeholder exactly once — a `LIKE`'s parameter is its own.
 */
const rewriteLike = (text: string, bindings: Record<string, unknown>): string => {
  const translate = (lhs: string, param: string, insensitive: boolean): string => {
    const key = `p${param}`
    const plan = likePlan(String(bindings[key] ?? ''))
    if (plan.kind === 'matches') {
      bindings[key] = likeRegex(plan.term, insensitive)
      return `string::matches(${lhs}, $${key})`
    }
    bindings[key] = insensitive ? plan.term.toLowerCase() : plan.term
    const target = insensitive ? `string::lowercase(${lhs})` : lhs
    return plan.kind === 'eq' ? `${target} = $${key}` : `string::${plan.kind}(${target}, $${key})`
  }
  return text
    .replaceAll(
      /lower\((`(?:[^`]|``)*`)\) LIKE lower\(\$p(\d+)\)/gu,
      (_match, lhs: string, n: string) => translate(lhs, n, true),
    )
    .replaceAll(/(`(?:[^`]|``)*`) LIKE \$p(\d+)/gu, (_match, lhs: string, n: string) =>
      translate(lhs, n, false),
    )
}

/** Translate a Postgres-shaped query (the core `sql` tag's output) to SurrealQL — the degrade layer.
 * Four rewrites: the engine's `$1..$n` placeholders become named vars `$p1..$pn`, double-quoted
 * identifiers become backtick-quoted ones, `IN (…)` value lists become `IN […]` arrays, and `LIKE`
 * comparisons become the `string::` calls their bound pattern means (see {@link rewriteLike}). The
 * identifier rewrite is safe because the `sql` tag parameterizes every value (`$n`) and escapes
 * string literals with single quotes, so any `"…"` run left in the baked SQL is ALWAYS an
 * identifier — in SurrealQL `"…"` is a string, and names are `` `…` ``. The `IN` rewrite is safe
 * because it only matches a parenthesized run of `$pn` placeholders — SurrealQL's `IN`/`NOT IN`
 * take an array operand, not the ANSI tuple, which its parser rejects. */
export const toSurreal = (query: Query): { text: string; bindings: Record<string, unknown> } => {
  const bindings: Record<string, unknown> = {}
  for (const [index, value] of query.values.entries()) {
    bindings[`p${index + 1}`] = value
  }
  const text = rewriteLike(
    query.sql
      .replaceAll(
        /"((?:[^"]|"")*)"/gu,
        (_match, name: string) => `\`${name.replaceAll('""', '"')}\``,
      )
      .replaceAll(/\$(\d+)/gu, (_match, digits: string) => `$p${digits}`)
      .replaceAll(/\bIN \((\$p\d+(?:, \$p\d+)*)\)/gu, 'IN [$1]'),
    bindings,
  )
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
