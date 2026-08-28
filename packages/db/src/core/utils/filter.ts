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

/** The portable filter algebra: `where.eq('done', false)`, `where.and(a, b)`, … */
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
  isNull,
  notNull,
  and,
  or,
  not,
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
