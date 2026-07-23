import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type {
  S3Client,
  S3File,
  S3ListOptions,
  S3ListResult,
  S3PresignOptions,
  S3Stat,
} from '../types/common'

const mapStat = (native: AnyType): S3Stat => ({
  size: Number(native?.size ?? 0),
  etag: native?.etag,
  lastModified: native?.lastModified,
  type: native?.type,
})

const mapList = (native: AnyType): S3ListResult => ({
  contents: ((native?.contents ?? []) as AnyType[]).map(entry => ({
    key: String(entry?.key ?? ''),
    size: entry?.size,
    lastModified: entry?.lastModified,
    etag: entry?.etag,
  })),
  truncated: Boolean(native?.isTruncated ?? native?.truncated ?? false),
  continuationToken: native?.nextContinuationToken ?? native?.continuationToken,
})

/**
 * Wrap a native S3 client (Bun's `S3Client` on Bun, a SigV4-over-`fetch` client elsewhere) as an
 * effect-native {@link S3Client}. `native` is `null` on runtimes with no S3 at all (e.g. the browser) —
 * the client is still constructible so the platform surface stays uniform, but every operation fails
 * `io-unsupported`. Native async calls are `until`-wrapped; file handles are lazy — nothing hits the
 * network until an operation runs.
 */
export const createS3 = (native: AnyType): S3Client => {
  const client: AnyType = native

  const useClient = operation(function* () {
    if (!client) {
      return yield* fail('io-unsupported', 'IO.s3 requires Bun (S3Client is unavailable here)')
    }
    return client
  })

  const fileOf = operation(function* (key: string) {
    return (yield* useClient()).file(key)
  })

  const file = (key: string): S3File => ({
    key,
    text: operation(function* () {
      return yield* until((yield* fileOf(key)).text())
    }),
    json: operation(function* () {
      return yield* until((yield* fileOf(key)).json())
    }) as S3File['json'],
    bytes: operation(function* () {
      return yield* until((yield* fileOf(key)).bytes())
    }),
    arrayBuffer: operation(function* () {
      return yield* until((yield* fileOf(key)).arrayBuffer())
    }),
    stream: operation(function* () {
      // Bun's `S3File.stream()` is sync (a `ReadableStream`); the fetch client's is async (`Promise`).
      // `Promise.resolve` normalizes both so `until` yields the stream either way.
      return yield* until(Promise.resolve((yield* fileOf(key)).stream()))
    }),
    write: operation(function* (data: Uint8Array | string | Blob) {
      return yield* until((yield* fileOf(key)).write(data))
    }),
    exists: operation(function* () {
      return yield* until((yield* fileOf(key)).exists())
    }),
    delete: operation(function* () {
      yield* until((yield* fileOf(key)).delete())
    }),
    stat: operation(function* () {
      return mapStat(yield* until((yield* fileOf(key)).stat()))
    }),
    presign: operation(function* (presignOptions?: S3PresignOptions) {
      return (yield* fileOf(key)).presign(presignOptions) as string
    }),
  })

  return {
    file,
    read: operation(function* (key: string) {
      return yield* until((yield* useClient()).file(key).bytes())
    }),
    write: operation(function* (key: string, data: Uint8Array | string | Blob) {
      return yield* until((yield* useClient()).write(key, data))
    }),
    exists: operation(function* (key: string) {
      return yield* until((yield* useClient()).exists(key))
    }),
    delete: operation(function* (key: string) {
      yield* until((yield* useClient()).delete(key))
    }),
    stat: operation(function* (key: string) {
      return mapStat(yield* until((yield* useClient()).stat(key)))
    }),
    list: operation(function* (listOptions?: S3ListOptions) {
      return mapList(yield* until((yield* useClient()).list(listOptions)))
    }),
    presign: operation(function* (key: string, presignOptions?: S3PresignOptions) {
      return (yield* useClient()).presign(key, presignOptions) as string
    }),
  }
}
