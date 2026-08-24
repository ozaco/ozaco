// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, until } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { addRoute } from 'rou3'

import { Server } from '../definition/protocol'
import { ServerClient } from '../definition/server'
import { ServerErrors } from '../errors'
import {
  createEdgeState,
  decideUpgrade,
  EdgeStateRef,
  handleRequest,
  isSocketRequest,
  mountActions,
  trackBody,
} from '../internal/edge/engine'
import type { EdgeState } from '../internal/edge/engine'
import type { EdgeDef } from '../types/edge'

/** What an Edge impl's `setup()` calls: bind the engine to the installed kernel. */
export function* openEdge(): Operation<EdgeState> {
  const kernel = yield* Server.context.get()

  if (!kernel) {
    return yield* fail(
      ServerErrors.Configuration,
      'an Edge must be installed by createServer (options.edge)',
    )
  }

  return yield* createEdgeState(kernel, {
    call: ServerClient.actions.call,
    emit: ServerClient.actions.emit,
    dispatch: ServerClient.actions.dispatch,
  })
}

/** The promise-land handlers a driver wires its runtime to — each request runs as a task of the
 * edge's scope that lives until the response body is done. */
const serveHandlers = (state: EdgeState): EdgeDef.ServeHandlers => ({
  fetch: request =>
    new Promise<Response>(resolve => {
      void state.scope.run(function* () {
        const outcome = yield* attempt(() => handleRequest(state, request))
        if (isFailure(outcome)) {
          resolve(new Response('internal error', { status: 500 }))
          return
        }
        const { response, done } = trackBody(outcome.value)
        resolve(response)
        // keep this request's scope (and its stream pumps) alive until the body is consumed
        yield* until(done)
      })
    }),
  upgrade: request =>
    new Promise<EdgeDef.Upgrade>(resolve => {
      void state.scope.run(function* () {
        const outcome = yield* attempt(() => decideUpgrade(state, request))
        resolve(
          isFailure(outcome)
            ? { kind: 'reject', response: new Response('upgrade failed', { status: 500 }) }
            : outcome.value,
        )
      })
    }),
  isSocket: request => isSocketRequest(state, request),
})

/**
 * Assemble the edge actions over a runtime driver:
 * `Edge.implement({...}).build({ ...edgeDefaults(), ...edgeActions(driver) })`. The engine is
 * core's; the driver only listens.
 */
export const edgeActions = (driver: EdgeDef.Driver): Omit<EdgeDef.Actions, 'describe'> => ({
  *listen(options) {
    const state = yield* EdgeStateRef.expect()
    mountActions(state)
    const info = yield* driver.serve(options ?? {}, serveHandlers(state))
    state.info = info
    return info
  },
  *stop() {
    const state = yield* EdgeStateRef.expect()
    yield* driver.stop()
    state.info = null
  },
  *pause() {
    ;(yield* EdgeStateRef.expect()).paused = true
  },
  *resume() {
    ;(yield* EdgeStateRef.expect()).paused = false
  },
  *mount() {
    return mountActions(yield* EdgeStateRef.expect())
  },
  *raw(route) {
    const state = yield* EdgeStateRef.expect()
    addRoute(state.router, route.method, route.path, { kind: 'raw', route })
  },
  *socket(route) {
    const state = yield* EdgeStateRef.expect()
    addRoute(state.sockets, 'WS', route.path, route)
    state.kernel.sockets.push({
      path: route.path,
      service: route.service ?? null,
      protocol: route.protocol ?? null,
      description: route.description ?? null,
      defaults: route.defaults ?? null,
    })
  },
  *decorate(decorator) {
    ;(yield* EdgeStateRef.expect()).decorators.push(decorator)
  },
  *preflight(handler) {
    ;(yield* EdgeStateRef.expect()).preflight = handler
  },
  *handle(request) {
    const state = yield* EdgeStateRef.expect()
    mountActions(state)
    return yield* handleRequest(state, request)
  },
  *info() {
    return (yield* EdgeStateRef.expect()).info
  },
})
