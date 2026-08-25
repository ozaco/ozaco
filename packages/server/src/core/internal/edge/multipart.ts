import type { Flow, Operation, Queue } from 'std:effect'
import { createQueue, fork, toReadable, until, withResolvers } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { Busboy } from '@fastify/busboy'

import { ServerErrors } from '../../errors'
import type { StreamDef } from '../../types/stream'
import { brandStream } from '../../utils/stream'

import { coerce } from './body'

/** Busboy's file stream is paused beyond HIGH buffered chunks and resumed below LOW. */
const HIGH_WATER = 64
const LOW_WATER = 16

interface Lane {
  readonly queue: Queue<Uint8Array, void>
  fed: boolean
  resume?: (() => void) | undefined
}

/**
 * A multipart body as a `parts` input: the fields that arrive BEFORE the first file resolve the
 * dispatch (they are the value plane), every declared stream is a branded `ReadableStream` fed by
 * the matching file part as the parser reaches it — so the handler should read them in body
 * order; a stream nobody sends ends empty. Busboy's backpressure reaches the socket.
 */
export function* parseParts(
  request: Request,
  decl: StreamDef.PartsDecl,
): Operation<StreamDef.Parts<unknown, string>> {
  const contentType = request.headers.get('content-type')

  if (!contentType || !request.body) {
    return yield* fail(ServerErrors.BadRequest, 'multipart request without a body')
  }

  let busboy: InstanceType<typeof Busboy>

  try {
    busboy = new Busboy({ headers: { 'content-type': contentType } })
  } catch {
    return yield* fail(ServerErrors.BadRequest, 'malformed multipart content-type')
  }

  const fields: Record<string, unknown> = {}

  const lanes = new Map<string, Lane>(
    Object.keys(decl.streams).map(name => [
      name,
      { queue: createQueue<Uint8Array, void>(), fed: false },
    ]),
  )
  const ready = withResolvers<void>('multipart fields')
  let settled = false

  const settle = () => {
    if (!settled) {
      settled = true
      ready.resolve(undefined)
    }
  }

  busboy.on('field', (name: string, value: AnyType) => {
    if (!settled) {
      fields[name] = coerce(String(value))
    }
  })

  busboy.on(
    'file',
    // oxlint-disable-next-line max-params -- busboy's signature
    (name: string, file: AnyType, _filename: string, _encoding: string, _mime: string) => {
      settle()
      const lane = lanes.get(name)
      if (!lane) {
        file.resume()
        return
      }
      lane.fed = true
      let pending = 0
      let paused = false
      file.on('data', (chunk: Uint8Array) => {
        lane.queue.add(new Uint8Array(chunk))
        pending += 1
        if (!paused && pending >= HIGH_WATER) {
          paused = true
          file.pause()
        }
      })
      file.on('end', () => lane.queue.close(undefined))
      lane.resume = () => {
        pending -= 1
        if (paused && pending <= LOW_WATER) {
          paused = false
          file.resume()
        }
      }
    },
  )

  busboy.on('finish', () => {
    settle()
    for (const lane of lanes.values()) {
      if (!lane.fed) {
        lane.queue.close(undefined)
      }
    }
  })

  busboy.on('error', () => {
    settle()
    for (const lane of lanes.values()) {
      lane.queue.close(undefined)
    }
  })

  const reader = request.body.getReader()

  yield* fork(function* () {
    for (;;) {
      const step = yield* until(reader.read())
      if (step.done) {
        busboy.end()
        return
      }
      if (!busboy.write(Buffer.from(step.value))) {
        yield* until(
          new Promise<void>(resolve => {
            busboy.once('drain', () => resolve())
          }),
        )
      }
    }
  })
  yield* ready.operation

  const streams: Record<string, StreamDef.Branded> = {}

  for (const [name, lane] of lanes) {
    // one pull-paced platform stream per declared part (pump forked in the request's scope)
    const flow: Flow<Uint8Array, void> = {
      *[Symbol.iterator]() {
        return {
          *next() {
            const step = yield* lane.queue.next()

            if (!step.done) {
              lane.resume?.()
            }

            return step
          },
        }
      },
    }
    streams[name] = brandStream(yield* toReadable(flow), decl.streams[name]!.brand)
  }

  return { fields, streams }
}
