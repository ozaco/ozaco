import type { Operation } from 'std:effect'
import { operation, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { IOErrors } from '../../errors'
import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'

const mapStat = (native: AnyType): IODef.S3Stat => ({
  size: Number(native?.size ?? 0),
  etag: native?.etag ?? native?.eTag,
  lastModified: native?.lastModified,
  type: native?.type,
})

const mapList = (native: AnyType): IODef.S3ListResult => ({
  contents: ((native?.contents ?? []) as AnyType[]).map(entry => ({
    key: String(entry?.key ?? ''),
    size: entry?.size,
    lastModified: entry?.lastModified,
    etag: entry?.etag ?? entry?.eTag,
  })),
  truncated: Boolean(native?.isTruncated ?? native?.truncated ?? false),
  continuationToken: native?.nextContinuationToken ?? native?.continuationToken,
})

/**
 * Stream a body into a native file. Bun's `IODef.S3File` exposes a multipart `writer()` sink — chunks go
 * up as they are read; the fetch client accepts the stream itself (its own multipart path).
 */
const writeBody = async (file: Helpers.S3NativeFile, data: IODef.S3Body): Promise<number> => {
  if (!(data instanceof ReadableStream) || typeof file.writer !== 'function') {
    return file.write(data)
  }

  const sink = file.writer()
  const reader = data.getReader()

  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: one chunk in memory at a time
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      // oxlint-disable-next-line no-await-in-loop -- the sink applies backpressure per chunk
      await sink.write(value)
    }
  } finally {
    reader.releaseLock()
  }

  return sink.end()
}

/**
 * Wrap a native S3 client (Bun's `IODef.S3Client` on Bun, the SigV4-over-`fetch` client elsewhere) as an
 * effect-native {@link IODef.S3Client}. `native` is `null` on runtimes with no S3 at all (the browser) —
 * the client is still constructible so the platform surface stays uniform, but every operation
 * fails `IOErrors.Unsupported`. Native async calls are `until`-wrapped; file handles are lazy —
 * nothing hits the network until an operation runs. Reads stream (`stream()` hands the network
 * body over as it arrives) and writes stream (a `ReadableStream` body goes up multipart).
 */
export const createS3 = (native: Helpers.S3Native | null): IODef.S3Client => {
  const useClient = operation(function* () {
    if (!native) {
      return yield* fail(
        IOErrors.Unsupported,
        'IO.s3 is not available in a web environment (no S3 client on this runtime)',
      )
    }

    return native
  })

  const fileOf = operation(function* (key: string) {
    return (yield* useClient()).file(key)
  })

  const file = (key: string): IODef.S3File => ({
    key,

    *text() {
      return yield* until((yield* fileOf(key)).text())
    },
    *json<T = unknown>(): Operation<T> {
      return (yield* until((yield* fileOf(key)).json())) as T
    },
    *bytes() {
      return yield* until((yield* fileOf(key)).bytes())
    },
    *arrayBuffer() {
      return yield* until((yield* fileOf(key)).arrayBuffer())
    },
    *stream() {
      // Bun's `stream()` is sync (a `ReadableStream`), the fetch client's is a Promise —
      // `Promise.resolve` normalizes both so `until` yields the stream either way.
      return yield* until(Promise.resolve((yield* fileOf(key)).stream()))
    },
    *write(data: IODef.S3Body) {
      return yield* until(writeBody(yield* fileOf(key), data))
    },
    *exists() {
      return yield* until((yield* fileOf(key)).exists())
    },
    *delete() {
      yield* until((yield* fileOf(key)).delete())
    },
    *stat() {
      return mapStat(yield* until((yield* fileOf(key)).stat()))
    },
    *presign(presignOptions?: IODef.S3PresignOptions) {
      return (yield* fileOf(key)).presign(presignOptions)
    },
  })

  return {
    file,

    *read(key: string) {
      return yield* until((yield* fileOf(key)).bytes())
    },
    *write(key: string, data: IODef.S3Body) {
      return yield* until(writeBody(yield* fileOf(key), data))
    },
    *exists(key: string) {
      return yield* until((yield* useClient()).exists(key))
    },
    *delete(key: string) {
      yield* until((yield* useClient()).delete(key))
    },
    *stat(key: string) {
      return mapStat(yield* until((yield* useClient()).stat(key)))
    },
    *list(listOptions?: IODef.S3ListOptions) {
      return mapList(yield* until((yield* useClient()).list(listOptions)))
    },
    *presign(key: string, presignOptions?: IODef.S3PresignOptions) {
      return (yield* useClient()).presign(key, presignOptions)
    },
  }
}
