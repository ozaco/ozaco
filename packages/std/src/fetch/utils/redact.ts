import { SENSITIVE_KEYS } from '../const'
import { REDACTED, USERINFO } from '../internal/const'
import { keyOf, setOf } from '../internal/redact'

/**
 * Whether `name` — a query key, a header name, a body / frame key — holds a secret: one of `keys`
 * (default {@link SENSITIVE_KEYS}), matched case-insensitively after decoding (`+`, percent
 * escapes). A list is read once per array object: pass a new array to change it.
 */
export const isSensitiveKey = (name: string, keys: readonly string[] = SENSITIVE_KEYS): boolean =>
  setOf(keys).has(keyOf(name))

/**
 * A query string safe for telemetry: the value of every sensitive parameter (one of `keys`,
 * {@link isSensitiveKey}) becomes `REDACTED`.
 * Everything else is kept byte for byte, a leading `?` included (`url.query` has none, a URL's
 * `search` has one).
 */
export const redactQuery = (query: string, keys: readonly string[] = SENSITIVE_KEYS): string => {
  const prefix = query.startsWith('?') ? '?' : ''
  const body = query.slice(prefix.length)

  if (!body.includes('=')) {
    return query
  }

  const parts = body.split('&').map(part => {
    const at = part.indexOf('=')

    if (at === -1) {
      return part
    }

    const key = part.slice(0, at)

    return isSensitiveKey(key, keys) ? `${key}=${REDACTED}` : part
  })

  return `${prefix}${parts.join('&')}`
}

/**
 * A URL safe for telemetry (`url.full`): credentials become `REDACTED:REDACTED`
 * (`https://REDACTED:REDACTED@host/`), sensitive query values `REDACTED` (one of `keys`, {@link redactQuery} —
 * applied to a `key=value` fragment too, e.g. an OAuth `#access_token=`). Works on the text, so a
 * relative or unparsable URL is redacted as well; nothing else changes.
 */
export const redactUrl = (url: string, keys: readonly string[] = SENSITIVE_KEYS): string => {
  const hashAt = url.indexOf('#')
  const head = hashAt === -1 ? url : url.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)

  const queryAt = head.indexOf('?')
  const base = queryAt === -1 ? head : head.slice(0, queryAt)
  const query = queryAt === -1 ? '' : head.slice(queryAt)

  const authority = base.replace(USERINFO, `$1${REDACTED}:${REDACTED}@`)
  const fragment = hash ? `#${redactQuery(hash.slice(1), keys)}` : ''

  return `${authority}${redactQuery(query, keys)}${fragment}`
}
