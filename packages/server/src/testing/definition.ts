import { Db, DbClient } from 'db:core'
import type { ObserveDef, ServerDef } from 'server:core'
import { ObserveExporter, Server, ServerErrors } from 'server:core'
import { Auth } from 'server:plugins'
import type { Operation } from 'std:effect'
import {
  attempt,
  createFuture,
  createScope,
  ensure,
  sleep,
  suspend,
  until,
  useScope,
  within,
} from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'

import pkg from '../../package.json'

import type { TestingDef } from './types'

const RecordingExporterImpl = ObserveExporter.implement<TestingDef.Recorder, []>({
  name: 'server-observe-recording',
  version: pkg.version,
  description: 'Every span and log record kept in memory, for tests',

  *setup() {
    const shipped: ObserveDef.Event[] = []

    return {
      exporter: 'recording',
      shipped,
      spans: name =>
        shipped
          .filter(event => event.t === 'span' && (name === undefined || event.span.name === name))
          .map(event => (event as Extract<ObserveDef.Event, { t: 'span' }>).span),
      logs: pick =>
        shipped
          .filter(event => event.t === 'log')
          .map(event => (event as Extract<ObserveDef.Event, { t: 'log' }>).log)
          .filter(log => pick === undefined || pick(log)),
      *until(pick, timeoutMs = 2000) {
        const started = Date.now()

        for (;;) {
          const hit = shipped.find(pick)

          if (hit) {
            return hit
          }

          if (Date.now() - started > timeoutMs) {
            return yield* fail(
              ServerErrors.TimeoutUnreached,
              `no matching event was recorded within ${timeoutMs}ms`,
            )
          }

          yield* sleep(5)
        }
      },
    }
  },
})

/** The node itself, built INSIDE its own scope: the storage, the kernel, the edge listening. */
function* build(
  options: TestingDef.NodeOptions,
): Operation<Omit<TestingDef.Node, 'effect' | 'call' | 'login' | 'stop'>> {
  yield* BunIO.use()

  if (options.schema && !(yield* Db.context.get())) {
    yield* MemoryAdapter.use()
    yield* DbClient.use({ schema: options.schema })
  }

  yield* MemoryKv.use()

  const server = yield* Server.actions.create({
    name: options.name ?? 'test',
    version: '0.0.0',
    ...options.server,
    services: options.services,
    plugins: [...(options.record ? [RecordingExporter] : []), ...(options.plugins ?? [])],
    edge: options.edge ?? BunEdge,
    listen: { port: 0, hostname: '127.0.0.1' },
  } as ServerDef.Options)
  const info = yield* server.start()
  const url = info.url ?? ''

  const request = function* (path: string, init?: RequestInit): Operation<Response> {
    return yield* until(fetch(`${url}${path}`, init))
  }

  const json = function* (path: string, init?: TestingDef.JsonInit): Operation<TestingDef.Reply> {
    const response = yield* request(path, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init?.headers,
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = yield* until(response.text())

    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    }
  }

  // the node installs its plugins in THIS scope: the recorder's context is readable here, and
  // this task's scope is what `effect` / `call` / `stop` run in (its children see the installs)
  const recorder = options.record ? ((yield* RecordingExporterImpl.context.get()) ?? null) : null

  return { url, server, recorder, scope: yield* useScope(), request, json }
}

/**
 * An `ObserveExporter` that keeps every event it is handed — `TestNode.use({ record: true })`
 * installs it and hands it out as `node.recorder` (or `plugins: [RecordingExporter]` on any node,
 * read through `RecordingExporter.context` where the node was built): `recorder.spans('GET /x')`,
 * `recorder.logs(log => …)`, `yield* recorder.until(event => …)`.
 */
export const RecordingExporter = RecordingExporterImpl.build({
  *export(event: ObserveDef.Event) {
    const context = yield* RecordingExporterImpl.context.expect()

    context.shipped.push(event)
  },
  *start() {},
  *flush() {},
})

/**
 * A LISTENING node for a test, in one install: Bun io, a memory db over `schema` (when given and
 * the scope has none), a memory kv, then `Server.actions.create` + `start()` on a free port — all
 * of it in a scope of the node's own under the caller's, torn down with it. The context is the
 * node: `yield* node.json('/todos', { body })`, `yield* node.call(todos, 'list')`,
 * `yield* node.effect(() => useDb(schema))`, `yield* node.stop()`.
 */
export const TestNode = definePlugin<TestingDef.Node, [options: TestingDef.NodeOptions]>({
  name: 'server-test-node',
  version: pkg.version,
  description: 'A listening node with its storage, for tests',

  *setup(options) {
    const parent = yield* useScope()
    const [scope, destroy] = createScope(parent)

    // the node dies with the scope it was installed in
    yield* ensure(() => destroy())

    // ONE long-lived task of the node's scope builds it and stays suspended: the contexts the
    // installs set live in that scope for as long as the node does (the client session pattern)
    const ready = createFuture<Omit<TestingDef.Node, 'effect' | 'call' | 'login' | 'stop'>>()

    scope.run(
      function* () {
        const built = yield* attempt(() => build(options))

        if (isFailure(built)) {
          ready.reject(built)

          return
        }

        ready.resolve(built.value)
        yield* suspend()
      },
      { detached: true },
    )

    const node = yield* ready.future

    return {
      ...node,
      effect: op => within(node.scope, op),
      login: credentials => within(node.scope, () => Auth.actions.login(credentials)),
      call: ((...args: unknown[]) =>
        within(node.scope, () =>
          (node.server.call as (...rest: unknown[]) => Operation<unknown>)(...args),
        )) as ServerDef.Handle['call'],
      stop: () => within(node.scope, () => node.server.stop()),
    }
  },
}).build()
