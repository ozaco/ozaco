import type { Flow, Queue, Subscription } from 'std:effect'
import { createQueue, each, fork, operation, until, withResolvers } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { Busboy } from '@fastify/busboy'

import { CoreErrors } from '../../errors'
import type { Meta } from '../../types/common'
import type { Multistream, Part, PartClose } from '../../types/gateway'
import { flowOf } from '../../utils/lanes'

/** Backpressure watermarks: pause the busboy file stream beyond HIGH buffered chunks. */
const HIGH_WATER = 64
const LOW_WATER = 16

/** A queue-backed flow that resumes the paused producer as the consumer drains. */
const meteredFileFlow = (
  queue: Queue<Uint8Array, PartClose>,
  meter: { pending: number; paused: boolean; resume: () => void },
): Flow<Uint8Array, PartClose> => ({
  *[Symbol.iterator]() {
    const subscription: Subscription<Uint8Array, PartClose> = {
      *next() {
        const result = yield* queue.next()

        if (!result.done) {
          meter.pending -= 1

          if (meter.paused && meter.pending <= LOW_WATER) {
            meter.paused = false
            meter.resume()
          }
        }

        return result
      },
    }

    return subscription
  },
})

export interface ParsedMultipart {
  /** Fields that arrived BEFORE the first file — merged into the action params. */
  readonly fields: Record<string, string>
  /** Files (and any trailing fields) as the multistream source. */
  readonly multistream: Multistream
}

/**
 * Bridges busboy into the effect world. Leading fields resolve before the dispatch (they become
 * params); file parts stream through queues while the handler runs, with pause/resume watermarks
 * so a slow handler stalls the socket instead of buffering the upload in memory.
 */
export const parseMultipart = operation(function* (
  headers: Meta,
  source: Flow<Uint8Array, unknown>,
) {
  const contentType = headers['content-type']

  if (!contentType) {
    return yield* fail(CoreErrors.BadRequest, 'multipart request without content-type')
  }

  const parts = createQueue<Part, PartClose>()
  const fields: Record<string, string> = {}
  const ready = withResolvers<void>()

  let sawFile = false
  let settled = false

  const settle = () => {
    if (!settled) {
      settled = true
      ready.resolve(undefined as void)
    }
  }

  let busboy: InstanceType<typeof Busboy>

  try {
    busboy = new Busboy({ headers: { 'content-type': contentType } })
  } catch {
    return yield* fail(CoreErrors.BadRequest, 'malformed multipart content-type')
  }

  busboy.on('field', (name: string, value: AnyType) => {
    if (sawFile) {
      parts.add({ kind: 'field', name, value: String(value) })

      return
    }

    fields[name] = String(value)
  })

  busboy.on(
    'file',
    // oxlint-disable-next-line max-params
    (name: string, file: AnyType, filename: string, _encoding: string, mimetype: string) => {
      sawFile = true
      settle()

      const data = createQueue<Uint8Array, PartClose>()
      const meter = {
        pending: 0,
        paused: false,
        resume: () => {
          file.resume()
        },
      }

      file.on('data', (chunk: Uint8Array) => {
        data.add(new Uint8Array(chunk))
        meter.pending += 1

        if (!meter.paused && meter.pending >= HIGH_WATER) {
          meter.paused = true
          file.pause()
        }
      })
      file.on('end', () => data.close(true))

      parts.add({
        kind: 'file',
        name,
        filename,
        contentType: mimetype,
        data: meteredFileFlow(data, meter),
      })
    },
  )

  busboy.on('finish', () => {
    settle()
    parts.close(true)
  })

  busboy.on('error', () => {
    settle()
    parts.close(true)
  })

  yield* fork(function* () {
    for (const chunk of yield* each(source)) {
      if (!busboy.write(Buffer.from(chunk))) {
        // honor busboy's writable backpressure (propagates the paused file stream upstream)
        yield* until(
          new Promise<void>(resolve => {
            busboy.once('drain', () => {
              resolve()
            })
          }),
        )
      }

      yield* each.next()
    }

    busboy.end()
  })

  yield* ready.operation

  return { fields, multistream: { parts: flowOf(parts) } } satisfies ParsedMultipart
})
