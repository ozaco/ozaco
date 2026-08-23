import { createServer, Server, ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { attempt, sleep } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { awaitDependencies, healthOf, hostedOf, infoOf, roleOf } from './internal'
import type { AppDef } from './types'

const AppImpl = definePlugin<AppDef.State, [options: AppDef.Options]>({
  name: 'server-app',
  version: '0.5.0',
  description: 'A deployable node: role, hosted services, health, graceful stop',

  *setup(options) {
    const role = roleOf(options)
    const hosted = hostedOf(options, role)
    if (role !== 'monolith' && !options.carrier) {
      return yield* fail(
        ServerErrors.Configuration,
        `role "${role}" needs a carrier (NetworkCarrier)`,
      )
    }
    const server = yield* createServer({ ...options, hosted })
    return { role, hosted, options, server, url: null, started: false, ready: false }
  },
})

/** The app plugin: `start()` mounts the health route, listens (edge roles) and waits for
 * `dependsOn`; `stop()` pauses the edge, then lets the server leave the cluster and drain. */
export const App = AppImpl.build({
  *start(): Operation<AppDef.Info> {
    const state = yield* AppImpl.context.expect()
    const kernel = yield* Server.context.expect()
    const health = state.options.health ?? '/_health'
    if (kernel.edge && health !== false) {
      yield* kernel.edge.actions.raw({
        method: 'GET',
        path: health,
        *handler() {
          const body = yield* healthOf(state, kernel)
          return Response.json(body, { status: body.ready ? 200 : 503 })
        },
      })
    }
    const info = yield* state.server.listen(state.options.listen)
    state.url = info.url
    state.started = true
    yield* awaitDependencies(state)
    state.ready = true
    return infoOf(state)
  },

  *stop(): Operation<void> {
    const state = yield* AppImpl.context.expect()
    const kernel = yield* Server.context.expect()
    state.ready = false
    if (kernel.edge && state.started) {
      // new requests get 503 while in-flight ones finish
      yield* attempt(() => kernel.edge!.actions.pause())
      yield* sleep(Math.min(state.options.drainMs ?? 5000, 50))
    }
    yield* state.server.stop()
    state.started = false
    state.url = null
  },

  *info(): Operation<AppDef.Info> {
    return infoOf(yield* AppImpl.context.expect())
  },

  *health(): Operation<AppDef.Health> {
    const state = yield* AppImpl.context.expect()
    return yield* healthOf(state, yield* Server.context.expect())
  },
})
