import { REDACTED, SENSITIVE_QUERY_KEYS, USERINFO } from '../internal/const'
import { keyOf } from '../internal/redact'

/**
 * A query string safe for telemetry: the value of every sensitive parameter (the OTel list —
 * `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `AWSAccessKeyId`, `Signature`,
 * `sig`, `X-Goog-Signature` — plus `key`, `api_key`, `apikey`, `token`, `access_token`,
 * `password`, `secret`; keys matched case-insensitively after decoding) becomes `REDACTED`.
 * Everything else is kept byte for byte, a leading `?` included (`url.query` has none, a URL's
 * `search` has one).
 */
export const redactQuery = (query: string): string => {
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
    return SENSITIVE_QUERY_KEYS.has(keyOf(key)) ? `${key}=${REDACTED}` : part
  })

  return `${prefix}${parts.join('&')}`
}

/**
 * A URL safe for telemetry (`url.full`): credentials become `REDACTED:REDACTED`
 * (`https://REDACTED:REDACTED@host/`), sensitive query values `REDACTED` ({@link redactQuery} —
 * applied to a `key=value` fragment too, e.g. an OAuth `#access_token=`). Works on the text, so a
 * relative or unparsable URL is redacted as well; nothing else changes.
 */
export const redactUrl = (url: string): string => {
  const hashAt = url.indexOf('#')
  const head = hashAt === -1 ? url : url.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)

  const queryAt = head.indexOf('?')
  const base = queryAt === -1 ? head : head.slice(0, queryAt)
  const query = queryAt === -1 ? '' : head.slice(queryAt)

  const authority = base.replace(USERINFO, `$1${REDACTED}:${REDACTED}@`)
  const fragment = hash ? `#${redactQuery(hash.slice(1))}` : ''

  return `${authority}${redactQuery(query)}${fragment}`
}
