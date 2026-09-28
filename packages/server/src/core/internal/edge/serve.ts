import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { isFailure } from 'std:result'

import { addRoute } from 'rou3'

import type { EdgeDef } from '../../types/edge'
import type { Helpers } from '../../types/helpers'

import { crashResponse, decideUpgrade, isSocketRequest, serveRequest } from './engine'

/** The answer of last resort: the edge scope could not even run the request (stopped mid-way). */
export const unavailable = (): Response => new Response('service unavailable', { status: 503 })

/**
 * Run `body` as a task of the edge's scope and settle a promise with what it answers — ALWAYS:
 * a task cut short (the edge stopping) or a scope that can no longer run anything answers
 * `fallback()`.
 */
export const answer = <T>(
  state: Helpers.EdgeState,
  body: (settle: (value: T) => void) => Operation<void>,
  fallback: () => T,
): Promise<T> =>
  new Promise<T>(resolve => {
    let settled = false

    const settle = (value: T): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }

    const last = (): void => {
      if (!settled) {
        settle(fallback())
      }
    }

    try {
      void state.scope.run(
        function* () {
          try {
            yield* body(settle)
          } finally {
            last()
          }
        },
        { detached: true },
      )
    } catch {
      last()
    }
  })

/**
 * The promise-land handlers a driver wires its runtime to — each request runs as a task of the
 * edge's scope that lives until the response body is done. A crash of the engine becomes a 500 in
 * a root edge span `HTTP` (ERROR exception, `x-request-id`).
 */
export const serveHandlers = (state: Helpers.EdgeState): EdgeDef.ServeHandlers => ({
  fetch: (request, peer) =>
    answer<Response>(
      state,
      function* (settle) {
        const served = yield* attempt(() => serveRequest(state, request, peer))

        if (isFailure(served)) {
          settle(yield* crashResponse(state, request, served))

          return
        }

        settle(served.value.response)
        // keep this request's scope (and its stream pumps) alive until the body is consumed
        yield* until(served.value.done)
      },
      unavailable,
    ),
  upgrade: (request, peer) =>
    answer<EdgeDef.Upgrade>(
      state,
      function* (settle) {
        const decided = yield* attempt(() => decideUpgrade(state, request, peer))

        settle(
          isFailure(decided)
            ? { kind: 'reject', response: yield* crashResponse(state, request, decided) }
            : decided.value,
        )
      },
      () => ({ kind: 'reject', response: unavailable() }),
    ),
  isSocket: request => isSocketRequest(state, request),
})

export const addRaw = (state: Helpers.EdgeState, route: EdgeDef.RawRoute): void => {
  state.raws.push(route)
  addRoute(state.router, route.method, route.path, { kind: 'raw', route })
  state.kernel.routes.push({ method: route.method, path: route.path })
}
