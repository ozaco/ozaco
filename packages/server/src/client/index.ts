import { Broker, defineAction, defineService } from 'server:core'
import type { Operation } from 'std:effect'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { ClientBroker } from './definition'
import type { ClientDef } from './types'

/**
 * Build the client's stub services from an emitted route `Manifest`. Each stub is a real
 * `defineService`/`defineAction` whose body dispatches itself through the broker
 * (`Broker.actions.call`), so the call flows policy → tracer → the std:fetch dispatch core. The
 * result is typed as the app's own `services` (`TServices`) — full input/output inference with no
 * runtime coupling to the backend. Install `ClientBroker` (or use `connect`) to make it callable.
 *
 *   yield* install(ClientBroker, { baseUrl, manifest })
 *   yield* Broker.actions.start()
 *   const user = yield* api.users.actions.get({ id })
 */
/**
 * One stub service: real `defineService`/`defineAction` whose every action body dispatches ITSELF
 * through the broker. `ref` is a stable const holder so each action can reach the built service (and
 * thus its own `{ serviceName, actionKey }`, which `Broker.actions.call` resolves via `getService`)
 * — the service can only exist after its actions, so the reference is necessarily late-bound.
 */
const buildStubService = (name: string, actionKeys: readonly string[]): AnyType => {
  const ref: { service?: AnyType } = {}

  const actions: Record<string, AnyType> = {}
  for (const key of actionKeys) {
    actions[key] = defineAction(function* (...args: unknown[]) {
      return yield* Broker.actions.call(
        (ref.service!.actions as Record<string, AnyType>)[key],
        args,
      )
    })
  }

  ref.service = defineService({ name, version: '0.0.0', actions, *setup() {} } as AnyType)
  return ref.service
}

const defineClient = <TServices>(manifest: ClientDef.Manifest): TServices => {
  const services: Record<string, AnyType> = {}
  for (const [name, routes] of Object.entries(manifest)) {
    services[name] = buildStubService(name, Object.keys(routes))
  }
  return services as TServices
}

/**
 * Sugar over `defineClient` + broker setup: install `ClientBroker` with the manifest, install the
 * stub services (so their actions are callable), start the broker, and return the ready-to-call
 * services. Standalone — no server runtime. Install any policies (retry/cache/timeout/…) before or
 * after; they apply on the next call.
 *
 *   const api = yield* connect<Services>({ baseUrl: 'https://api.example.com', manifest })
 *   const user = yield* api.users.actions.get({ id })
 */
const connect = function* <TServices>(options: ClientDef.Options): Operation<TServices, unknown> {
  yield* install(ClientBroker, options)

  const services = defineClient<TServices>(options.manifest)
  for (const service of Object.values(services as Record<string, AnyType>)) {
    yield* install(service)
  }

  yield* Broker.actions.start()
  return services
}

export { connect, defineClient }
export { ClientBroker } from './definition'
export type { ClientDef } from './types'
