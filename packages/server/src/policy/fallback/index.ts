/**
 * `server:policy/fallback` — replaces failures with a fallback value. Catches both raised
 * infrastructure failures and business `failure` replies; a `when` predicate scopes which failures
 * fall back, and the value comes from a static `value` or an effectful `handler`.
 */
export * from './definition'
export type * from './types'
