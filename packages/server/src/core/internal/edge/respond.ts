import type { Result } from 'std:result'

import { HEADERS } from '../../const'
import type { ServiceDef } from '../../types/service'
import type { StreamDef } from '../../types/stream'
import { messageOf, statusOf, tagOf } from '../../utils/failure'
import { brandOf, brandSpecOf, isBranded } from '../../utils/stream'

const encoder = new TextEncoder()

/** SSE comment-frame interval: keeps quiet streams alive through connection idle timeouts
 * (Bun closes idle connections after ~10s by default). Env-tunable for tests. */
const keepaliveMs = (): number => {
  const given = Number(process.env['OZACO_SSE_KEEPALIVE_MS'])
  return Number.isFinite(given) && given > 0 ? given : 15_000
}

/** Encode a flow-brand chunk (one codec value) for the wire: ndjson lines or SSE frames. */
const frameOf = (brand: string, value: unknown): Uint8Array => {
  const json = JSON.stringify(value)
  return encoder.encode(brand === 'sse' ? `data: ${json}\n\n` : `${json}\n`)
}

/** A branded stream as an HTTP body: raw bytes pass through; value streams render per brand. */
const bodyOf = (stream: StreamDef.Branded): { body: ReadableStream<Uint8Array>; type: string } => {
  const brand = brandOf(stream)
  const spec = brandSpecOf(brand)
  const type = spec?.contentType ?? 'application/octet-stream'

  if (!spec || spec.plane === 'stream') {
    return { body: stream as ReadableStream<Uint8Array>, type }
  }

  const reader = (stream as ReadableStream<unknown>).getReader()
  let pending: Promise<IteratorResult<unknown, undefined>> | null = null

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (brand === 'sse') {
        // an opening comment flushes the headers at once: a runtime that waits for the first
        // chunk would otherwise hold the whole response until the first event
        controller.enqueue(encoder.encode(': ok\n\n'))
      }
    },
    async pull(controller) {
      // sse: a quiet stream still writes `: keepalive` comments, so idle timeouts never cut a
      // live feed that simply has nothing to say (the console's live SSE, an event relay)
      if (brand === 'sse') {
        pending ??= reader.read() as Promise<IteratorResult<unknown, undefined>>

        const step = await new Promise<IteratorResult<unknown, undefined> | null>(resolve => {
          const timer = setTimeout(() => {
            resolve(null)
          }, keepaliveMs())

          pending!.then(
            result => {
              clearTimeout(timer)
              resolve(result)
              return null
            },
            () => {
              clearTimeout(timer)
              resolve({ done: true, value: undefined })
              return null
            },
          )
        })

        if (step === null) {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
          return
        }

        pending = null

        if (step.done) {
          controller.close()
          return
        }

        controller.enqueue(frameOf(brand, step.value))
        return
      }

      const step = await reader.read()
      if (step.done) {
        controller.close()
        return
      }
      controller.enqueue(
        brand === 'text' ? encoder.encode(String(step.value)) : frameOf(brand, step.value),
      )
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  return { body, type }
}

/** What shapes a successful reply besides its value: the action's static `status`/`headers`
 * with the handler's `ctx.reply` merged over them. */
export interface ReplyShape {
  readonly status?: number | null | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/** The response of a successful dispatch. The status defaults to 200 (204 for no value) unless
 * the action or the handler said otherwise; a 204/304 never carries a body, so a value replied
 * under such a status is dropped rather than producing an invalid response. */
export const responseOf = (value: unknown, requestId: string, shape?: ReplyShape): Response => {
  const headers = new Headers({ [HEADERS.requestId]: requestId })

  for (const [name, header] of Object.entries(shape?.headers ?? {})) {
    headers.set(name, header)
  }

  if (isBranded(value)) {
    const { body, type } = bodyOf(value)
    headers.set('content-type', type)
    headers.set(HEADERS.brand, brandOf(value))

    if (brandOf(value) === 'sse') {
      headers.set('cache-control', 'no-cache')
    }

    return new Response(body, { status: shape?.status ?? 200, headers })
  }

  const status = shape?.status ?? (value === undefined ? 204 : 200)

  if (value === undefined || status === 204 || status === 304) {
    return new Response(null, { status, headers })
  }

  return Response.json(value, { status, headers })
}

/** The response of a failed dispatch: the wire failure as JSON under `error`. */
export const failureResponse = (
  failure: Result.Failure<unknown>,
  requestId: string,
  meta?: Pick<ServiceDef.Meta, 'errors'>,
): Response => {
  // the failure itself is the wire shape (tag normalized, http status added)
  const wire = {
    ...failure,
    error: tagOf(failure),
    message: messageOf(failure),
    causes: [...failure.causes],
    status: statusOf(failure, meta),
  }

  return Response.json(
    { error: wire },
    {
      status: statusOf(failure, meta),
      headers: { [HEADERS.requestId]: requestId, [HEADERS.error]: wire.error },
    },
  )
}
