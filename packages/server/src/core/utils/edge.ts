// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { fail } from 'std:result'

import { addRoute } from 'rou3'

import { Server } from '../definition/protocol'
import { ServerClient } from '../definition/server'
import { ServerErrors } from '../errors'
import {
  createEdgeState,
  EdgeStateRef,
  handleRequest,
  mountActions,
  remountActions,
} from '../internal/edge/engine'
import { staticRoutes } from '../internal/edge/files'
import { addRaw, serveHandlers } from '../internal/edge/serve'
import type { EdgeDef } from '../types/edge'
import type { Helpers } from '../types/helpers'

/** What an Edge impl's `setup()` calls: bind the engine to the installed kernel. */
export function* openEdge(): Operation<Helpers.EdgeState> {
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

/**
 * Assemble the edge actions over a runtime driver:
 * `Edge.implement({...}).build(edgeActions(driver))`. The engine is
 * core's; the driver only listens.
 */
export const edgeActions = (driver: EdgeDef.Driver): EdgeDef.Actions => ({
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
  *remount() {
    return remountActions(yield* EdgeStateRef.expect())
  },
  *raw(route) {
    addRaw(yield* EdgeStateRef.expect(), route)
  },
  *static(options) {
    const state = yield* EdgeStateRef.expect()

    for (const route of yield* staticRoutes(options)) {
      addRaw(state, route)
    }
  },
  *socket(route) {
    const state = yield* EdgeStateRef.expect()

    state.socketRoutes.push(route)
    addRoute(state.sockets, 'WS', route.path, route)
    state.kernel.sockets.push({
      path: route.path,
      service: route.service ?? null,
      protocol: route.protocol ?? null,
      description: route.description ?? null,
      authorizeMode: route.authorizeMode ?? 'upgrade',
      defaults: route.defaults ?? null,
      receives: route.receives ?? null,
      sends: route.sends ?? null,
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
