import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { createHash, createHmac } from 'node:crypto'

import type { S3ListOptions, S3Options, S3PresignOptions } from '../types/common'
import type { Helpers } from '../types/helpers'

// A dependency-free, SigV4-signed S3 client over `fetch` (Node / any runtime without Bun's native
// `S3Client`). It mirrors the slice of Bun's `S3Client` shape that `createS3` consumes, so the same
// effect-native wrapper drives both. Path-style addressing (`<endpoint>/<bucket>/<key>`) — works with
// MinIO and any S3-compatible endpoint; falls back to AWS virtual-hosted style when no endpoint is set.

const env = (key: string): string | undefined => (globalThis as AnyType).process?.env?.[key]

const resolveConfig = (options: S3Options): Helpers.Config => ({
  accessKeyId: options.accessKeyId ?? env('S3_ACCESS_KEY_ID') ?? env('AWS_ACCESS_KEY_ID') ?? '',
  secretAccessKey:
    options.secretAccessKey ?? env('S3_SECRET_ACCESS_KEY') ?? env('AWS_SECRET_ACCESS_KEY') ?? '',
  sessionToken: options.sessionToken ?? env('S3_SESSION_TOKEN') ?? env('AWS_SESSION_TOKEN'),
  region: options.region ?? env('S3_REGION') ?? env('AWS_REGION') ?? 'us-east-1',
  bucket: options.bucket ?? env('S3_BUCKET') ?? '',
  endpoint: options.endpoint ?? env('S3_ENDPOINT') ?? env('AWS_ENDPOINT_URL_S3'),
})

const rfc3986 = (segment: string): string =>
  encodeURIComponent(segment).replaceAll(
    /[!'()*]/gu,
    char => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`,
  )

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

const hmac = (key: string | Uint8Array, data: string): Uint8Array =>
  createHmac('sha256', key).update(data).digest()

const signingKey = (config: Helpers.Config, dateStamp: string): Uint8Array =>
  hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 's3'),
    'aws4_request',
  )

const amzStamps = (): { amzDate: string; dateStamp: string } => {
  const amzDate = new Date().toISOString().replaceAll(/[:-]|\.\d{3}/gu, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

/** SigV4-sign a request into the headers to send (authorization + x-amz-*). */
const signHeaders = (
  config: Helpers.Config,
  request: { method: string; url: URL; payloadHash: string },
): Record<string, string> => {
  const { method, url, payloadHash } = request
  const { amzDate, dateStamp } = amzStamps()
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(config.sessionToken ? { 'x-amz-security-token': config.sessionToken } : {}),
  }
  const signed = Object.keys(headers)
    .map(key => key.toLowerCase())
    .toSorted()
  const canonicalHeaders = signed.map(key => `${key}:${headers[key]!.trim()}\n`).join('')
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url),
    canonicalHeaders,
    signed.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(config, dateStamp))
    .update(stringToSign)
    .digest('hex')
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`
  return headers
}

const listPart = (xml: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(xml)?.[1]

// Thrown inside the promise-returning client methods: the rejection carries the Failure through
// `createS3`'s `until` wrapping, so effect callers observe an `s3-failed` failure, not a bare Error.
const ensureOk = (response: Response, key: string): void => {
  if (!response.ok) {
    throw fail('s3-failed', `s3 ${response.status} ${response.statusText} for "${key}"`)
  }
}

export const fetchS3Client = (options: S3Options): AnyType => {
  const config = resolveConfig(options)
  const base = (config.endpoint ?? `https://s3.${config.region}.amazonaws.com`).replace(/\/$/u, '')

  const objectUrl = (key: string): URL =>
    new URL(`${base}/${config.bucket}/${key.split('/').map(rfc3986).join('/')}`)

  const send = (method: string, key: string, body?: Uint8Array | string): Promise<Response> => {
    const url = objectUrl(key)
    const headers = signHeaders(config, { method, url, payloadHash: sha256(body ?? '') })
    return globalThis.fetch(url, { method, headers, body: body ?? null } as AnyType)
  }

  // Presigned URLs sign into the query string (not an Authorization header), with `host` as the only
  // signed header and an UNSIGNED-PAYLOAD.
  const presign = (key: string, presignOptions: S3PresignOptions = {}): string => {
    const method = presignOptions.method ?? 'GET'
    const { amzDate, dateStamp } = amzStamps()
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`
    const url = objectUrl(key)
    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
    url.searchParams.set('X-Amz-Credential', `${config.accessKeyId}/${scope}`)
    url.searchParams.set('X-Amz-Date', amzDate)
    url.searchParams.set('X-Amz-Expires', String(presignOptions.expiresIn ?? 86_400))
    url.searchParams.set('X-Amz-SignedHeaders', 'host')
    if (config.sessionToken) {
      url.searchParams.set('X-Amz-Security-Token', config.sessionToken)
    }
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery(url),
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
    const signature = createHmac('sha256', signingKey(config, dateStamp))
      .update(stringToSign)
      .digest('hex')
    url.searchParams.set('X-Amz-Signature', signature)
    return url.toString()
  }

  const file = (key: string): AnyType => ({
    text: async () => {
      const response = await send('GET', key)
      ensureOk(response, key)
      return response.text()
    },
    json: async () => {
      const response = await send('GET', key)
      ensureOk(response, key)
      return response.json()
    },
    arrayBuffer: async () => {
      const response = await send('GET', key)
      ensureOk(response, key)
      return response.arrayBuffer()
    },
    bytes: async () => {
      const response = await send('GET', key)
      ensureOk(response, key)
      return new Uint8Array(await response.arrayBuffer())
    },
    stream: async () => {
      const response = await send('GET', key)
      ensureOk(response, key)
      return response.body
    },
    write: async (data: Uint8Array | string) => {
      const response = await send('PUT', key, data)
      ensureOk(response, key)
      return typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength
    },
    exists: async () => {
      const response = await send('HEAD', key)
      return response.ok
    },
    delete: async () => {
      await send('DELETE', key)
    },
    stat: async () => {
      const response = await send('HEAD', key)
      ensureOk(response, key)
      const lastModified = response.headers.get('last-modified')
      return {
        size: Number(response.headers.get('content-length') ?? 0),
        etag: response.headers.get('etag') ?? undefined,
        lastModified: lastModified ? new Date(lastModified) : undefined,
        type: response.headers.get('content-type') ?? undefined,
      }
    },
    presign: (presignOptions?: S3PresignOptions) => presign(key, presignOptions),
  })

  const list = async (listOptions: S3ListOptions = {}) => {
    const url = new URL(`${base}/${config.bucket}`)
    url.searchParams.set('list-type', '2')
    if (listOptions.prefix) {
      url.searchParams.set('prefix', listOptions.prefix)
    }
    if (listOptions.maxKeys) {
      url.searchParams.set('max-keys', String(listOptions.maxKeys))
    }
    if (listOptions.continuationToken) {
      url.searchParams.set('continuation-token', listOptions.continuationToken)
    }
    if (listOptions.startAfter) {
      url.searchParams.set('start-after', listOptions.startAfter)
    }
    const headers = signHeaders(config, { method: 'GET', url, payloadHash: sha256('') })
    const response = await globalThis.fetch(url, { method: 'GET', headers } as AnyType)
    ensureOk(response, config.bucket)
    const xml = await response.text()
    const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)].map(match => {
      const entry = match[1]!
      const modified = listPart(entry, 'LastModified')
      return {
        key: listPart(entry, 'Key') ?? '',
        size: Number(listPart(entry, 'Size') ?? 0),
        etag: listPart(entry, 'ETag'),
        lastModified: modified ? new Date(modified) : undefined,
      }
    })
    return {
      contents,
      isTruncated: listPart(xml, 'IsTruncated') === 'true',
      nextContinuationToken: listPart(xml, 'NextContinuationToken'),
    }
  }

  return {
    file,
    write: (key: string, data: Uint8Array | string) => file(key).write(data),
    exists: (key: string) => file(key).exists(),
    delete: (key: string) => file(key).delete(),
    stat: (key: string) => file(key).stat(),
    presign,
    list,
  }
}
