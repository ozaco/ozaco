import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import { DbErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'
import { isPathSegment } from '../utils/filter'

const SCALAR_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])

const isValue = (value: unknown): value is Spec.FilterValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'

const reject = (reason: string) => fail(DbErrors.Validation, `invalid filter: ${reason}`)

/** Rebuild one node of an untrusted filter under the walk's budget/policy (`db.validation` on any
 * violation). */
export function* walk(
  input: unknown,
  ctx: Helpers.SanitizeWalk,
  depth: number,
): Operation<Spec.Filter> {
  if (depth > ctx.maxDepth) {
    return yield* reject(`nesting deeper than ${ctx.maxDepth}`)
  }

  ctx.conditions += 1

  if (ctx.conditions > ctx.maxConditions) {
    return yield* reject(`more than ${ctx.maxConditions} conditions`)
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return yield* reject('filter node must be an object')
  }

  const node = input as Record<string, unknown>
  const op = node.op

  if (typeof op !== 'string' || (ctx.ops && !ctx.ops.has(op))) {
    return yield* reject(`operator "${String(op)}" is not allowed`)
  }

  if (op === 'and' || op === 'or') {
    if (!Array.isArray(node.filters)) {
      return yield* reject(`"${op}" expects a filters array`)
    }

    const filters: Spec.Filter[] = []

    for (const child of node.filters) {
      filters.push(yield* walk(child, ctx, depth + 1))
    }

    return { op, filters }
  }

  if (op === 'not') {
    return { op, filter: yield* walk(node.filter, ctx, depth + 1) }
  }

  const field = node.field

  if (typeof field !== 'string' || !ctx.fields.has(field)) {
    return yield* reject(`field "${String(field)}" is not allowed`)
  }

  // an optional path INTO the (json) field — the field itself is what the policy allows
  let at: { readonly path?: readonly Spec.PathSegment[] } = {}

  if (node.path !== undefined) {
    if (
      !Array.isArray(node.path) ||
      node.path.length > 16 ||
      !node.path.every(segment => isPathSegment(segment))
    ) {
      return yield* reject(`invalid path on field "${field}"`)
    }

    at = node.path.length === 0 ? {} : { path: [...(node.path as Spec.PathSegment[])] }
  }

  if (SCALAR_OPS.has(op)) {
    if (!isValue(node.value)) {
      return yield* reject(`"${op}" expects a scalar value`)
    }

    return { op: op as 'eq', field, ...at, value: node.value }
  }

  if (op === 'in' || op === 'not-in') {
    // `value` is canonical; `values` stays accepted on the wire (older clients)
    const list = node.value ?? node.values

    if (!Array.isArray(list) || !list.every(isValue)) {
      return yield* reject(`"${op}" expects an array of scalar values`)
    }

    return { op, field, ...at, value: list as Spec.FilterValue[] }
  }

  if (op === 'like') {
    if (typeof node.pattern !== 'string') {
      return yield* reject('"like" expects a string pattern')
    }

    return { op, field, ...at, pattern: node.pattern, insensitive: node.insensitive === true }
  }

  if (op === 'is-null' || op === 'not-null') {
    return { op, field, ...at }
  }

  return yield* reject(`unknown operator "${op}"`)
}
