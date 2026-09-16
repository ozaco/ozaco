export const CONTEXT = Symbol.for('std:effect:context')
export const API = Symbol.for('std:effect:api')

/** Retry-budget defaults (`budgetOf`): 5 tries, 250ms, constant delay, capped at 30s. */
export const BUDGET_DEFAULTS = {
  retries: 5,
  delayMs: 250,
  backoff: 1,
  maxDelayMs: 30_000,
} as const
