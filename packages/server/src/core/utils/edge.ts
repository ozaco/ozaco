import { attempt, each, flow } from 'std:effect'
import type { Flow, Scope } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Meta } from '../types/common'
import type { EdgeRequest, EdgeResponse } from '../types/gateway'

/** Web-standard Request → the platform-neutral edge request (bun + deno adapters share this). */
export const fromWebRequest = (request: Request): EdgeRequest => {
  const url = new URL(request.url)
  const headers: Meta = {}

  for (const [key, value] of request.headers) {
    headers[key] = value
  }

  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    body: request.body
      ? flow<Uint8Array, unknown>(request.body as AsyncIterable<Uint8Array>)
      : undefined,
  }
}

/**
 * Pumps a byte Flow into a web ReadableStream on the given scope (streaming responses). The pump
 * runs DETACHED; consumer cancellation (client abort) halts it promptly, tearing down whatever
 * scope-bound resources feed the flow (db watches behind SSE subscriptions included).
 */
export const flowToReadable = (
  scope: Scope,
  source: Flow<Uint8Array, unknown>,
): ReadableStream<Uint8Array> => {
  let pump: { halt(): unknown } | undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      pump = scope.run(
        function* () {
          const outcome = yield* attempt(function* () {
            for (const chunk of yield* each(source)) {
              controller.enqueue(chunk)
              yield* each.next()
            }
          })

          try {
            if (isFailure(outcome)) {
              controller.error(new Error(outcome.message))
            } else {
              controller.close()
            }
          } catch {
            // consumer already cancelled the stream
          }
        },
        { detached: true },
      )
    },
    cancel() {
      void Promise.resolve(pump?.halt()).catch(() => {})
    },
  })
}

/** The platform-neutral edge response → a web-standard Response. */
export const toWebResponse = (scope: Scope, response: EdgeResponse): Response => {
  const body =
    response.body === undefined
      ? null
      : response.body instanceof Uint8Array
        ? response.body
        : flowToReadable(scope, response.body)

  return new Response(body as AnyType, {
    status: response.status,
    headers: response.headers,
  })
}
