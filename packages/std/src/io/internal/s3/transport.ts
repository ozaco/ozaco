import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'

import { baseUrl } from './config'
import { authorize, rfc3986, sha256 } from './sign'

/** Every path segment of a key percent-encoded, slashes kept. */
const encodeKey = (key: string): string => key.split('/').map(rfc3986).join('/')

/**
 * Turn a non-2xx response into an `IOErrors.S3Failed` failure. Thrown inside the promise-returning
 * client methods, the rejection travels through `createS3`'s `until` wrapping, so effect callers
 * observe a tagged failure, not a bare `Error`.
 */
export const ensureOk = (response: Response, subject: string): void => {
  if (!response.ok) {
    throw fail(IOErrors.S3Failed, `s3 ${response.status} ${response.statusText} for "${subject}"`)
  }
}

/**
 * The signed HTTP side of the fetch client: builds path-style URLs for the bucket and its objects
 * and sends one request at a time — hashing the body, signing the headers, calling `fetch` (read
 * from `globalThis` at call time, so tests can stub it).
 */
export const createTransport = (config: Helpers.S3Config): Helpers.S3Transport => {
  const base = baseUrl(config)

  return {
    config,

    objectUrl: key => new URL(`${base}/${config.bucket}/${encodeKey(key)}`),

    bucketUrl: () => new URL(`${base}/${config.bucket}`),

    send: request => {
      const headers = authorize(config, {
        method: request.method,
        url: request.url,
        payloadHash: sha256(request.body ?? ''),
        headers: request.headers,
      })

      return globalThis.fetch(request.url, {
        method: request.method,
        headers,
        body: request.body ?? null,
      } as AnyType)
    },
  }
}
