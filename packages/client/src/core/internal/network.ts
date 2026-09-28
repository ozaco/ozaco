/**
 * A platform transport fault — the fetch never produced a response (refused, reset, DNS, TLS), or
 * a streamed body broke mid-read — and its message: the platform code when there is one (Bun's
 * refused connection: `ConnectionRefused`, an EMPTY message), else the platform message, else the
 * error name. Fetch rejects those with a `TypeError` (spec) and Bun / Node add a string `code`;
 * aborts and timeouts are NOT network faults. Matched by NAME, not `instanceof DOMException`
 * (runtimes disagree on the constructor).
 */
export const networkFault = (value: unknown): false | string => {
  if (!(value instanceof Error)) {
    return false
  }

  const { name, code, message } = value as { name?: unknown; code?: unknown; message?: unknown }

  if (name === 'AbortError' || name === 'TimeoutError') {
    return false
  }

  if (typeof code === 'string' && code !== '') {
    return code
  }

  if (!(value instanceof TypeError)) {
    return false
  }

  return (
    (typeof message === 'string' && message) ||
    (typeof name === 'string' && name) ||
    'network error'
  )
}
