// oxlint-disable import/exports-last
/**
 * The inspector API every dev tool shares (the docs panel, the observe console, a CLI try-it):
 * `loadManifest` (unwrap-or-throw), `send` (one request → a live `Outcome` with progress
 * chunks for a timeline, cancellable), `watch` (a resource feed through callbacks). All take
 * the client handle — or the `connectClient` promise, so a UI needs no ceremony.
 */
import type { FutureFlow } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ClientDef } from '../types/client'
import type { ManifestDef } from '../types/manifest'

import type { WireFailure } from './failure'
import { wireFailureOf } from './failure'

/** Any handle (typed or not), or `connectClient`'s promise of one — only the statics are used. */
export type HandleLike = ClientDef.Statics | Promise<ClientDef.Statics>

const handleOf = (client: HandleLike): Promise<ClientDef.Statics> => Promise.resolve(client)

/** The manifest, or a thrown {@link WireFailure}. */
export const loadManifest = async (client: HandleLike): Promise<ManifestDef.Manifest> => {
  const handle = await handleOf(client)
  const outcome = await handle.$manifest()

  if (isFailure(outcome)) {
    throw wireFailureOf(outcome) as unknown as Error
  }

  return outcome.value
}

export interface SendRequest {
  readonly service: string
  readonly action: string
  readonly input?: unknown
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
}

/** One step of a streamed reply, stamped with the elapsed ms — a timeline renders these. */
export type Chunk =
  | { readonly kind: 'value'; readonly value: unknown; readonly at: number }
  | { readonly kind: 'text'; readonly text: string; readonly at: number }
  | { readonly kind: 'bytes'; readonly size: number; readonly at: number }

export interface Outcome {
  readonly ok: boolean
  readonly status: number | null
  readonly requestId: string | null
  readonly brand: string | null
  readonly elapsedMs: number

  /** a value / text answer, or the bytes collected. */
  readonly value: unknown
  readonly bytes: Uint8Array | null
  readonly error: WireFailure | null
  readonly streamed: boolean
}

export interface InFlight {
  readonly done: Promise<Outcome>
  cancel(): Promise<void>
}

/** Send one request; stream chunks arrive through `onChunk` as they come. */
export const send = (
  client: HandleLike,
  request: SendRequest,
  onChunk: (chunk: Chunk) => void = () => {},
): InFlight => {
  const startedAt = performance.now()
  const controller = new AbortController()
  let flow: FutureFlow<unknown> | null = null
  const elapsed = () => Math.round(performance.now() - startedAt)

  const done = (async (): Promise<Outcome> => {
    const handle = await handleOf(client)
    const outcome = await handle.$callWithMeta(
      { service: request.service, action: request.action },
      request.input,
      {
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        signal: controller.signal,
      },
    )

    if (isFailure(outcome)) {
      const failure = wireFailureOf(outcome)

      return {
        ok: false,
        status: failure.status,
        requestId: failure.requestId,
        brand: null,
        elapsedMs: elapsed(),
        value: null,
        bytes: null,
        error: failure,
        streamed: false,
      }
    }

    const { value, meta } = outcome.value
    const base = { ok: true, status: meta.status, requestId: meta.requestId, brand: meta.brand }

    // by the reply's brand: value streams chunk, text arrives whole, bytes collect
    if (meta.brand === 'ndjson' || meta.brand === 'sse') {
      flow = value as FutureFlow<unknown>
      const values: unknown[] = []

      for await (const item of flow) {
        values.push(item)
        onChunk({ kind: 'value', value: item, at: performance.now() - startedAt })
      }

      return {
        ...base,
        elapsedMs: elapsed(),
        error: null,
        value: values,
        bytes: null,
        streamed: true,
      }
    }

    if (meta.brand === 'text') {
      onChunk({ kind: 'text', text: String(value), at: performance.now() - startedAt })
      return { ...base, elapsedMs: elapsed(), error: null, value, bytes: null, streamed: true }
    }

    if (value instanceof ReadableStream) {
      const reader = (value as ReadableStream<Uint8Array>).getReader()
      const parts: Uint8Array[] = []
      let total = 0

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by nature
        const step = await reader.read()

        if (step.done) {
          break
        }

        parts.push(step.value)
        total += step.value.length
        onChunk({ kind: 'bytes', size: total, at: performance.now() - startedAt })
      }

      const bytes = new Uint8Array(total)
      let at = 0

      for (const part of parts) {
        bytes.set(part, at)
        at += part.length
      }

      return { ...base, elapsedMs: elapsed(), error: null, value: null, bytes, streamed: true }
    }

    return { ...base, elapsedMs: elapsed(), error: null, value, bytes: null, streamed: false }
  })()

  return {
    done,

    cancel: async () => {
      controller.abort()
      await (flow?.cancel() as AnyType)
    },
  }
}

export interface WatchHandlers<TRow = unknown> {
  readonly onFrame: (frame: ClientDef.WatchFrame<TRow>) => void
  readonly onEnd?: ((error: WireFailure | null) => void) | undefined
}

export interface Watching {
  stop(): Promise<void>

  /** Windowed watches: turn THIS subscription's page — same socket, no reconnect. */
  turn(cursor: string | null, back?: boolean): void
}

/** Watch a resource's realtime feed; frames arrive through the handlers until `stop()`. */
// oxlint-disable-next-line max-params -- handle · resource · options · handlers is the shape
export const watch = <TRow = unknown>(
  client: HandleLike,
  resource: string,
  options: ClientDef.WatchOptions,
  handlers: WatchHandlers<TRow>,
): Watching => {
  let flow: ClientDef.WatchFeed<TRow> | null = null
  let stopped = false
  let queued: { cursor: string | null; back?: boolean } | undefined

  void (async () => {
    try {
      const handle = await handleOf(client)
      flow = handle.$watch<TRow>(resource, options)

      if (stopped) {
        await (flow.cancel() as AnyType)
        return
      }

      if (queued !== undefined) {
        flow.turn(queued.cursor, queued.back)
        queued = undefined
      }

      for await (const frame of flow) {
        handlers.onFrame(frame)
      }

      handlers.onEnd?.(null)
    } catch (error) {
      handlers.onEnd?.(wireFailureOf(error))
    }
  })()

  return {
    stop: async () => {
      stopped = true
      await (flow?.cancel() as AnyType)
    },

    turn: (cursor, back) => {
      if (flow) {
        flow.turn(cursor, back)
      } else {
        queued = { cursor, ...(back === undefined ? {} : { back }) }
      }
    },
  }
}
