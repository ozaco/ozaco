import type { Filter, FilterValue } from '../types'

/** `field = value` */
export const eq = (field: string, value: FilterValue): Filter => ({ op: 'eq', field, value })
/** `field != value` */
export const ne = (field: string, value: FilterValue): Filter => ({ op: 'ne', field, value })
/** `field > value` */
export const gt = (field: string, value: FilterValue): Filter => ({ op: 'gt', field, value })
/** `field >= value` */
export const gte = (field: string, value: FilterValue): Filter => ({ op: 'gte', field, value })
/** `field < value` */
export const lt = (field: string, value: FilterValue): Filter => ({ op: 'lt', field, value })
/** `field <= value` */
export const lte = (field: string, value: FilterValue): Filter => ({ op: 'lte', field, value })

/** `field` is one of `values`. */
export const oneOf = (field: string, values: readonly FilterValue[]): Filter => ({
  op: 'in',
  field,
  values,
})

/** `field` is none of `values`. */
export const notOneOf = (field: string, values: readonly FilterValue[]): Filter => ({
  op: 'not-in',
  field,
  values,
})

/** SQL-style pattern match (`%`/`_` wildcards), case-sensitive. */
export const like = (field: string, pattern: string): Filter => ({ op: 'like', field, pattern })

/** SQL-style pattern match, case-insensitive. */
export const ilike = (field: string, pattern: string): Filter => ({
  op: 'like',
  field,
  pattern,
  insensitive: true,
})

export const isNull = (field: string): Filter => ({ op: 'is-null', field })
export const notNull = (field: string): Filter => ({ op: 'not-null', field })

export const and = (...filters: readonly Filter[]): Filter => ({ op: 'and', filters })
export const or = (...filters: readonly Filter[]): Filter => ({ op: 'or', filters })
export const not = (filter: Filter): Filter => ({ op: 'not', filter })

/** Every field name a filter references (for validation against a table's columns). */
export const filterFields = (filter: Filter): readonly string[] => {
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
