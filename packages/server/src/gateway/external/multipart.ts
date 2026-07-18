// oxlint-disable import/exports-last

import type { MultipartPart } from 'server:core'
import type { Stream, Subscription } from 'std:effect'
import { action, resource, until } from 'std:effect'
import type { StreamClose } from 'std:io'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { Readable } from 'node:stream'

import busboy from '@fastify/busboy'

/** Per-part / per-file size + count limits handed to busboy. */
export interface MultipartLimits {
  fileSize?: number | undefined
  files?: number | undefined
  fields?: number | undefined
}

// Adapt a busboy file `Readable` into an effect-native `Stream<Uint8Array>` by PULLING one chunk at a
// time through the Readable's async iterator. Async iteration keeps the Readable in paused mode, so it
// only produces the next chunk when the consumer asks — which backpressures busboy (and the upload
// socket) instead of buffering the whole file. The close value is `true` on a clean end, or the
// failure when the source errored mid-stream.
const pullStream = (readable: Readable): Stream<Uint8Array, StreamClose> =>
  resource(function* (provide) {
    const iterator = (readable as AnyType)[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>

    const subscription: Subscription<Uint8Array, StreamClose> = {
      *next() {
        let result: IteratorResult<Uint8Array>
        try {
          result = yield* until(iterator.next())
        } catch (error) {
          return { done: true, value: asFailure(error) }
        }
        if (result.done) {
          return { done: true, value: true }
        }
        const chunk = result.value
        return { done: false, value: chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk) }
      },
    }

    yield* provide(subscription)
  })

// Resume a (possibly partially-consumed) Readable and wait for it to end. Used to discard a file the
// consumer skipped, so busboy — which parses sequentially and won't emit the next part until the
// current file is drained — can proceed instead of deadlocking.
const drain = (readable: Readable): Promise<void> =>
  new Promise(resolve => {
    if (readable.readableEnded || readable.destroyed) {
      resolve()
      return
    }
    const done = () => resolve()
    readable.on('end', done)
    readable.on('close', done)
    readable.on('error', done)
    readable.resume()
  })

/**
 * Parse a `multipart/form-data` `Request` into an effect-native, backpressured `Stream<MultipartPart>`
 * on top of `@fastify/busboy` — the impure boundary lives HERE (in `external/`), wrapping busboy's
 * event/Node-stream API into an effect-native stream. Parts arrive in wire order; each `file` part's
 * `stream` MUST be fully consumed (or the stream advanced) before the next part is available, because
 * busboy pauses the upload until the current file is drained. The whole body is streamed through
 * busboy — nothing is buffered beyond one file's high-water mark.
 */
export const parseMultipart = (
  request: Request,
  limits?: MultipartLimits,
): Stream<MultipartPart, StreamClose> =>
  resource(function* (provide) {
    const queue: MultipartPart[] = []
    let pendingReadable: Readable | null = null
    let pendingDrained = true
    let closed: StreamClose | null = null
    let waiter: (() => void) | null = null

    const wake = () => {
      const notify = waiter
      waiter = null
      notify?.()
    }

    // park the consumer until the next busboy event wakes it (declared once, not per loop turn)
    const park = () =>
      action<void>(resolve => {
        waiter = resolve
        return () => {
          waiter = null
        }
      })

    const body = request.body
    if (!body) {
      yield* provide({
        *next() {
          return { done: true, value: true }
        },
      })
      return
    }

    const bb = busboy({
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      ...(limits ? { limits } : {}),
    })

    bb.on('field', (name: string, value: string) => {
      queue.push({ kind: 'field', name, value })
      wake()
    })

    // busboy passes (fieldname, stream, filename, transferEncoding, mimeType) positionally — collect
    // the trailing three as a tuple to keep the arrow within the max-params budget.
    bb.on('file', (name: string, stream: Readable, ...info: [string, string, string]) => {
      const filename = info[0]
      const mime = info[2]
      pendingReadable = stream
      pendingDrained = false
      const mark = () => {
        pendingDrained = true
      }
      stream.on('end', mark)
      stream.on('close', mark)
      stream.on('error', mark)
      stream.on('limit', () => {
        closed = asFailure(new Error('multipart file exceeds the configured size limit'))
        wake()
      })
      queue.push({
        kind: 'file',
        name,
        filename: filename || undefined,
        mediaType: mime || undefined,
        stream: pullStream(stream),
      })
      wake()
    })

    bb.on('finish', () => {
      closed = true
      wake()
    })
    bb.on('error', (error: unknown) => {
      closed = asFailure(error)
      wake()
    })

    const source = Readable.fromWeb(body as AnyType)
    source.on('error', (error: unknown) => {
      closed = asFailure(error)
      wake()
    })
    source.pipe(bb)

    const subscription: Subscription<MultipartPart, StreamClose> = {
      *next() {
        while (true) {
          const part = queue.shift()
          if (part) {
            return { done: false, value: part }
          }
          if (pendingReadable && !pendingDrained) {
            // consumer advanced without draining the current file — discard it so busboy continues
            yield* until(drain(pendingReadable))
            pendingDrained = true
            continue
          }
          if (closed !== null) {
            return { done: true, value: closed }
          }
          yield* park()
        }
      },
    }

    try {
      yield* provide(subscription)
    } finally {
      source.unpipe(bb)
      source.destroy()
      bb.destroy()
    }
  })
