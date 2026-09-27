/**
 * The matchers `TransportErrors` folds a backend client's own errors with (`asFailure(error,
 * TransportErrors)`). Matched by NAME, never `instanceof`: core imports no driver, and an
 * optional driver's error classes may come from another copy of it. A NATS `RequestError`
 * carries its reason (`NoRespondersError`, `TimeoutError`) as its `cause` — the reason is what
 * is matched.
 */

/** A field of a foreign value (`undefined` for a value that has no fields). */
const fieldOf = (value: unknown, key: 'cause' | 'name' | 'subject'): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

/** What a client error says went wrong: a `RequestError`'s `cause`, else the error itself. */
const requestCauseOf = (value: unknown): unknown =>
  fieldOf(value, 'name') === 'RequestError' ? (fieldOf(value, 'cause') ?? value) : value

/** A request nobody answered — NATS's `NoRespondersError` (named `NoResponders`), bare or as a
 * `RequestError`'s cause; the message names its subject. */
export const noResponders = (value: unknown): false | string => {
  const reason = requestCauseOf(value)

  if (fieldOf(reason, 'name') !== 'NoResponders') {
    return false
  }

  const subject = fieldOf(reason, 'subject')

  return `no responders on "${typeof subject === 'string' ? subject : ''}"`
}

/** A request whose deadline passed — a `TimeoutError` (NATS's, a platform deadline's), bare or
 * as a `RequestError`'s cause. */
export const timedOut = (value: unknown): false | string =>
  fieldOf(requestCauseOf(value), 'name') === 'TimeoutError' && 'request timed out'
