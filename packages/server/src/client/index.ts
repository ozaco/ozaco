import { Broker, defineAction, defineService } from 'server:core'
import type { Operation } from 'std:effect'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { ClientBroker } from './definition'
import type { ClientDef } from './types'

/**
 * One stub service: real `defineService`/`defineAction` whose every action body dispatches ITSELF
 * through the broker. `ref` is a stable const holder so each action can reach the built service (and
 * thus its own `{ serviceName, actionKey }`, which `Broker.actions.call` resolves via `getService`)
 * — the service can only exist after its actions, so the reference is necessarily late-bound. The
 * action object doubles as the call `target` the endpoint handle (`buildSurface`) dispatches with.
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

/**
 * Build the client's stub services from an emitted route `Manifest`. Each stub is a real
 * `defineService`/`defineAction` registered with the broker so `Broker.actions.call` can resolve
 * its `{ serviceName, actionKey }`. This is the installable building block — `connect` installs
 * these and layers the typed call surface (`buildSurface`) on top.
 */
const defineClient = (manifest: ClientDef.Manifest): Record<string, AnyType> => {
  const services: Record<string, AnyType> = {}
  for (const [name, routes] of Object.entries(manifest)) {
    services[name] = buildStubService(name, Object.keys(routes))
  }
  return services
}

/**
 * Wrap each stub action into a callable endpoint: calling it with the action's args returns a handle
 * exposing the three consumption modes. Each method re-enters the broker pipeline (policy → tracer →
 * std:fetch core) with its `mode`, so `body()`/`stream()`/`raw()` share one request shape and differ
 * only in how the response is read.
 *
 *   const call = api.todos.actions.list({ page: 1 })
 *   const todos = yield* call.body()    // Future<Todo[]>
 *   const live  = yield* call.stream()  // Stream<Todo>
 *   const bytes = yield* call.raw()     // Stream<Uint8Array>
 */
const buildSurface = (services: Record<string, AnyType>): AnyType => {
  const api: Record<string, AnyType> = {}

  for (const [name, service] of Object.entries(services)) {
    const actions: Record<string, AnyType> = {}

    for (const key of service.getKeys() as string[]) {
      const target = (service.actions as Record<string, AnyType>)[key]
      actions[key] = (...args: unknown[]) => ({
        body: () => Broker.actions.call(target, args, { mode: 'body' } as ClientDef.CallOptions),
        stream: () =>
          Broker.actions.call(target, args, { mode: 'stream' } as ClientDef.CallOptions),
        raw: () => Broker.actions.call(target, args, { mode: 'raw' } as ClientDef.CallOptions),
      })
    }

    api[name] = { actions }
  }

  return api
}

/**
 * Install `ClientBroker` with the manifest, register the stub services (so the broker can resolve
 * each call), start the broker, and return the typed client surface. Standalone — no server runtime.
 * Install any policies (retry/cache/timeout/…) before or after; they apply on the next call.
 *
 *   const api = yield* connect<Services>({ baseUrl: 'https://api.example.com', manifest })
 *   const user = yield* api.users.actions.get({ id }).body()
 */
const connect = function* <TServices>(
  options: ClientDef.Options,
): Operation<ClientDef.Client<TServices>, unknown> {
  yield* install(ClientBroker, options)

  const services = defineClient(options.manifest)
  for (const service of Object.values(services)) {
    yield* install(service)
  }

  yield* Broker.actions.start()
  return buildSurface(services) as ClientDef.Client<TServices>
}

export { connect, defineClient }
export { ClientBroker } from './definition'
export type { ClientDef } from './types'
