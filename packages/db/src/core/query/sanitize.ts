// oxlint-disable import/exports-last
import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrors } from '../errors'
import type { Filter, FilterValue } from '../types'

/** What an untrusted (wire-supplied) filter is allowed to reference. */
export interface FilterPolicy {
  /** Field names the filter may reference. */
  readonly fields: readonly string[]
  /** Allowed operators; defaults to the full algebra. */
  readonly ops?: readonly Filter['op'][] | undefined
  /** Maximum nesting depth of and/or/not. Default 8. */
  readonly maxDepth?: number | undefined
  /** Maximum total number of conditions. Default 32. */
  readonly maxConditions?: number | undefined
}

const SCALAR_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])

const isValue = (value: unknown): value is FilterValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean'

interface Budget {
  conditions: number
}

const reject = (reason: string) => fail(DbErrors.Validation, `invalid filter: ${reason}`)

interface WalkContext {
  readonly maxDepth: number
  readonly maxConditions: number
  readonly fields: ReadonlySet<string>
  readonly ops: ReadonlySet<string> | null
  readonly budget: Budget
}

const walk = function* (
  input: unknown,
  ctx: WalkContext,
  depth: number,
): Generator<AnyType, Filter, AnyType> {
  if (depth > ctx.maxDepth) {
    return yield* reject(`nesting deeper than ${ctx.maxDepth}`)
  }
  ctx.budget.conditions += 1
  if (ctx.budget.conditions > ctx.maxConditions) {
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
    const inner: Filter[] = []
    for (const child of node.filters) {
      inner.push(yield* walk(child, ctx, depth + 1))
    }
    return { op, filters: inner }
  }
  if (op === 'not') {
    return { op, filter: yield* walk(node.filter, ctx, depth + 1) }
  }

  const field = node.field
  if (typeof field !== 'string' || !ctx.fields.has(field)) {
    return yield* reject(`field "${String(field)}" is not allowed`)
  }
  if (SCALAR_OPS.has(op)) {
    if (!isValue(node.value)) {
      return yield* reject(`"${op}" expects a scalar value`)
    }
    return { op: op as 'eq', field, value: node.value }
  }
  if (op === 'in' || op === 'not-in') {
    if (!Array.isArray(node.values) || !node.values.every(isValue)) {
      return yield* reject(`"${op}" expects an array of scalar values`)
    }
    return { op, field, values: node.values as FilterValue[] }
  }
  if (op === 'like') {
    if (typeof node.pattern !== 'string') {
      return yield* reject('"like" expects a string pattern')
    }
    return { op, field, pattern: node.pattern, insensitive: node.insensitive === true }
  }
  if (op === 'is-null' || op === 'not-null') {
    return { op, field }
  }
  return yield* reject(`unknown operator "${op}"`)
}

/**
 * Validate an UNTRUSTED, wire-supplied filter against a policy and rebuild it as a clean
 * {@link Filter} (extra properties stripped, every field/operator/value shape checked). Fails
 * `db.validation` on any violation — the front door for client-driven queries.
 */
export const sanitizeFilter = operation(function* (input: unknown, policy: FilterPolicy) {
  const ctx: WalkContext = {
    maxDepth: policy.maxDepth ?? 8,
    maxConditions: policy.maxConditions ?? 32,
    fields: new Set(policy.fields),
    ops: policy.ops ? new Set<string>(policy.ops) : null,
    budget: { conditions: 0 },
  }
  return yield* walk(input, ctx, 1)
})

/** Clamp an untrusted page size into `[1, max]`. */
export const clampLimit = (value: unknown, max: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 1
  return Math.max(1, Math.min(parsed, Math.max(1, Math.trunc(max))))
}
