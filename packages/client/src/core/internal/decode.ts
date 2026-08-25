import type { Flow, Operation, Subscription } from 'std:effect'
import { fromReadable, until } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { HEADERS } from '../const'
import { ClientErrors } from '../errors'

/** Split a byte stream into lines (without the terminator); a trailing partial line is flushed.
 * Hand-rolled (no `pipeThrough`): cancelling a piped stream mid-flight is unreliable across
 * runtimes, and a consumer that leaves a long-lived sse/ndjson feed must cancel cleanly. */
const lines = (body: ReadableStream<Uint8Array>): ReadableStream<string> => {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let queued: string[] = []

  return new ReadableStream<string>({
    async pull(controller) {
      while (queued.length === 0) {
        // oxlint-disable-next-line no-await-in-loop -- one read per pull, sequential by nature
        const step = await reader.read()
        if (step.done) {
          buffer += decoder.decode()
          if (buffer.length > 0) {
            controller.enqueue(buffer)
            buffer = ''
          }
          controller.close()
          return
        }
        buffer += decoder.decode(step.value, { stream: true })
        let at = buffer.indexOf('\n')
        while (at >= 0) {
          queued.push(buffer.slice(0, at))
          buffer = buffer.slice(at + 1)
          at = buffer.indexOf('\n')
        }
      }
      const next = queued
      queued = []
      for (const line of next) {
        controller.enqueue(line)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
    },
  })
}

const parse = (text: string): Operation<unknown> =>
  (function* () {
    try {
      return JSON.parse(text)
    } catch {
      return yield* fail(ClientErrors.Decode, `malformed JSON frame: ${text.slice(0, 80)}`)
    }
  })()

/** Lines → values: ndjson takes every non-empty line, sse joins the `data:` lines of a frame. */
const valuesOf = (
  body: ReadableStream<Uint8Array>,
  brand: 'ndjson' | 'sse',
): Flow<unknown, void> => ({
  *[Symbol.iterator]() {
    const source = yield* fromReadable(lines(body))
    const subscription: Subscription<unknown, void> = {
      *next() {
        let data: string[] = []
        for (;;) {
          const step = yield* source.next()
          if (step.done) {
            if (data.length > 0) {
              const text = data.join('\n')
              data = []
              return { done: false, value: yield* parse(text) }
            }
            return { done: true, value: undefined }
          }
          const line = step.value
          if (brand === 'ndjson') {
            if (line.trim().length === 0) {
              continue
            }
            return { done: false, value: yield* parse(line) }
          }
          if (line.length === 0) {
            if (data.length > 0) {
              const text = data.join('\n')
              data = []
              return { done: false, value: yield* parse(text) }
            }
            continue
          }
          if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart())
          }
        }
      },
    }
    return subscription
  },
})

/** The wire failure (`{ error }` body) rebuilt as a Result failure; `req:<id>` and
 * `status:<code>` are appended to the causes. */
export function* failureOf(response: Response, requestId: string): Operation<never> {
  const text = yield* until(response.text().catch(() => ''))
  let wire: { error?: string; message?: string; causes?: string[] } | null = null

  try {
    wire = (JSON.parse(text) as AnyType)?.error ?? null
  } catch {
    wire = null
  }
  const tag = wire?.error ?? response.headers.get(HEADERS.error) ?? `http.${response.status}`
  const message = wire?.message ?? (text.length > 0 ? text : response.statusText)

  return yield* fail(
    tag,
    message,
    ...(wire?.causes ?? []),
    `req:${requestId}`,
    `status:${response.status}`,
  )
}

/** Decode a successful response by its `oz-brand`: json values, ndjson/sse as a Flow, text, bytes. */
export function* decodeBody(response: Response): Operation<unknown> {
  const brand = response.headers.get(HEADERS.brand)

  if (response.status === 204 || !response.body) {
    return undefined
  }

  if (brand === 'ndjson' || brand === 'sse') {
    return valuesOf(response.body, brand)
  }

  if (brand === 'text') {
    return yield* until(response.text())
  }

  if (brand) {
    return response.body
  }

  const text = yield* until(response.text())

  if (text.length === 0) {
    return undefined
  }

  return yield* parse(text)
}
