import type { Spec } from '../types/spec'

/** `field = value` (`null` behaves as IS NULL). */
export const eq = (field: string, value: Spec.FilterValue): Spec.Filter => ({
  op: 'eq',
  field,
  value,
})

/** `field != value` (`null` behaves as IS NOT NULL). */
export const ne = (field: string, value: Spec.FilterValue): Spec.Filter => ({
  op: 'ne',
  field,
  value,
})

/** `field > value` */
export const gt = (field: string, value: Spec.FilterValue): Spec.Filter => ({
  op: 'gt',
  field,
  value,
})

/** `field >= value` */
export const gte = (field: string, value: Spec.FilterValue): Spec.Filter => ({
  op: 'gte',
  field,
  value,
})

/** `field < value` */
export const lt = (field: string, value: Spec.FilterValue): Spec.Filter => ({
  op: 'lt',
  field,
  value,
})

/** `field <= value` */
export const lte = (field: string, value: Spec.FilterValue): Spec.Filter => ({
  op: 'lte',
  field,
  value,
})

/** `field` is one of `values`. */
export const oneOf = (field: string, values: readonly Spec.FilterValue[]): Spec.Filter => ({
  op: 'in',
  field,
  value: values,
})

/** `field` is none of `values`. */
export const notOneOf = (field: string, values: readonly Spec.FilterValue[]): Spec.Filter => ({
  op: 'not-in',
  field,
  value: values,
})

/** SQL-style pattern match (`%`/`_` wildcards), case-sensitive. */
export const like = (field: string, pattern: string): Spec.Filter => ({
  op: 'like',
  field,
  pattern,
})

/** SQL-style pattern match, case-insensitive. */
export const ilike = (field: string, pattern: string): Spec.Filter => ({
  op: 'like',
  field,
  pattern,
  insensitive: true,
})

export const isNull = (field: string): Spec.Filter => ({ op: 'is-null', field })
export const notNull = (field: string): Spec.Filter => ({ op: 'not-null', field })

export const and = (...filters: readonly Spec.Filter[]): Spec.Filter => ({ op: 'and', filters })
export const or = (...filters: readonly Spec.Filter[]): Spec.Filter => ({ op: 'or', filters })
export const not = (filter: Spec.Filter): Spec.Filter => ({ op: 'not', filter })

/** Every field name a filter references (for validation against a table's columns). */
export const filterFields = (filter: Spec.Filter): readonly string[] => {
  switch (filter.op) {
    case 'and':
    case 'or': {
      return filter.filters.flatMap(filterFields)
    }

    case 'not': {
      return filterFields(filter.filter)
    }

    default: {
      return [filter.field]
    }
  }
}
