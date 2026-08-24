// oxlint-disable import/exports-last
import type { ReadableStreamReadResult } from 'node:stream/web'

import type { ServerDef } from '../types/server'
import { brandOf, isBranded } from '../utils/stream'

import { isDeferred } from './dispatch'

/** How much of a body snapshot survives (the JSON text length); the rest keeps only the size. */
const DATA_LIMIT = 8192

const HEADER_LIMIT = 256

const SECRET = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
])

/** Bodies and headers are captured only when someone is actually observing. */
export const observing = (kernel: ServerDef.Context): boolean =>
  kernel.hooks.some(hooks => hooks.observe !== undefined)

/** The request headers as a row value: secrets redacted, long values capped. */
export const capturedHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET.has(key.toLowerCase())
      ? '•••'
      : value.length > HEADER_LIMIT
        ? `${value.slice(0, HEADER_LIMIT)}…`
        : value
  }

  return out
}

const cappedData = (value: unknown): Record<string, unknown> => {
  let text: string

  try {
    text = JSON.stringify(value) ?? 'undefined'
  } catch {
    return { kind: 'data', data: String(value), size: null, truncated: false }
  }

  if (text.length <= DATA_LIMIT) {
    return { kind: 'data', data: value, size: text.length, truncated: false }
  }

  return { kind: 'data', data: `${text.slice(0, DATA_LIMIT)}…`, size: text.length, truncated: true }
}

/**
 * One plane value as a row snapshot: the value plane keeps (capped) data, streams and flows keep
 * their shape — `{ kind, brand }` — since buffering them would break the very thing observed.
 */
export const capturedValue = (value: unknown): Record<string, unknown> | null => {
  if (value === undefined) {
    return null
  }

  if (isBranded(value)) {
    return { kind: 'stream', brand: brandOf(value) }
  }

  if (value instanceof ReadableStream) {
    return { kind: 'stream', brand: null }
  }

  if (isDeferred(value)) {
    return { kind: 'flow', brand: value.brand }
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    'fields' in value &&
    'streams' in value &&
    typeof (value as { streams: unknown }).streams === 'object'
  ) {
    const parts = value as { fields: unknown; streams: Record<string, unknown> }

    return {
      kind: 'parts',
      fields: cappedData(parts.fields)['data'],

      streams: Object.fromEntries(
        Object.entries(parts.streams).map(([name, source]) => [
          name,
          isBranded(source) ? brandOf(source) : 'stream',
        ]),
      ),
    }
  }

  return cappedData(value)
}

/**
 * A byte-counting pass-through: the stream flows untouched, `done` receives the total once it
 * closes, errors or is cancelled — big bodies are observed as a SIZE, never buffered.
 */
export const countingStream = (
  source: ReadableStream<Uint8Array>,
  done: (bytes: number) => void,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  let total = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>

      try {
        step = await reader.read()
      } catch (error) {
        controller.error(error)
        done(total)
        return
      }

      if (step.done) {
        if (controller.desiredSize !== null) {
          controller.close()
        }

        done(total)
        return
      }

      total += step.value.length
      controller.enqueue(step.value)
    },

    cancel: async reason => {
      done(total)
      await reader.cancel(reason).catch(() => {})
    },
  })
}

/** The per-request capture slot the edge fills while it runs the action. */
export interface Captured {
  headers: Record<string, string> | null
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null

  /** one entry per armed byte counter — settled when that body finished streaming. */
  readonly pending: Promise<void>[]
}

export const emptyCapture = (): Captured => ({
  headers: null,
  input: null,
  output: null,
  pending: [],
})
