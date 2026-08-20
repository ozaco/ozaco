// oxlint-disable import/exports-last
import type { Operation, Scope } from 'std:effect'
import { operation, run, useScope, withResolvers } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { Fetch, FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { Ws } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'

import {
  addressOf,
  failFromResponse,
  prepareRequest,
  resolveManifest,
  runOnScope,
  taskValue,
} from './internal'
import type {
  AsyncClient,
  AsyncClientFn,
  Client,
  ClientFn,
  ClientOptions,
  ClientState,
  ConnectedClient,
  WatchOptions,
  WatchRows,
} from './types'
import { startWatch } from './watch'

interface FnAddress {
  readonly resource: string
  readonly fn: string
}

/**
 * One HTTP round trip: manifest-driven route (path params filled from args by name and removed
 * from the payload; GET/HEAD/DELETE send the rest as a query string, everything else as a JSON
 * body), bearer token per call, non-2xx mapped to a raised Failure keeping the server's tag.
 */
const doCall = operation(function* (state: ClientState, address: FnAddress, args: unknown) {
  yield* resolveManifest(state)

  const prepared = yield* prepareRequest(state, addressOf(state, address), { args })
  const init: FetchDef.Init = {
    method: prepared.method,
    headers: prepared.headers,
    ...(prepared.body === undefined ? {} : { body: prepared.body }),
  }
  const response = yield* Fetch.actions.request(prepared.url, init)

  if (!response.ok) {
    return yield* failFromResponse({ status: response.status, text: () => response.text() })
  }

  if (response.status === 204) {
    return undefined
  }

  return yield* response.json()
})

const clientFnOf = (state: ClientState, address: FnAddress): ClientFn => {
  const call = (args: unknown): Operation<unknown> => doCall(state, address, args)

  const watch = (args: unknown, onRows: WatchRows, options?: WatchOptions) =>
    operation(function* () {
      yield* resolveManifest(state)

      return yield* startWatch(state, {
        resource: address.resource,
        fn: address.fn,
        args,
        onRows,
        options,
      })
    })()

  return Object.assign(call, { watch })
}

const resourceProxy = (state: ClientState, resource: string): Record<string, ClientFn> => {
  const fns = new Map<string, ClientFn>()

  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') {
          return undefined
        }

        const cached = fns.get(prop)

        if (cached) {
          return cached
        }

        const fn = clientFnOf(state, { resource, fn: prop })

        fns.set(prop, fn)

        return fn
      },
    },
  ) as Record<string, ClientFn>
}

/**
 * Create the typed client for a wizard api tree. Effect-first: every fn returns an `Operation`,
 * realtime pumps and shared sockets are bound to the CALLING scope (they end when it closes).
 *
 * REQUIRES `FetchClient`, `Ws` AND `JsonCodec` installed in the caller's scope — `createClient`
 * installs NOTHING itself. `JsonCodec` is a baseline dependency: every request body, query value
 * and realtime frame is (de)serialized through it. Plain-async consumers (browser apps) should use
 * {@link connectClient}, which owns its scope and installs everything.
 *
 * ```ts
 * const client = yield* createClient<Api>({ url: 'http://localhost:3000' })
 * const page = yield* client.tasks.list({ limit: 10 })
 * const stop = yield* client.tasks.list.watch({}, rows => render(rows))
 * ```
 */
export function* createClient<TApi = Record<string, Record<string, unknown>>>(
  options: ClientOptions,
): Operation<Client<TApi>> {
  const scope = yield* useScope()
  const state: ClientState = { options, scope, manifest: undefined, links: new Map() }
  const resources = new Map<string, Record<string, ClientFn>>()

  const client = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') {
          return undefined
        }

        const cached = resources.get(prop)

        if (cached) {
          return cached
        }

        const resource = resourceProxy(state, prop)

        resources.set(prop, resource)

        return resource
      },
    },
  )

  return client as Client<TApi>
}

const asyncFnOf = (scope: Scope, fn: ClientFn): AsyncClientFn => {
  const call = (args: unknown): Promise<unknown> => runOnScope(scope, () => fn(args))

  const watch = async (args: unknown, onRows: WatchRows, options?: WatchOptions) => {
    const stop = await runOnScope(scope, () => fn.watch(args, onRows, options))

    return () => runOnScope(scope, () => stop())
  }

  return Object.assign(call, { watch })
}

const asyncClientOf = <TApi>(scope: Scope, client: Client<TApi>): AsyncClient<TApi> => {
  const resources = new Map<string, Record<string, AsyncClientFn>>()

  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') {
          return undefined
        }

        const cached = resources.get(prop)

        if (cached) {
          return cached
        }

        const inner = (client as Record<string, Record<string, ClientFn>>)[prop] as Record<
          string,
          ClientFn
        >
        const fns = new Map<string, AsyncClientFn>()
        const resource = new Proxy(
          {},
          {
            get: (_res, fnProp) => {
              if (typeof fnProp !== 'string') {
                return undefined
              }

              const hit = fns.get(fnProp)

              if (hit) {
                return hit
              }

              const wrapped = asyncFnOf(scope, inner[fnProp] as ClientFn)

              fns.set(fnProp, wrapped)

              return wrapped
            },
          },
        ) as Record<string, AsyncClientFn>

        resources.set(prop, resource)

        return resource
      },
    },
  ) as AsyncClient<TApi>
}

/**
 * The plain-async convenience facade: spins its own `run()` root, installs
 * `FetchClient` + `JsonCodec` + `Ws` there, and wraps every fn in a Promise (resolving the raw
 * value, REJECTING with the Failure object — `message` included). `close()` tears the private
 * scope down: every watch stops and every socket closes.
 *
 * ```ts
 * const { client, close } = await connectClient<Api>({ url: 'https://api.example.com' })
 * const page = await client.tasks.list({ limit: 10 })
 * await close()
 * ```
 */
export const connectClient = async <TApi = Record<string, Record<string, unknown>>>(
  options: ClientOptions,
): Promise<ConnectedClient<TApi>> => {
  const gate = withResolvers<void>('client:facade-close')

  let readyResolve: (value: { client: Client<TApi>; scope: Scope }) => void = () => {}
  let readyReject: (reason: unknown) => void = () => {}

  const ready = new Promise<{ client: Client<TApi>; scope: Scope }>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const task = run(function* () {
    yield* install(FetchClient)
    yield* install(JsonCodec)
    yield* install(Ws)

    const client = yield* createClient<TApi>(options)
    const scope = yield* useScope()

    readyResolve({ client, scope })

    // park until close(): the scope (sockets, pumps) lives exactly this long
    yield* gate.operation
  })

  // a failing bootstrap rejects `ready` — the task promise rejects with the Failure object
  taskValue(task).catch((error: unknown) => {
    readyReject(error)
  })

  const { client, scope } = await ready

  return {
    client: asyncClientOf(scope, client),
    close: async () => {
      gate.resolve()
      await taskValue(task).catch(() => undefined)
    },
  }
}
