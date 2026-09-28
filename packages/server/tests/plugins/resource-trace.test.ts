/**
 * crud telemetry (design §7): a BUILT-IN op opens no span of its own — the dispatch span IS the op
 * (`ozaco.crud.scoped`, `ozaco.crud.recovered` on it; the db child spans carry the `db.*` keys) —
 * while a RUNNABLE op inside a custom action opens `crud.{op} {table}`. A hook that replaces what
 * flows through it is an `crud.hook` event. Realtime: `watch {table}` covers subscribe +
 * the initial sync only; every later push is a `record: 'errors'` ROOT `crud.delta {table}` that
 * links the watch span (`crud.watch`) and the writer of the change (`change.writer`); a failed
 * watch is recorded once as an ERROR and the subscriber's error frame is tag + message + `recorded`
 * (the traceparent of the span that recorded it — a subscriber in that trace records nothing).
 * Seen through an in-memory std:trace `Trace` sink.
 */
import { DbClient, where } from 'db:core'
import { action, createServer, Edge, ServerErrors, service } from 'server:core'
import { crud, CrudCauses } from 'server:plugins'
import { run, sleep, until } from 'std:effect'
import { fail, ResultErrors, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { LABELS, storage, todosTable } from '../helpers'

let installs = 0

/** An in-memory std:trace `Trace` sink installed around the server: every span and log record. */
const memoryTracer = () => {
  installs += 1

  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Trace.implement({
    name: `test/resource-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* Trace.actions.enableTracing()

      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit(log: TraceDef.LogData) {
      logs.push(log)
    },
  })

  const named = (name: string): TraceDef.SpanData[] => spans.filter(data => data.name === name)

  const one = (name: string): TraceDef.SpanData => {
    const found = named(name)

    if (found.length !== 1) {
      throw new Error(`expected one span "${name}", got ${found.length}: ${names()}`)
    }

    return found[0]!
  }

  const names = (): string => spans.map(data => data.name).join(', ')
  const childrenOf = (parent: TraceDef.SpanData): TraceDef.SpanData[] =>
    spans.filter(data => data.parent?.spanId === parent.context.spanId)
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)
  const hookPhases = (data: TraceDef.SpanData): unknown[] =>
    data.events
      .filter(event => event.name === 'crud.hook')
      .map(event => event.attributes?.['ozaco.crud.hook.phase'])

  return { plugin, spans, logs, named, one, names, childrenOf, exceptions, hookPhases }
}

const json = function* (path: string, init?: RequestInit) {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  const text = yield* until(response.text())

  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const post = (path: string, body: unknown) =>
  json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** A realtime socket client: every frame it received, and a wait for the n-th. */
const socketClient = (url: string) => {
  const frames: AnyType[] = []
  const ws = new WebSocket(url)

  ws.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))

  const opened = until(
    new Promise<void>(resolve => {
      ws.addEventListener('open', () => resolve())
    }),
  )

  const frame = (at: number) =>
    until(
      new Promise<AnyType>((resolve, reject) => {
        const deadline = Date.now() + 3000
        const poll = () => {
          if (frames.length > at) {
            resolve(frames[at])
          } else if (Date.now() > deadline) {
            reject(new Error(`no frame ${at} — got ${JSON.stringify(frames)}`))
          } else {
            setTimeout(poll, 10)
          }
        }

        poll()
      }),
    )

  return { ws, frames, opened, frame, send: (value: unknown) => ws.send(JSON.stringify(value)) }
}

/** No span anywhere carries the keys the db spans already own under their semconv names. */
const expectNoDuplicateKeys = (spans: readonly TraceDef.SpanData[]): void => {
  for (const data of spans) {
    for (const key of ['ozaco.crud.table', 'ozaco.crud.operation', 'ozaco.crud.returned_rows']) {
      expect(data.attributes[key]).toBeUndefined()
    }
  }
}

/** The `traceparent` a context is written as (`Trace.actions.inject`). */
const traceparentOf = async (context: TraceDef.SpanContext) =>
  unwrap(await run(() => Trace.actions.inject({ context }))).traceparent

describe('resource — telemetry', () => {
  it('a built-in op is its dispatch span; a runnable op in a custom action is its own span', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      // the trusted scope applies to reads only
      scope: {
        *read() {
          return where.eq('done', false)
        },
      },
      extend: {
        open: action.query(
          {
            output: crud.schemas.page(todosTable),
            route: { method: 'GET', path: '/todos/open' },
          },
          function* () {
            return yield* crud.list(todosTable, { scope: where.eq('done', false) })
          },
        ),
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        yield* createServer({ services: [todos], edge: BunEdge })

        expect((yield* post('/todos', { title: 'a', done: false })).status).toBe(200)
        expect((yield* json('/todos')).body.data).toHaveLength(1)
        expect((yield* json('/todos/open')).body.data).toHaveLength(1)

        // a runnable op with no recording parent at all (a script, a start hook) opens nothing
        const db = (yield* DbClient.context.get()) as AnyType

        yield* crud.count(todosTable, { db })
      }),
    )

    // built-ins: no `crud.*` span; the dispatch span says whether a trusted scope applied
    const list = tracer.one('todos.list')
    const create = tracer.one('todos.create')

    expect(list.attributes['ozaco.crud.scoped']).toBe(true)
    expect(create.attributes['ozaco.crud.scoped']).toBe(false)
    expect(tracer.named('crud.list todos')).toHaveLength(1)
    expect(tracer.named('crud.create todos')).toHaveLength(0)
    expect(tracer.named('crud.count todos')).toHaveLength(0)

    // the db spans hang straight off the dispatch span
    expect(tracer.childrenOf(list).map(data => data.name)).toEqual(['find todos'])
    expect(tracer.childrenOf(create).map(data => data.name)).toEqual(['insert todos'])

    // the custom action's runnable op: its own span under the dispatch, the db span under it
    const open = tracer.one('todos.open')
    const op = tracer.one('crud.list todos')

    expect(op.parent?.spanId).toBe(open.context.spanId)
    expect(op.kind).toBe('internal')
    expect(op.scope.name).toBe('@ozaco/server/crud')
    expect(op.attributes['ozaco.crud.scoped']).toBe(true)
    expect(open.attributes['ozaco.crud.scoped']).toBeUndefined()
    expect(tracer.childrenOf(op).map(data => data.name)).toEqual(['find todos'])
    expect(tracer.childrenOf(op)[0]!.attributes['db.collection.name']).toBe('todos')

    expectNoDuplicateKeys(tracer.spans)
  })

  it('hooks that replace are events on the dispatch span; a recovered failure stays visible', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      *before({ op, input }) {
        if (op === 'create') {
          return { ...(input as AnyType), title: `${(input as AnyType).title}!` }
        }
      },
      *after({ op, output }) {
        if (op === 'get') {
          return { ...(output as AnyType), title: 'seen' }
        }
      },
      *around({ op, input }, next) {
        // `list` passes straight through: no replacement, no event
        if (op === 'remove') {
          return { removed: false }
        }

        return yield* next(input)
      },
      *error({ op, input }) {
        if (op === 'get') {
          const now = new Date().toISOString()

          return {
            _id: String((input as AnyType).id),
            _created_at: now,
            _updated_at: now,
            _version: 'ghost',
            title: 'ghost',
            done: false,
            note: null,
          }
        }

        if (op === 'update') {
          return yield* fail(ServerErrors.BadRequest, 'update rewritten by hook')
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        yield* createServer({ services: [todos], edge: BunEdge })

        const created = yield* post('/todos', { title: 'a', done: false })

        expect(created.body.title).toBe('a!')
        expect((yield* json(`/todos/${created.body._id}`)).body.title).toBe('seen')
        expect((yield* json('/todos')).status).toBe(200)
        expect((yield* json(`/todos/${created.body._id}`, { method: 'DELETE' })).body).toEqual({
          removed: false,
        })

        // the error hook RECOVERS a miss with a stub row
        const ghost = yield* json('/todos/nope')

        expect(ghost.body.title).toBe('ghost')

        // …and REPLACES another with its own failure
        const rewritten = yield* json('/todos/nope', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'x' }),
        })

        expect(rewritten.status).toBe(400)
      }),
    )

    expect(tracer.hookPhases(tracer.one('todos.create'))).toEqual(['before'])
    expect(tracer.hookPhases(tracer.one('todos.list'))).toEqual([])
    expect(tracer.hookPhases(tracer.one('todos.remove'))).toEqual(['around'])
    expect(tracer.hookPhases(tracer.one('todos.update'))).toEqual(['error'])

    const gets = tracer.named('todos.get')
    const seen = gets.find(data => data.attributes['ozaco.crud.recovered'] === undefined)!
    const recovered = gets.find(data => data.attributes['ozaco.crud.recovered'] === true)!

    expect(tracer.hookPhases(seen)).toEqual(['after'])
    expect(tracer.hookPhases(recovered)).toEqual(['error'])
    expect(recovered.status.code).toBe('unset')

    // the miss the hook swallowed: ONE handled (WARN) record on the dispatch span, its cause
    // naming the op that missed
    const misses = tracer
      .exceptions()
      .filter(log => log.attributes['exception.type'] === ServerErrors.NotFound)

    expect(misses).toHaveLength(2)

    const swallowed = misses.find(log => log.context?.spanId === recovered.context.spanId)!

    expect(swallowed.severityNumber).toBe(13)
    expect(swallowed.attributes['ozaco.failure.causes']).toEqual([CrudCauses.Get])

    // the miss an unrelated replacement hid: handled on its dispatch span, beside the replacement
    const update = tracer.one('todos.update')
    const hidden = misses.find(log => log.context?.spanId === update.context.spanId)!

    expect(hidden.severityNumber).toBe(13)
    expect(hidden.attributes['ozaco.failure.causes']).toEqual([CrudCauses.Update])

    const replacement = tracer
      .exceptions()
      .filter(log => log.attributes['exception.type'] === ServerErrors.BadRequest)

    expect(replacement).toHaveLength(1)
    expect(replacement[0]!.context?.spanId).toBe(update.context.spanId)
  })

  it('an error hook that WRAPS the failure (a nested cause) hides nothing: no separate handled record', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      *error({ op, failure }) {
        if (op === 'update') {
          // the miss goes on as the replacement's nested cause — at any depth
          return yield* fail(
            ServerErrors.BadRequest,
            'update rewritten by hook',
            fail('todos.inner', 'still the miss underneath', failure),
          )
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        yield* createServer({ services: [todos], edge: BunEdge })

        const rewritten = yield* json('/todos/nope', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'x' }),
        })

        expect(rewritten.status).toBe(400)
      }),
    )

    const update = tracer.one('todos.update')

    expect(tracer.hookPhases(update)).toEqual(['error'])

    // the miss is part of the replacement's chain — never a record of its own
    const records = tracer.exceptions().filter(log => log.context?.spanId === update.context.spanId)

    expect(records.map(log => log.attributes['exception.type'])).toEqual([ServerErrors.BadRequest])
    expect(records[0]!.attributes['ozaco.failure.chain']).toEqual([
      `${ServerErrors.BadRequest}: update rewritten by hook`,
      'todos.inner: still the miss underneath',
      expect.stringContaining(ServerErrors.NotFound),
    ])
  })

  it('NotFound names the op that missed', async () => {
    const todos = crud(todosTable)
    /** The miss's own cause, then the kernel's breadcrumb (the request — nothing is traced
     * here) and the plugin runtime's labels of the edge dispatch. */
    const located = (answer: { body: AnyType }, op: string, cause: string) => [
      cause,
      `action:todos.${op} req:${answer.body.error.requestId}`,
      ...LABELS.dispatch,
    ]

    unwrap(
      await run(function* () {
        yield* storage()
        yield* createServer({ services: [todos], edge: BunEdge })

        const missing = yield* json('/todos/nope')

        expect(missing.status).toBe(404)
        expect(missing.body.error.causes).toEqual(located(missing, 'get', CrudCauses.Get))

        const patched = yield* json('/todos/nope', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'x' }),
        })

        expect(patched.body.error.causes).toEqual(located(patched, 'update', CrudCauses.Update))

        const replaced = yield* json('/todos/nope', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'x', done: false }),
        })

        expect(replaced.body.error.causes).toEqual(located(replaced, 'replace', CrudCauses.Replace))
      }),
    )
  })

  it('realtime: watch = subscribe + sync; a failing push is its own root linking the watch and the writer', async () => {
    const tracer = memoryTracer()
    let failed: AnyType = null
    const todos = crud(todosTable, {
      *after({ op, output }) {
        const frame = output as AnyType
        const explodes =
          op === 'watch' &&
          frame.t === 'delta' &&
          frame.added.some((row: AnyType) => row.title === 'explode')

        if (explodes) {
          return yield* fail('todos.exploded', 'the delta exploded')
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        yield* server.call(todos, 'create', { title: 'first', done: false })
        client.send({ t: 'watch', id: 'w1' })
        expect((yield* client.frame(0)).t).toBe('sync')

        // a push that goes out: exported nothing (`record: 'errors'`)
        yield* server.call(todos, 'create', { title: 'second', done: false })
        expect((yield* client.frame(1)).t).toBe('delta')

        // a push that fails: the watch ends with an error frame — tag, message and the span
        // that recorded it
        yield* server.call(todos, 'create', { title: 'explode', done: false })
        failed = yield* client.frame(2)
        expect(failed).toEqual({
          t: 'error',
          id: 'w1',
          tag: 'todos.exploded',
          message: 'the delta exploded',
          recorded: expect.any(String),
        })

        client.ws.close()
        yield* server.stop()
      }),
    )

    // the watch span: under the frame that asked for it, ended with the initial sync — and
    // INSIDE that frame's span (the handler holds the frame until the subscribe phase is over)
    const watch = tracer.one('watch todos')
    const frame = tracer
      .named('WS /todos/_realtime')
      .find(data => data.context.spanId === watch.parent?.spanId)

    expect(frame).toBeDefined()
    expect(watch.start).toBeGreaterThanOrEqual(frame!.start)
    expect(watch.end).toBeLessThanOrEqual(frame!.end)
    expect(watch.scope.name).toBe('@ozaco/server/crud')
    expect(watch.attributes['ozaco.crud.scoped']).toBe(false)
    expect(watch.status.code).toBe('unset')
    expect(watch.events.map(event => event.name)).toContain('ws.send')

    // only the FAILED push was exported — a root of its own
    const [push] = tracer.named('crud.delta todos')

    expect(tracer.named('crud.delta todos')).toHaveLength(1)
    expect(push!.parent).toBeNull()
    expect(push!.context.traceId).not.toBe(watch.context.traceId)
    expect(push!.status.code).toBe('error')
    expect(push!.attributes['error.type']).toBe('todos.exploded')
    expect(push!.start).toBeGreaterThan(watch.end)

    // …linking the watch span and the WRITER (the dispatch of the create that caused it)
    const writer = tracer.named('todos.create').at(-1)!
    const reasons = Object.fromEntries(
      push!.links.map(link => [String(link.attributes?.['ozaco.link.reason']), link.context]),
    )

    expect(reasons['crud.watch']?.spanId).toBe(watch.context.spanId)
    expect(reasons['change.writer']?.spanId).toBe(writer.context.spanId)
    expect(reasons['change.writer']?.traceId).toBe(writer.context.traceId)

    // ONE record, an ERROR, on the push span
    const records = tracer
      .exceptions()
      .filter(log => log.attributes['exception.type'] === 'todos.exploded')

    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(17)
    expect(records[0]!.context?.spanId).toBe(push!.context.spanId)
    // the error frame names the push that recorded it (another trace than the watch's)
    expect(failed.recorded).toBe(await traceparentOf(push!.context))

    expectNoDuplicateKeys(tracer.spans)
  })

  it('realtime: a push that THROWS ends the watch as `server.internal` with the fold’s message', async () => {
    const tracer = memoryTracer()
    let failed: AnyType = null
    const todos = crud(todosTable, {
      *after({ op, output }) {
        const frame = output as AnyType
        const throws =
          op === 'watch' &&
          frame.t === 'delta' &&
          frame.added.some((row: AnyType) => row.title === 'throw')

        if (throws) {
          throw new TypeError('the delta threw')
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        client.send({ t: 'watch', id: 'w1' })
        expect((yield* client.frame(0)).t).toBe('sync')

        yield* server.call(todos, 'create', { title: 'throw', done: false })
        failed = yield* client.frame(1)

        client.ws.close()
        yield* server.stop()
      }),
    )

    // a thrown error (`asFailure`'s `std:result.unknown` fold) is `server.internal` on the frame,
    // its message the fold's
    expect(failed).toMatchObject({
      t: 'error',
      id: 'w1',
      tag: ServerErrors.Internal,
      message: 'TypeError: the delta threw',
    })

    const [push] = tracer.named('crud.delta todos')

    expect(push!.attributes['error.type']).toBe(ServerErrors.Internal)

    const records = tracer
      .exceptions()
      .filter(log => log.attributes['exception.type'] === ResultErrors.Unknown)

    expect(records).toHaveLength(1)
    expect(records[0]!.attributes['exception.message']).toBe('TypeError: the delta threw')
  })

  it('realtime: a slow subscribe holds its frame — `watch` sits inside the frame span, the next frame waits', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      *before({ op }) {
        // the subscribe phase takes a while (a real suspension, not a same-turn query)
        if (op === 'watch') {
          yield* sleep(25)
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        // two watches back to back: the second frame is taken once the first one subscribed
        client.send({ t: 'watch', id: 'a' })
        client.send({ t: 'watch', id: 'b' })
        expect((yield* client.frame(0)).id).toBe('a')
        expect((yield* client.frame(1)).id).toBe('b')

        client.ws.close()
        yield* server.stop()
      }),
    )

    const watches = tracer.named('watch todos')

    expect(watches).toHaveLength(2)

    for (const watch of watches) {
      const frame = tracer
        .named('WS /todos/_realtime')
        .find(data => data.context.spanId === watch.parent?.spanId)

      expect(frame).toBeDefined()
      expect(watch.start).toBeGreaterThanOrEqual(frame!.start)
      expect(watch.end).toBeLessThanOrEqual(frame!.end)
    }

    // …and in frame order: the second subscribe starts after the first one ended
    const [first, second] = watches.toSorted((left, right) => left.start - right.start)

    expect(second!.start).toBeGreaterThanOrEqual(first!.end)
  })

  it('realtime (windowed): a failing recompute links its writer through the change feed', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      *after({ op, output }) {
        const frame = output as AnyType

        if (op === 'watch' && frame.t === 'delta') {
          return yield* fail('todos.exploded', 'the window exploded')
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        client.send({ t: 'watch', id: 'page', limit: 5 })
        expect((yield* client.frame(0)).t).toBe('sync')

        yield* server.call(todos, 'create', { title: 'enters the window', done: false })
        expect(yield* client.frame(1)).toMatchObject({ t: 'error', id: 'page' })

        client.ws.close()
        yield* server.stop()
      }),
    )

    const watch = tracer.one('watch todos')
    const push = tracer.one('crud.delta todos')
    const writer = tracer.one('todos.create')
    const reasons = Object.fromEntries(
      push.links.map(link => [String(link.attributes?.['ozaco.link.reason']), link.context]),
    )

    expect(reasons['crud.watch']?.spanId).toBe(watch.context.spanId)
    expect(reasons['change.writer']?.spanId).toBe(writer.context.spanId)

    // the recompute's own read is part of the push
    expect(tracer.childrenOf(push).map(data => data.name)).toContain('find todos')
  })

  it('a failed subscribe is ONE ERROR record on the watch span; the frame names that span', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, { filterable: ['title'] })
    let error: AnyType = null

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        // a field the resource does not let clients filter on
        client.send({ t: 'watch', id: 'bad', filter: { op: 'eq', field: 'done', value: true } })
        error = yield* client.frame(0)
        expect(Object.keys(error).toSorted()).toEqual(['id', 'message', 'recorded', 't', 'tag'])
        expect(error.t).toBe('error')

        client.ws.close()
        yield* server.stop()
      }),
    )

    const watch = tracer.one('watch todos')

    expect(watch.status.code).toBe('error')

    // a failed subscribe too sits inside the frame span that asked for it
    const frame = tracer
      .named('WS /todos/_realtime')
      .find(data => data.context.spanId === watch.parent?.spanId)

    expect(watch.start).toBeGreaterThanOrEqual(frame!.start)
    expect(watch.end).toBeLessThanOrEqual(frame!.end)

    const records = tracer.exceptions()

    expect(records).toHaveLength(1)
    expect(records[0]!.severityNumber).toBe(17)
    expect(records[0]!.context?.spanId).toBe(watch.context.spanId)
    expect(watch.attributes['error.type']).toBe(records[0]!.attributes['exception.type'])
    // `recorded`: the watch span that recorded it, in the trace the watch frame came in
    expect(error.recorded).toBe(await traceparentOf(watch.context))
  })

  it('realtime (delta): a push links only the writers of the rows it carries', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      filterable: ['done'],
      *after({ op, output }) {
        const frame = output as AnyType
        const explodes =
          op === 'watch' &&
          frame.t === 'delta' &&
          frame.added.some((row: AnyType) => row.title === 'explode')

        if (explodes) {
          return yield* fail('todos.exploded', 'the delta exploded')
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        client.send({ t: 'watch', id: 'open', filter: { op: 'eq', field: 'done', value: false } })
        expect((yield* client.frame(0)).t).toBe('sync')

        // a write OUTSIDE the watched set: the watch recomputes to an empty diff, pushes nothing
        yield* server.call(todos, 'create', { title: 'finished', done: true })
        yield* sleep(30)

        // the write the next (failing) push carries
        yield* server.call(todos, 'create', { title: 'explode', done: false })
        expect((yield* client.frame(1)).t).toBe('error')

        client.ws.close()
        yield* server.stop()
      }),
    )

    const [outside, carried] = tracer.named('todos.create')
    const writers = tracer
      .one('crud.delta todos')
      .links.filter(link => link.attributes?.['ozaco.link.reason'] === 'change.writer')
      .map(link => link.context.spanId)

    expect(writers).toEqual([carried!.context.spanId])
    expect(writers).not.toContain(outside!.context.spanId)
  })

  it('a watch error hook replacing the failure keeps the one it hides visible (handled)', async () => {
    const tracer = memoryTracer()
    const todos = crud(todosTable, {
      filterable: ['title'],
      *error({ op }) {
        if (op === 'watch') {
          return yield* fail('todos.refused', 'watch refused by the hook')
        }
      },
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [todos], edge: BunEdge })
        const info = yield* server.start({ port: 0 })
        const client = socketClient(`${info.url!.replace('http', 'ws')}/todos/_realtime`)

        yield* client.opened

        // a field clients may not filter on: the subscribe fails, the hook replaces the failure
        client.send({ t: 'watch', id: 'bad', filter: { op: 'eq', field: 'done', value: true } })
        expect((yield* client.frame(0)).tag).toBe('todos.refused')

        client.ws.close()
        yield* server.stop()
      }),
    )

    const watch = tracer.one('watch todos')

    expect(tracer.hookPhases(watch)).toEqual(['error'])
    expect(watch.attributes['error.type']).toBe('todos.refused')

    // the replacement: the watch's ERROR; the failure it replaced: handled (WARN), same span
    const records = tracer.exceptions()

    expect(records.map(log => log.severityNumber).toSorted()).toEqual([13, 17])

    const replaced = records.find(log => log.severityNumber === 17)!
    const hidden = records.find(log => log.severityNumber === 13)!

    expect(replaced.attributes['exception.type']).toBe('todos.refused')
    expect(hidden.attributes['exception.type']).not.toBe('todos.refused')
    expect(hidden.context?.spanId).toBe(watch.context.spanId)
  })

  it('a runnable op inside a custom action under a service call is spanned too', async () => {
    const tracer = memoryTracer()
    const notes = service('notes', {
      seed: action.mutation({ input: z.object({ title: z.string() }) }, function* ({ input }) {
        return yield* crud.create(todosTable, { value: { title: input.title, done: false } })
      }),
    })

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()

        const server = yield* createServer({ services: [notes] })

        yield* server.call(notes, 'seed', { title: 'x' })
      }),
    )

    const op = tracer.one('crud.create todos')

    expect(op.parent?.spanId).toBe(tracer.one('notes.seed').context.spanId)
    expect(tracer.childrenOf(op).map(data => data.name)).toEqual(['insert todos'])
  })
})
