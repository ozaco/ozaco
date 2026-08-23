import { IO } from 'std:io'

import { CHUNK_HEADER_ALLOWANCE, CHUNK_TIMEOUT_MS, HEADERS } from '../const'
import type { Helpers } from '../types/helpers'
import type { TransportDef } from '../types/transport'

/**
 * Payload chunking at the driver boundary: a publish larger than the backend's
 * `maxPayloadBytes` is split into numbered parts (`oz-chunk: <id>/<index>/<count>`, every
 * part carrying the original headers) and reassembled on the subscriber side before any plane
 * sees it. Parts of one message must reach ONE receiver — a competing-consumer group spreads
 * them over its members, so grouped/durable subscriptions cannot receive chunked messages
 * (their partial assemblies age out after `CHUNK_TIMEOUT_MS`, undelivered).
 */

const parseChunk = (value: string): { id: string; index: number; count: number } | null => {
  const [id, index, count] = value.split('/')
  const at = Number(index)
  const total = Number(count)

  if (!id || !Number.isInteger(at) || !Number.isInteger(total) || at < 0 || at >= total) {
    return null
  }

  return { id, index: at, count: total }
}

/** A driver whose publishes chunk above the backend's payload limit and whose subscriptions
 * hand back whole messages. Transparent when the backend has no limit. */
export const chunkedDriver = (driver: TransportDef.Driver): TransportDef.Driver => ({
  ...driver,

  *publish(message) {
    const limit = driver.payloadLimit
      ? yield* driver.payloadLimit()
      : driver.capabilities.maxPayloadBytes

    if (limit === null || message.data.length <= limit) {
      return yield* driver.publish(message)
    }

    const partSize = Math.max(1, limit - CHUNK_HEADER_ALLOWANCE)
    const id = yield* IO.actions.uuid()
    const count = Math.ceil(message.data.length / partSize)
    let receivers: number | null = null

    for (let index = 0; index < count; index += 1) {
      const data = message.data.subarray(index * partSize, (index + 1) * partSize)

      receivers = yield* driver.publish({
        ...message,
        data,
        headers: { ...message.headers, [HEADERS.chunk]: `${id}/${index}/${count}` },
      })
    }

    return receivers
  },

  *subscribe(topic, options) {
    const raw = yield* driver.subscribe(topic, options)
    const assemblies = new Map<string, Helpers.Assembly>()

    const sweep = (now: number): void => {
      for (const [id, assembly] of assemblies) {
        if (now - assembly.startedAt > CHUNK_TIMEOUT_MS) {
          assemblies.delete(id)
        }
      }
    }

    /** Fold one part in; the whole message once the last part landed, else null. */
    const assemble = (part: TransportDef.Raw): TransportDef.Raw | null => {
      const header = part.headers[HEADERS.chunk]
      const chunk = header === undefined ? null : parseChunk(header)

      if (!chunk) {
        return part
      }

      const now = Date.now()
      sweep(now)

      const { [HEADERS.chunk]: _omit, ...headers } = part.headers
      const assembly = assemblies.get(chunk.id) ?? {
        parts: Array.from({ length: chunk.count }),
        headers,
        topic: part.topic,
        seq: part.seq,
        received: 0,
        startedAt: now,
      }

      assemblies.set(chunk.id, assembly)

      if (assembly.parts[chunk.index] === undefined) {
        assembly.parts[chunk.index] = part.data
        assembly.received += 1
      }

      if (assembly.received < chunk.count) {
        return null
      }

      assemblies.delete(chunk.id)

      const size = assembly.parts.reduce((sum, piece) => sum + (piece?.length ?? 0), 0)
      const data = new Uint8Array(size)
      let offset = 0

      for (const piece of assembly.parts) {
        data.set(piece!, offset)
        offset += piece!.length
      }

      return {
        topic: assembly.topic,
        data,
        headers: assembly.headers,
        seq: assembly.seq,
        ack: part.ack,
        nak: part.nak,
      }
    }

    return {
      *next() {
        for (;;) {
          const step = yield* raw.next()

          if (step.done) {
            return step
          }

          const whole = assemble(step.value)

          if (whole) {
            return { done: false as const, value: whole }
          }
        }
      },
    }
  },
})
