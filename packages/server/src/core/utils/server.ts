import { Kv } from 'db:core'
import type { Operation } from 'std:effect'
import { attempt, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { LocalCarrier } from '../definition/local'
import { MemoryOutcomes } from '../definition/outcomes'
import { ServerClient } from '../definition/server'
import { ServerErrors } from '../errors'
import { apiOf, installEntry, pluginOf, serverFor } from '../internal/kernel'
import { validateOptions } from '../internal/registry'
import type { CarrierDef } from '../types/carrier'
import type { ServerDef } from '../types/server'
import type { ServiceDef } from '../types/service'

/**
 * Build a server: install the kernel, then every plugin (in order), the carrier (or the local
 * one), the outcome store (memory unless one is installed) and the edge — all std plugins —
 * wire their hooks and option validators into the kernel, validate every action's options, and
 * register this node's services with the carrier. `listen()` starts the edge.
 */
export function* createServer<const TServices extends readonly ServiceDef.Service[]>(
  options: ServerDef.Options<TServices>,
): Operation<ServerDef.Handle<TServices>> {
  const kernel = yield* install(ServerClient, options as unknown as ServerDef.Options)

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
  kernel.kv = !isFailure(yield* attempt(() => Kv.actions.describe()))

  // the registry, not `options.services`: a plugin-registered service (observe) serves too
  for (const def of kernel.registry.services.values()) {
    if (kernel.hosted.has(def.name)) {
      yield* kernel.carrier.actions.serve(def.name, serverFor(kernel, def))
    }
  }

  return {
    api: apiOf(options.services),
    name: kernel.name,
    serviceId: kernel.serviceId,
    call: ServerClient.actions.call,
    emit: ServerClient.actions.emit,
    events: ServerClient.actions.events,
    manifest: ServerClient.actions.manifest,

    *members(service) {
      return yield* kernel.carrier!.actions.members(service)
    },

    *listen(listen) {
      for (const hooks of kernel.hooks) {
        if (hooks.start) {
          yield* hooks.start()
        }
      }

      if (!kernel.edge) {
        return { url: null, port: null }
      }

      yield* kernel.edge.actions.mount()
      const info = yield* kernel.edge.actions.listen(listen ?? {})

      return { url: info.url, port: info.port }
    },

    *stop() {
      // 1. leave the cluster: peers route around this node from here on
      yield* attempt(() => kernel.carrier!.actions.leave())

      // 2. close the front door
      if (kernel.edge) {
        yield* attempt(() => kernel.edge!.actions.stop())
      }

      // 3. let what is running finish (bounded), then stop serving
      const deadline = Date.now() + (options.drainMs ?? kernel.timeoutMs)

      while (kernel.inflight > 0 && Date.now() < deadline) {
        yield* sleep(20)
      }

      for (const service of kernel.hosted) {
        yield* attempt(() => kernel.carrier!.actions.unserve(service))
      }

      // 4. plugins, in reverse install order
      for (const hooks of kernel.hooks.toReversed()) {
        if (hooks.stop) {
          yield* attempt(hooks.stop)
        }
      }
    },
  }
}
