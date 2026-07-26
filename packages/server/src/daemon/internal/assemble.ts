import type { Service } from 'server:core'
import { Broker, Gateway } from 'server:core'

import type { DaemonDef } from '../types'

/** What this process does with a module, plus the list its mounts are collected into. */
export interface Plan {
  owned: boolean
  served: boolean
  mounted: Service[]
}

/**
 * Wire one module into this process. `mount` reads only the service's static route/OpenAPI metadata,
 * so serving never boots anything — that is what lets the gateway present a route whose code lives in
 * another pod entirely.
 */
export const assembleModule = function* (
  module: DaemonDef.Module,
  rt: DaemonDef.Runtime,
  { owned, served, mounted }: Plan,
) {
  if (owned && module.setup) {
    yield* module.setup(rt)
  }

  const service = module.service
  if (service === undefined) {
    return
  }

  if (owned) {
    // The service seals itself and installs the plugin that comes out — a protocol is not installable
    // on its own, and routing it through `install` would skip the seal.
    yield* service.actions.install()
    yield* Broker.actions.register(service)
  }

  // Guard the lookup: a process that serves but never installed a gateway degrades to RPC-only
  // instead of crashing on a missing Gateway context.
  if (served && module.route !== undefined && (yield* Gateway.context.get()) !== undefined) {
    yield* Gateway.actions.mount(module.route, service)
    mounted.push(service)
  }
}
