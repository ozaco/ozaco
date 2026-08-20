// oxlint-disable import/exports-last
/**
 * SSE reader for the gateway's `text/event-stream` flavor. `EventSource` cannot send an
 * `Authorization` header, so the stream is read through `std:fetch` instead: the edge opens with a
 * `: ok` comment, then emits one `data: <json>` line per frame followed by a blank line. The parser
 * is incremental and survives ANY chunk boundary (mid-line, mid-`data:` token, split CRLF).
 */

import { CodecErrors } from 'std:codec'
import { attempt, operation, useScope } from 'std:effect'
import { Fetch } from 'std:fetch'
import type { Result } from 'std:result'
import { fail, isFailure, isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { ClientErrors } from './errors'
import { joinUrl, realtimePathOf, resolveToken } from './internal'
import { ssePathOf } from './manifest'
import type { ClientState, SseHandle, SseInput } from './types'

export interface SseParserHandlers {
  /** One dispatched event (the joined `data:` lines). */
  readonly onData: (data: string) => void
  /** `:`-prefixed comment lines (the edge's `: ok` opener keeps proxies from buffering). */
  readonly onComment?: ((comment: string) => void) | undefined
}

export interface SseParser {
  /** Feed one byte chunk, split at any boundary. */
  readonly push: (chunk: Uint8Array) => void
  /** Flush the tail once the stream ends. */
  readonly end: () => void
}

export const createSseParser = (handlers: SseParserHandlers): SseParser => {
  const decoder = new TextDecoder()
  let buffered = ''
  let dataLines: string[] = []
  let sawData = false

  const dispatch = (): void => {
    if (sawData) {
      handlers.onData(dataLines.join('\n'))
    }

    dataLines = []
    sawData = false
  }

  const consumeLine = (line: string): void => {
    if (line === '') {
      dispatch()

      return
    }

    if (line.startsWith(':')) {
      handlers.onComment?.(line.slice(1).replace(/^ /u, ''))

      return
    }

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')

    if (field === 'data') {
      sawData = true
      dataLines.push(value)
    }
    // other fields (event/id/retry) carry no meaning in the edge contract — ignored
  }

  const consume = (text: string): void => {
    buffered += text

    for (;;) {
      const newline = buffered.indexOf('\n')

      if (newline === -1) {
        return
      }

      const rawLine = buffered.slice(0, newline)

      buffered = buffered.slice(newline + 1)
      consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
    }
  }

  return {
    push: chunk => {
      consume(decoder.decode(chunk, { stream: true }))
    },
    end: () => {
      consume(decoder.decode())

      if (buffered !== '') {
        consumeLine(buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered)
        buffered = ''
      }

      dispatch()
    },
  }
}

/** `GET <path>/sse?fn=&args=&since=` — the query shape the wizard's SSE route expects. */
export const sseUrl = operation(function* (state: ClientState, input: SseInput) {
  if (input.path === undefined && input.resource === undefined) {
    return yield* fail(ClientErrors.Watch, 'sse needs either a `resource` or an explicit `path`')
  }

  const base = input.path ?? ssePathOf({ path: realtimePathOf(state, input.resource as string) })
  const query = new URLSearchParams({ fn: input.fn })

  if (input.args !== undefined) {
    query.set('args', yield* JsonCodec.actions.stringify(input.args))
  }

  if (input.since !== undefined) {
    query.set('since', String(input.since))
  }

  return `${joinUrl(state.options.url, base)}?${query.toString()}`
})

/** Decode one dispatched `data:` payload; undecodable text goes to `onRaw` untouched. */
const emitData = operation(function* (input: SseInput, data: string) {
  const decoded = yield* attempt(() => JsonCodec.actions.parse<unknown>(data))

  if (isSuccess(decoded)) {
    input.onValue(decoded.value)

    return
  }

  if (decoded.error !== CodecErrors.Parse) {
    // a missing JsonCodec install must surface as itself, not as an odd-looking payload
    return yield* decoded
  }

  input.onRaw?.(data)
})

const pumpSse = operation(function* (state: ClientState, input: SseInput, url: string) {
  // the parser callback is synchronous and the codec is an operation, so payloads are buffered
  // here and decoded in effect-land right after each chunk
  const pending: string[] = []
  const parser = createSseParser({
    onData: data => {
      pending.push(data)
    },
    onComment: input.onComment,
  })

  const drain = operation(function* () {
    while (pending.length > 0) {
      yield* emitData(input, pending.shift() as string)
    }
  })

  const headers: Record<string, string> = { accept: 'text/event-stream', ...state.options.headers }
  const token = resolveToken(state)

  if (token !== undefined && token !== '') {
    headers['authorization'] = `Bearer ${token}`
  }

  const opened = yield* attempt(() => Fetch.actions.request(url, { headers }))

  if (isFailure(opened)) {
    input.onError?.(opened)
    input.onEnd?.()

    return
  }

  const response = opened.value

  if (!response.ok) {
    input.onError?.(
      fail(
        ClientErrors.Request,
        `sse request failed (${response.status})`,
        `status:${response.status}`,
      ) as Result.Failure<unknown>,
    )
    input.onEnd?.()

    return
  }

  const drained = yield* attempt(function* () {
    const flow = yield* response.raw()
    const subscription = yield* flow

    for (;;) {
      const step = yield* subscription.next()

      if (step.done) {
        parser.end()
        yield* drain()

        return
      }

      parser.push(step.value)
      yield* drain()
    }
  })

  if (isFailure(drained)) {
    input.onError?.(drained)
  }

  input.onEnd?.()
})

/**
 * Open one SSE stream. The pump runs as a DETACHED task on the calling scope (its failure settles
 * the task, never the scope) and `stop()` halts it, which tears the request down through
 * `std:fetch`'s own scope binding. Closing the scope stops the stream too.
 */
export const openSse = operation(function* (state: ClientState, input: SseInput) {
  const url = yield* sseUrl(state, input)
  const scope = yield* useScope()
  const task = scope.run(() => pumpSse(state, input, url), { detached: true })

  const handle: SseHandle = {
    url,
    stop: operation(function* () {
      yield* attempt(() => task.halt())
    }),
  }

  return handle
})
