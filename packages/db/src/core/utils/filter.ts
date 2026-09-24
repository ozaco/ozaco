// oxlint-disable import/exports-last
import type { Spec } from '../types/spec'

/** A field name, or a path into a `json` column (`['payload', 'workspace']`). */
type FieldRef<TField extends string> = TField | Spec.FieldPath<TField>

/** Split a field reference into the column and the (optional) path inside it. */
const refOf = <TField extends string>(
  ref: FieldRef<TField>,
): { readonly field: TField; readonly path?: readonly Spec.PathSegment[] } => {
  if (typeof ref === 'string') {
    return { field: ref }
  }

  const [field, ...path] = ref

  return path.length === 0 ? { field } : { field, path }
}

/**
 * The filter algebra as ONE namespace — `where.eq(...)`, `where.and(...)` — so nothing generic
 * (`eq`, `or`, `not`, `like`…) lands in your import scope.
 *
 * Every builder remembers the field it names in the type it returns, so
 * `db.query('todos').filter(where.eq('dnoe', false))` is a COMPILE error: a `Filter<'dnoe'>`
 * does not fit a query whose fields are `'title' | 'done' | …`.
 *
 * Every leaf builder also takes a PATH into a `json` column — `where.eq(['payload',
 * 'workspace'], id)` — whose first entry is the column (checked the same way).
 */
const eq = <const TField extends string>(
  field: FieldRef<TField>,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'eq', ...refOf(field), value })

const ne = <const TField extends string>(
  field: FieldRef<TField>,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'ne', ...refOf(field), value })

const gt = <const TField extends string>(
  field: FieldRef<TField>,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'gt', ...refOf(field), value })

const gte = <const TField extends string>(
  field: FieldRef<TField>,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'gte', ...refOf(field), value })

const lt = <const TField extends string>(
  field: FieldRef<TField>,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'lt', ...refOf(field), value })

const lte = <const TField extends string>(
  field: FieldRef<TField>,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'lte', ...refOf(field), value })

const oneOf = <const TField extends string>(
  field: FieldRef<TField>,
  values: readonly Spec.FilterValue[],
): Spec.Filter<TField> => ({ op: 'in', ...refOf(field), value: values })

const notOneOf = <const TField extends string>(
  field: FieldRef<TField>,
  values: readonly Spec.FilterValue[],
): Spec.Filter<TField> => ({ op: 'not-in', ...refOf(field), value: values })

const like = <const TField extends string>(
  field: FieldRef<TField>,
  pattern: string,
): Spec.Filter<TField> => ({ op: 'like', ...refOf(field), pattern })

const ilike = <const TField extends string>(
  field: FieldRef<TField>,
  pattern: string,
): Spec.Filter<TField> => ({ op: 'like', ...refOf(field), pattern, insensitive: true })

/** Escape `%`, `_` and `\` so `text` matches ITSELF inside a `like` pattern — what to wrap user
 * input in before concatenating your own wildcards: `where.like('name', `${escapeLike(q)}%`)`. */
const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/gu, String.raw`\$&`)

const startsWith = <const TField extends string>(
  field: FieldRef<TField>,
  prefix: string,
  options?: { readonly insensitive?: boolean | undefined },
): Spec.Filter<TField> => ({
  op: 'like',
  ...refOf(field),
  pattern: `${escapeLike(prefix)}%`,
  ...(options?.insensitive ? { insensitive: true } : {}),
})

const isNull = <const TField extends string>(field: FieldRef<TField>): Spec.Filter<TField> => ({
  op: 'is-null',
  ...refOf(field),
})

const notNull = <const TField extends string>(field: FieldRef<TField>): Spec.Filter<TField> => ({
  op: 'not-null',
  ...refOf(field),
})

const and = <TField extends string>(
  ...filters: readonly Spec.Filter<TField>[]
): Spec.Filter<TField> => ({ op: 'and', filters })

const or = <TField extends string>(
  ...filters: readonly Spec.Filter<TField>[]
): Spec.Filter<TField> => ({ op: 'or', filters })

const not = <TField extends string>(filter: Spec.Filter<TField>): Spec.Filter<TField> => ({
  op: 'not',
  filter,
})

/** The portable filter algebra: `where.eq('done', false)`, `where.and(a, b)`, … `startsWith`
 * is `like` with the prefix escaped, so user input containing `%`/`_` matches literally. */
export const where = {
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  oneOf,
  notOneOf,
  like,
  ilike,
  startsWith,
  isNull,
  notNull,
  and,
  or,
  not,
}

export { escapeLike }

/** Whether a leaf filter reaches into a `json` column. */
const hasPath = (filter: { readonly path?: readonly Spec.PathSegment[] | undefined }): boolean =>
  filter.path !== undefined && filter.path.length > 0

/**
 * The exact values a filter PINS — what a row must carry to satisfy it: `eq` pins its value,
 * `isNull` pins `null`, and nested `and`s flatten. Returns `null` when any part pins nothing
 * exact (`or`, `not`, `ne`, ranges, `in`…): such a filter can narrow reads but cannot shape a
 * write. This is what turns a trusted read scope into the fields a scoped insert must carry.
 */
export const filterValues = (filter: Spec.Filter): Record<string, Spec.FilterValue> | null => {
  switch (filter.op) {
    case 'and': {
      const out: Record<string, Spec.FilterValue> = {}

      for (const inner of filter.filters) {
        const values = filterValues(inner)

        if (values === null) {
          return null
        }

        Object.assign(out, values)
      }

      return out
    }

    // a leaf that reaches INTO a json column constrains part of a value — it pins no column
    case 'eq': {
      return hasPath(filter) ? null : { [filter.field]: filter.value }
    }

    case 'is-null': {
      return hasPath(filter) ? null : { [filter.field]: null }
    }

    default: {
      return null
    }
  }
}

/** Every field name a filter references (for validation against a table's columns). */
export const filterFields = <TField extends string>(
  filter: Spec.Filter<TField>,
): readonly TField[] => {
  switch (filter.op) {
    case 'and':
    case 'or': {
      return filter.filters.flatMap(inner => filterFields(inner))
    }

    case 'not': {
      return filterFields(filter.filter)
    }

    default: {
      return [filter.field]
    }
  }
}

/** Every leaf of a filter that reaches INTO a json column: its column and path (for validation —
 * the column must be `json`, every segment a usable key). */
export const filterPaths = (
  filter: Spec.Filter,
): readonly { readonly field: string; readonly path: readonly Spec.PathSegment[] }[] => {
  switch (filter.op) {
    case 'and':
    case 'or': {
      return filter.filters.flatMap(inner => filterPaths(inner))
    }

    case 'not': {
      return filterPaths(filter.filter)
    }

    default: {
      return hasPath(filter) ? [{ field: filter.field, path: filter.path! }] : []
    }
  }
}

/** A path segment every backend can address: a non-empty key free of `"`, `\` and control
 * characters (sqlite's JSON path syntax cannot quote them), or a non-negative integer index. */
export const isPathSegment = (segment: unknown): segment is Spec.PathSegment =>
  typeof segment === 'number'
    ? Number.isSafeInteger(segment) && segment >= 0
    : typeof segment === 'string' &&
      segment.length > 0 &&
      segment.length <= 128 &&
      // oxlint-disable-next-line no-control-regex
      !/["\\\u0000-\u001F]/u.test(segment)
