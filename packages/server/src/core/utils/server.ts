import type { Operation } from 'std:effect'
import { attempt, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { LocalCarrier } from '../definition/local'
import { MemoryOutcomes } from '../definition/outcomes'
import { ServerClient } from '../definition/server'
import { ServerErrors } from '../errors'
import { awaitDependencies, healthOf, hostedOf, infoOf, roleOf } from '../internal/app'
import { apiOf, installEntry, pluginOf, serverFor } from '../internal/kernel'
import { validateOptions } from '../internal/registry'
import type { CarrierDef } from '../types/carrier'
import type { Helpers } from '../types/helpers'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'

const DEFAULT_PAUSE_MS = 50
const DEFAULT_DRAIN_MS = 5000

/**
 * Build a node: install the kernel, then every plugin (in order), the carrier (or the local
 * one), the outcome store (memory unless one is installed) and the edge — all std plugins —
 * wire their hooks and option validators into the kernel, validate every action's options, and
 * register the services this node hosts with the carrier.
 *
 * The ROLE decides the shape: `monolith` (services + edge here), `gateway` (edge only, calls
 * forwarded over the carrier), `service` (hosted services, no edge unless one is given).
 * `start()` runs the plugins' start hooks, mounts `/_health`, listens and waits for
 * `dependsOn`; `stop()` pauses, leaves the cluster, drains and tears down in reverse.
 */
export function* createServer<const TServices extends readonly ServiceDef.Service[]>(
  options: ServerDef.Options<TServices>,
): Operation<ServerDef.Handle<TServices>> {
  const role = roleOf(options as ServerDef.Options)

  // an explicit empty `hosted` on a non-gateway is a silent trap: the node hosts nothing, then
  // (by the dependsOn default) waits for its OWN services and dies at start
  if (options.hosted !== undefined && options.hosted.length === 0 && role !== 'gateway') {
    return yield* fail(
      ServerErrors.Configuration,
      `hosted: [] hosts nothing — omit the field to host every declared service, or use role: 'gateway'`,
    )
  }

  if (role !== 'monolith' && !options.carrier) {
    return yield* fail(ServerErrors.Configuration, `role "${role}" needs a carrier`)
  }

  const hosted = hostedOf(options as ServerDef.Options, role)
  const kernel = yield* install(ServerClient, { ...options, hosted } as ServerDef.Options)

  // the carrier first: plugins may lean on it at setup (observe forward/collect, presence)
  if (options.carrier) {
    yield* installEntry(options.carrier)
    kernel.carrier = pluginOf(options.carrier) as CarrierDef.Handle
  } else {
    yield* install(LocalCarrier)
    kernel.carrier = LocalCarrier
  }

  for (const entry of options.plugins ?? []) {
    const context = (yield* installEntry(entry)) as ServerDef.PluginContext | undefined

    if (context?.hooks) {
      kernel.hooks.push(context.hooks)
    }

    for (const [key, schema] of Object.entries(context?.options ?? {})) {
      if (kernel.options.has(key)) {
        return yield* fail(
          ServerErrors.Configuration,
          `action option "${key}" is claimed by two plugins`,
        )
      }

      kernel.options.set(key, schema)
    }
  }

  if (!kernel.outcomes) {
    yield* install(MemoryOutcomes)
    kernel.outcomes = MemoryOutcomes
  }

  if (options.edge) {
    yield* installEntry(options.edge)
    kernel.edge = pluginOf(options.edge) as AnyType
  }

  yield* validateOptions(kernel)

  // the registry, not `options.services`: a plugin-registered service (observe) serves too
  for (const def of kernel.registry.services.values()) {
    if (kernel.hosted.has(def.name)) {
      yield* kernel.carrier.actions.serve(def.name, serverFor(kernel, def))
    }
  }

  const state: Helpers.NodeState = {
    role,
    hosted,
    options: options as ServerDef.Options,
    url: null,
    port: null,
    started: false,
    ready: false,
  }

  function* members(service: string): Operation<readonly CarrierDef.Member[]> {
    return yield* kernel.carrier!.actions.members(service)
  }

  return {
    api: apiOf(options.services),
    name: kernel.name,
    serviceId: kernel.serviceId,
    role,
    call: ServerClient.actions.call,
    emit: ServerClient.actions.emit,
    events: ServerClient.actions.events,
    manifest: ServerClient.actions.manifest,
    members,

    *info() {
      return infoOf(state)
    },

    *health() {
      return yield* healthOf(state, kernel, members)
    },

    *start(listen) {
      const health = options.health ?? '/_health'

      if (kernel.edge && health !== false) {
        yield* kernel.edge.actions.raw({
          method: 'GET',
          path: health,

          *handler() {
            const body = yield* healthOf(state, kernel, members)
            return Response.json(body, { status: body.ready ? 200 : 503 })
          },
        })
      }

      for (const hooks of kernel.hooks) {
        if (hooks.start) {
          yield* hooks.start()
        }
      }

      if (kernel.edge) {
        yield* kernel.edge.actions.mount()
        const info = yield* kernel.edge.actions.listen(listen ?? options.listen ?? {})
        state.url = info.url
        state.port = info.port
      }

      state.started = true
      yield* awaitDependencies(state, members)
      state.ready = true

      return infoOf(state)
    },

    *stop() {
      state.ready = false

      // 1. new requests get 503 while in-flight ones finish
      if (kernel.edge && state.started) {
        yield* attempt(() => kernel.edge!.actions.pause())
        yield* sleep(options.pauseMs ?? DEFAULT_PAUSE_MS)
      }

      // 2. leave the cluster: peers route around this node from here on
      yield* attempt(() => kernel.carrier!.actions.leave())

      // 3. close the front door
      if (kernel.edge) {
        yield* attempt(() => kernel.edge!.actions.stop())
      }

      // 4. let what is running finish (bounded), then stop serving
      const deadline = Date.now() + (options.drainMs ?? DEFAULT_DRAIN_MS)

      while (kernel.inflight > 0 && Date.now() < deadline) {
        yield* sleep(20)
      }

      for (const service of kernel.hosted) {
        yield* attempt(() => kernel.carrier!.actions.unserve(service))
      }

      // 5. plugins, in reverse install order
      for (const hooks of kernel.hooks.toReversed()) {
        if (hooks.stop) {
          yield* attempt(hooks.stop)
        }
      }

      state.started = false
      state.url = null
      state.port = null
    },
  }
}
