import { createHash, createHmac } from 'node:crypto'

import type { Helpers } from '../../types/helpers'

// AWS Signature Version 4 for S3, in the two shapes the client needs: request signing (an
// `Authorization` header over a hashed payload) and URL presigning (the signature carried in the
// query string over an UNSIGNED-PAYLOAD). Both share the canonical-request → string-to-sign →
// signing-key chain below.

const ALGORITHM = 'AWS4-HMAC-SHA256'

const hmac = (key: string | Uint8Array, data: string): Uint8Array =>
  createHmac('sha256', key).update(data).digest()

/** `20130524T000000Z` and `20130524` for "now". */
const stamps = (): { amzDate: string; dateStamp: string } => {
  const amzDate = new Date().toISOString().replaceAll(/[:-]|\.\d{3}/gu, '')

  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

const scopeOf = (config: Helpers.S3Config, dateStamp: string): string =>
  `${dateStamp}/${config.region}/s3/aws4_request`

/** kSecret → kDate → kRegion → kService → kSigning. */
const signingKey = (config: Helpers.S3Config, dateStamp: string): Uint8Array =>
  hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request',
  )

/** Query parameters, percent-encoded and sorted by name, as the canonical request wants them. */
const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

const signature = (
  config: Helpers.S3Config,
  stamp: { amzDate: string; dateStamp: string },
  canonicalRequest: string,
): string => {
  const stringToSign = [
    ALGORITHM,
    stamp.amzDate,
    scopeOf(config, stamp.dateStamp),
    sha256(canonicalRequest),
  ].join('\n')

  return createHmac('sha256', signingKey(config, stamp.dateStamp))
    .update(stringToSign)
    .digest('hex')
}

/** The payload hash S3 accepts in place of a real digest (presigned URLs, streamed bodies). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

/** RFC 3986 percent-encoding as S3 canonicalizes it (`!'()*` encoded too). */
export const rfc3986 = (segment: string): string =>
  encodeURIComponent(segment).replaceAll(
    /[!'()*]/gu,
    char => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`,
  )

/**
 * Sign one request: returns the headers to send — the caller's own headers plus `host`,
 * `x-amz-content-sha256`, `x-amz-date`, the session token when present, and `authorization`.
 * Every header present is signed, so the order of `SignedHeaders` is the sorted header list.
 */
export const authorize = (
  config: Helpers.S3Config,
  request: {
    method: string
    url: URL
    payloadHash: string
    headers?: Record<string, string> | undefined
  },
): Record<string, string> => {
  const stamp = stamps()
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    ),
    host: request.url.host,
    'x-amz-content-sha256': request.payloadHash,
    'x-amz-date': stamp.amzDate,
    ...(config.sessionToken ? { 'x-amz-security-token': config.sessionToken } : {}),
  }
  const signed = Object.keys(headers).toSorted()

  const canonicalRequest = [
    request.method,
    request.url.pathname,
    canonicalQuery(request.url),
    signed.map(key => `${key}:${headers[key]!.trim()}\n`).join(''),
    signed.join(';'),
    request.payloadHash,
  ].join('\n')

  headers['authorization'] =
    `${ALGORITHM} Credential=${config.accessKeyId}/${scopeOf(config, stamp.dateStamp)}, ` +
    `SignedHeaders=${signed.join(';')}, Signature=${signature(config, stamp, canonicalRequest)}`

  return headers
}

/**
 * Presign a URL: the signature rides in the query string, `host` is the only signed header and
 * the payload is unsigned — what a browser or a curl can use without credentials.
 */
export const presignUrl = (
  config: Helpers.S3Config,
  request: { method: string; url: URL; expiresIn: number },
): string => {
  const stamp = stamps()
  const url = new URL(request.url)

  url.searchParams.set('X-Amz-Algorithm', ALGORITHM)
  url.searchParams.set(
    'X-Amz-Credential',
    `${config.accessKeyId}/${scopeOf(config, stamp.dateStamp)}`,
  )
  url.searchParams.set('X-Amz-Date', stamp.amzDate)
  url.searchParams.set('X-Amz-Expires', String(request.expiresIn))
  url.searchParams.set('X-Amz-SignedHeaders', 'host')
  if (config.sessionToken) {
    url.searchParams.set('X-Amz-Security-Token', config.sessionToken)
  }

  const canonicalRequest = [
    request.method,
    url.pathname,
    canonicalQuery(url),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n')

  url.searchParams.set('X-Amz-Signature', signature(config, stamp, canonicalRequest))

  return url.toString()
}
