import { escapeLike, refOf } from '../internal/filter'
import type { ClientDef } from '../types/client'

/**
 * The filter algebra of a resource's `list` / `$watch`, as ONE namespace — `where.eq(...)`,
 * `where.and(...)` — building exactly what the server's routes read (the db's own `where` on
 * the wire). Every leaf takes a field or a path into a `json` field (`['payload',
 * 'workspace']`); `startsWith` is `like` with the prefix escaped, so user input containing
 * `%` / `_` matches literally.
 */
export const where = {
  eq: (field: ClientDef.FieldRef, value: ClientDef.FilterValue): ClientDef.Filter => ({
    op: 'eq',
    ...refOf(field),
    value,
  }),
  ne: (field: ClientDef.FieldRef, value: ClientDef.FilterValue): ClientDef.Filter => ({
    op: 'ne',
    ...refOf(field),
    value,
  }),
  gt: (field: ClientDef.FieldRef, value: ClientDef.FilterValue): ClientDef.Filter => ({
    op: 'gt',
    ...refOf(field),
    value,
  }),
  gte: (field: ClientDef.FieldRef, value: ClientDef.FilterValue): ClientDef.Filter => ({
    op: 'gte',
    ...refOf(field),
    value,
  }),
  lt: (field: ClientDef.FieldRef, value: ClientDef.FilterValue): ClientDef.Filter => ({
    op: 'lt',
    ...refOf(field),
    value,
  }),
  lte: (field: ClientDef.FieldRef, value: ClientDef.FilterValue): ClientDef.Filter => ({
    op: 'lte',
    ...refOf(field),
    value,
  }),
  oneOf: (
    field: ClientDef.FieldRef,
    values: readonly ClientDef.FilterValue[],
  ): ClientDef.Filter => ({
    op: 'in',
    ...refOf(field),
    value: values,
  }),
  notOneOf: (
    field: ClientDef.FieldRef,
    values: readonly ClientDef.FilterValue[],
  ): ClientDef.Filter => ({ op: 'not-in', ...refOf(field), value: values }),
  like: (field: ClientDef.FieldRef, pattern: string): ClientDef.Filter => ({
    op: 'like',
    ...refOf(field),
    pattern,
  }),
  ilike: (field: ClientDef.FieldRef, pattern: string): ClientDef.Filter => ({
    op: 'like',
    ...refOf(field),
    pattern,
    insensitive: true,
  }),
  startsWith: (
    field: ClientDef.FieldRef,
    prefix: string,
    options?: { readonly insensitive?: boolean | undefined },
  ): ClientDef.Filter => ({
    op: 'like',
    ...refOf(field),
    pattern: `${escapeLike(prefix)}%`,
    ...(options?.insensitive ? { insensitive: true } : {}),
  }),
  isNull: (field: ClientDef.FieldRef): ClientDef.Filter => ({ op: 'is-null', ...refOf(field) }),
  notNull: (field: ClientDef.FieldRef): ClientDef.Filter => ({ op: 'not-null', ...refOf(field) }),
  and: (...filters: readonly ClientDef.Filter[]): ClientDef.Filter => ({ op: 'and', filters }),
  or: (...filters: readonly ClientDef.Filter[]): ClientDef.Filter => ({ op: 'or', filters }),
  not: (filter: ClientDef.Filter): ClientDef.Filter => ({ op: 'not', filter }),
}
