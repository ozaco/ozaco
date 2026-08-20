// oxlint-disable import/exports-last
/**
 * THE INSPECTOR SESSION — everything `createClient`'s typed proxy deliberately hides.
 *
 * The typed client answers "what did the call return?"; a request workspace, a debugger or a
 * generated-docs playground has to answer "what exactly went over the wire, and what came back?".
 * Same addressing, same manifest, same auth, same realtime engine — but here responses arrive
 * whole (status, headers, timing, body UNREAD so streams stay readable), requests carry
 * attachments, and every realtime frame is observable.
 *
 * `createSession` is the effect-land handle; `connectSession` is the plain-async facade that owns
 * its scope and installs `FetchClient` + `JsonCodec` + `Ws` itself — a browser tool needs nothing
 * from `@ozaco/std` to drive it.
 */

import { operation, run, useScope, withResolvers } from 'std:effect'
import type { Operation, Scope } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { Fetch, FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import { Ws } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'

import { ClientErrors } from './errors'
import { addressOf, prepareRequest, resolveManifest, runOnScope, taskValue } from './internal'
import { openSse } from './sse'
import type {
  AsyncRealtimeLink,
  AsyncSession,
  AsyncSseHandle,
  AsyncWatchHandle,
  CallAddress,
  ClientOptions,
  ClientSession,
  ClientState,
  ConnectedSession,
  InspectInput,
  InspectResponse,
  RealtimeLink,
  RequestHandle,
  ResponseKind,
  SseInput,
} from './types'
import { openRealtime } from './watch'

/** Classify a response by `content-type` alone — reading a header never consumes the body. */
export const classifyContentType = (contentType: string | null): ResponseKind => {
  const type = (contentType ?? '').toLowerCase()

  if (type.includes('ndjson')) {
    return 'ndjson'
  }

  if (type.includes('text/event-stream')) {
    return 'sse'
  }

  if (type.includes('json')) {
    return 'json'
  }

  if (type.startsWith('text/')) {
    return 'text'
  }

  return 'bytes'
}

/** Pinned request line, or the manifest route of `<resource>.<fn>`. Pinning always wins. */
const addressFor = operation(function* (state: ClientState, input: InspectInput) {
  if (input.method !== undefined && input.path !== undefined) {
    return { method: input.method.toUpperCase(), path: input.path } as CallAddress
  }

  if (input.resource === undefined || input.fn === undefined) {
    return yield* fail(
      ClientErrors.Request,
      'a request needs either `resource` + `fn` or an explicit `method` + `path`',
    )
  }

  yield* resolveManifest(state)

  const resolved = addressOf(state, { resource: input.resource, fn: input.fn })

  return {
    method: (input.method ?? resolved.method).toUpperCase(),
    path: input.path ?? resolved.path,
  } as CallAddress
})

/** One inspected round trip: nothing parsed, nothing consumed, everything reported. */
export const inspectRequest = operation(function* (state: ClientState, input: InspectInput) {
  const address = yield* addressFor(state, input)
  const sent = yield* prepareRequest(state, address, {
    args: input.args,
    files: input.files,
    headers: input.headers,
  })

  const init: FetchDef.Init = {
    method: sent.method,
    headers: sent.headers,
    ...(sent.body === undefined ? {} : { body: sent.body }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  }

  const started = Date.now()
  const response = yield* Fetch.actions.request(sent.url, init)

  const inspected: InspectResponse = {
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    headers: response.headers,
    requestId: response.headers.get('x-request-id'),
    kind: classifyContentType(response.headers.get('content-type')),
    elapsedMs: Date.now() - started,
    response,
    native: response.native,
    sent,
  }

  return inspected
})

/** Build the inspector handle over an existing client state. */
export const sessionOf = (state: ClientState): ClientSession => ({
  manifest: options =>
    operation(function* () {
      if (options?.refresh === true) {
        state.manifest = undefined
      }

      return yield* resolveManifest(state)
    })(),
  address: (resource, fn) =>
    operation(function* () {
      yield* resolveManifest(state)

      return addressOf(state, { resource, fn })
    })(),
  request: input => inspectRequest(state, input),
  realtime: target =>
    operation(function* () {
      yield* resolveManifest(state)

      return yield* openRealtime(state, target)
    })(),
  sse: (input: SseInput) =>
    operation(function* () {
      yield* resolveManifest(state)

      return yield* openSse(state, input)
    })(),
})

/**
 * Create an inspector session bound to the CALLING scope (sockets and streams end with it).
 *
 * REQUIRES `FetchClient`, `Ws` and `JsonCodec` installed — exactly like {@link createClient}.
 * Browser tooling should reach for {@link connectSession} instead.
 */
export function* createSession(options: ClientOptions): Operation<ClientSession> {
  const scope = yield* useScope()
  const state: ClientState = { options, scope, manifest: undefined, links: new Map() }

  return sessionOf(state)
}

const asyncRealtime = (scope: Scope, link: RealtimeLink): AsyncRealtimeLink => ({
  path: link.path,
  status: link.status,
  tap: link.tap,
  watch: async input => {
    const handle = await runOnScope(scope, () => link.watch(input))
    const wrapped: AsyncWatchHandle = {
      id: handle.id,
      rows: handle.rows,
      version: handle.version,
      stop: () => runOnScope(scope, () => handle.stop()),
    }

    return wrapped
  },
  close: () => runOnScope(scope, () => link.close()),
})

const asyncSession = (scope: Scope, session: ClientSession): AsyncSession => ({
  manifest: options => runOnScope(scope, () => session.manifest(options)),
  address: (resource, fn) => runOnScope(scope, () => session.address(resource, fn)),
  request: input => {
    let settle: (response: InspectResponse) => void = () => {}
    let broken: (reason: unknown) => void = () => {}

    const done = new Promise<InspectResponse>((resolve, reject) => {
      settle = resolve
      broken = reject
    })
    // `std:fetch` aborts through a SCOPE-bound signal, so the request task has to stay parked
    // after the headers land — otherwise the caller's still-unread body dies with the task
    const release = withResolvers<void>('client:request-release')
    const task = scope.run(
      function* () {
        settle(yield* session.request(input))

        yield* release.operation
      },
      { detached: true },
    )

    // a request that never produced headers settles `done` with its failure instead of hanging
    taskValue(task).catch((error: unknown) => {
      broken(error)
    })

    const handle: RequestHandle = {
      done,
      close: async () => {
        release.resolve()
        await taskValue(task).catch(() => undefined)
      },
      cancel: () => runOnScope(scope, () => task.halt()),
    }

    return handle
  },
  realtime: async target => {
    const link = await runOnScope(scope, () => session.realtime(target))

    return asyncRealtime(scope, link)
  },
  sse: async input => {
    const handle = await runOnScope(scope, () => session.sse(input))
    const wrapped: AsyncSseHandle = {
      url: handle.url,
      stop: () => runOnScope(scope, () => handle.stop()),
    }

    return wrapped
  },
})

/**
 * The plain-async inspector facade: spins its own `run()` root, installs
 * `FetchClient` + `JsonCodec` + `Ws` there, and hands back a Promise-facing session. `close()`
 * tears the private scope down — every watch stops, every socket and stream closes.
 *
 * ```ts
 * const { session, close } = await connectSession({ url: '', token: () => bearer })
 * const manifest = await session.manifest()
 * const { done, cancel } = session.request({ resource: 'tasks', fn: 'list', args: { limit: 10 } })
 * ```
 */
export const connectSession = async (options: ClientOptions): Promise<ConnectedSession> => {
  const gate = withResolvers<void>('client:session-close')

  let readyResolve: (value: { session: ClientSession; scope: Scope }) => void = () => {}
  let readyReject: (reason: unknown) => void = () => {}

  const ready = new Promise<{ session: ClientSession; scope: Scope }>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  const task = run(function* () {
    yield* install(FetchClient)
    yield* install(JsonCodec)
    yield* install(Ws)

    const session = yield* createSession(options)
    const scope = yield* useScope()

    readyResolve({ session, scope })

    // park until close(): the scope (sockets, streams, pumps) lives exactly this long
    yield* gate.operation
  })

  // a failing bootstrap rejects `ready` — the task promise settles with the Failure object
  taskValue(task).catch((error: unknown) => {
    readyReject(error)
  })

  const { session, scope } = await ready

  return {
    session: asyncSession(scope, session),
    close: async () => {
      gate.resolve()
      await taskValue(task).catch(() => undefined)
    },
  }
}
