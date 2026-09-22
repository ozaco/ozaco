import type { Spec } from '../types/spec'

/**
 * The filter algebra as ONE namespace — `where.eq(...)`, `where.and(...)` — so nothing generic
 * (`eq`, `or`, `not`, `like`…) lands in your import scope.
 *
 * Every builder remembers the field it names in the type it returns, so
 * `db.query('todos').filter(where.eq('dnoe', false))` is a COMPILE error: a `Filter<'dnoe'>`
 * does not fit a query whose fields are `'title' | 'done' | …`.
 */
const eq = <const TField extends string>(
  field: TField,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'eq', field, value })

const ne = <const TField extends string>(
  field: TField,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'ne', field, value })

const gt = <const TField extends string>(
  field: TField,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'gt', field, value })

const gte = <const TField extends string>(
  field: TField,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'gte', field, value })

const lt = <const TField extends string>(
  field: TField,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'lt', field, value })

const lte = <const TField extends string>(
  field: TField,
  value: Spec.FilterValue,
): Spec.Filter<TField> => ({ op: 'lte', field, value })

const oneOf = <const TField extends string>(
  field: TField,
  values: readonly Spec.FilterValue[],
): Spec.Filter<TField> => ({ op: 'in', field, value: values })

const notOneOf = <const TField extends string>(
  field: TField,
  values: readonly Spec.FilterValue[],
): Spec.Filter<TField> => ({ op: 'not-in', field, value: values })

const like = <const TField extends string>(
  field: TField,
  pattern: string,
): Spec.Filter<TField> => ({ op: 'like', field, pattern })

const ilike = <const TField extends string>(
  field: TField,
  pattern: string,
): Spec.Filter<TField> => ({ op: 'like', field, pattern, insensitive: true })

/** Escape `%`, `_` and `\` so `text` matches ITSELF inside a `like` pattern — what to wrap user
 * input in before concatenating your own wildcards: `where.like('name', `${escapeLike(q)}%`)`. */
const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/gu, String.raw`\$&`)

const startsWith = <const TField extends string>(
  field: TField,
  prefix: string,
  options?: { readonly insensitive?: boolean | undefined },
): Spec.Filter<TField> => ({
  op: 'like',
  field,
  pattern: `${escapeLike(prefix)}%`,
  ...(options?.insensitive ? { insensitive: true } : {}),
})

const isNull = <const TField extends string>(field: TField): Spec.Filter<TField> => ({
  op: 'is-null',
  field,
})

const notNull = <const TField extends string>(field: TField): Spec.Filter<TField> => ({
  op: 'not-null',
  field,
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

    case 'eq': {
      return { [filter.field]: filter.value }
    }

    case 'is-null': {
      return { [filter.field]: null }
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
