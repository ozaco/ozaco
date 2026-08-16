// oxlint-disable import/exports-last
import type { Flow, Subscription } from 'std:effect'
import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { REQUEST_ID_HEADER } from '../../const'
import type { Route } from '../../types/action'
import type { Meta, Reply } from '../../types/common'
import type { EdgeResponse } from '../../types/gateway'

const ENCODER = new TextEncoder()

const baseHeaders = (requestId: string, meta?: Meta): Meta => ({
  ...meta,
  [REQUEST_ID_HEADER]: requestId,
})

/** value / failure replies → a buffered HTTP response. */
export const replyToResponse = operation(function* (input: {
  readonly reply: Reply
  readonly requestId: string
  readonly debug: boolean
}) {
  const { reply, requestId, debug } = input

  if (reply.kind === 'failure') {
    const body = {
      error: reply.failure.error,
      message: reply.failure.message,
      requestId,
      ...(debug ? { causes: reply.failure.causes } : {}),
    }
    const bytes = ENCODER.encode(yield* JsonCodec.actions.stringify(body))

    const response: EdgeResponse = {
      status: reply.status,
      headers: { ...baseHeaders(requestId, reply.meta), 'content-type': 'application/json' },
      body: bytes,
    }

    return response
  }

  if (reply.kind === 'value') {
    if (reply.value === undefined) {
      const response: EdgeResponse = {
        status: reply.status ?? 204,
        headers: baseHeaders(requestId, reply.meta),
      }

      return response
    }

    const bytes = ENCODER.encode(yield* JsonCodec.actions.stringify(reply.value))
    const headers = baseHeaders(requestId, reply.meta)

    const response: EdgeResponse = {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...headers },
      body: bytes,
    }

    return response
  }

  // stream replies are handled by streamToResponse
  const response: EdgeResponse = {
    status: 500,
    headers: baseHeaders(requestId),
    body: ENCODER.encode('{"error":"server:core.internal","message":"unroutable stream reply"}'),
  }

  return response
})

interface MapState {
  readonly source: Subscription<unknown, unknown>
  readonly frame: (value: unknown) => Generator<AnyType, Uint8Array, AnyType>
  opened: boolean
  readonly opener?: Uint8Array | undefined
}

const mappedFlow = (state: MapState): Flow<Uint8Array, unknown> => ({
  *[Symbol.iterator]() {
    const subscription: Subscription<Uint8Array, unknown> = {
      *next(): Generator<AnyType, IteratorResult<Uint8Array, unknown>, AnyType> {
        if (!state.opened && state.opener) {
          state.opened = true

          return { done: false, value: state.opener }
        }

        const result = yield* state.source.next()

        if (result.done) {
          return { done: true, value: result.value }
        }

        return { done: false, value: yield* state.frame(result.value) }
      },
    }

    return subscription
  },
})

/** stream replies → a streaming HTTP response (SSE / raw bytes / NDJSON). */
export const streamToResponse = operation(function* (input: {
  readonly reply: Extract<Reply, { kind: 'stream' }>
  readonly requestId: string
  readonly route: Route | undefined
}) {
  const { reply, requestId, route } = input
  const subscription = yield* reply.flow

  if (reply.bytes) {
    const headers = baseHeaders(requestId, reply.meta)

    const response: EdgeResponse = {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/octet-stream', ...headers },
      body: mappedFlow({
        source: subscription,
        opened: true,
        *frame(value) {
          return value as Uint8Array
        },
      }),
    }

    return response
  }

  if (route?.sse) {
    const response: EdgeResponse = {
      status: reply.status ?? 200,
      headers: {
        ...baseHeaders(requestId, reply.meta),
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
      body: mappedFlow({
        source: subscription,
        opened: false,
        opener: ENCODER.encode(': ok\n\n'),
        *frame(value) {
          const json = yield* JsonCodec.actions.stringify(value)

          return ENCODER.encode(`data: ${json}\n\n`)
        },
      }),
    }

    return response
  }

  const response: EdgeResponse = {
    status: reply.status ?? 200,
    headers: { ...baseHeaders(requestId, reply.meta), 'content-type': 'application/x-ndjson' },
    body: mappedFlow({
      source: subscription,
      opened: true,
      *frame(value) {
        const json = yield* JsonCodec.actions.stringify(value)

        return ENCODER.encode(`${json}\n`)
      },
    }),
  }

  return response
})
