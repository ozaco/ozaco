import { walk } from '../internal/sanitize'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'

/**
 * Validate an UNTRUSTED, wire-supplied filter against a policy and rebuild it as a clean
 * {@link Spec.Filter} (extra properties stripped, every field/operator/value shape checked).
 * Fails `db.validation` on any violation — the front door for client-driven queries.
 */
export function* sanitizeFilter(input: unknown, policy: Database.FilterPolicy) {
  const ctx: Helpers.SanitizeWalk = {
    maxDepth: policy.maxDepth ?? 8,
    maxConditions: policy.maxConditions ?? 32,
    fields: new Set(policy.fields),
    ops: policy.ops ? new Set<string>(policy.ops) : null,
    conditions: 0,
  }

  return yield* walk(input, ctx, 1)
}

/** Clamp an untrusted page size into `[1, max]`. */
export const clampLimit = (value: unknown, max: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 1

  return Math.max(1, Math.min(parsed, Math.max(1, Math.trunc(max))))
}
