import type { ObserveDef, ServerDef } from 'server:core'
import { action, createServer, refs, Server, ServerErrors, service, stream } from 'server:core'
import { attempt, run, sleep } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage, todos } from '../helpers'

describe('kernel — services, dispatch, hooks', () => {
  it('routes default to /<service>/<action>; kinds fix the method; options are collected', () => {
    const def = todos.actions.list.meta
    expect(def.route).toEqual({ method: 'GET', path: '/todos/list' })
    expect(todos.actions.create.meta.route.method).toBe('POST')
    expect(todos.actions.count.meta.outputPlane).toBe('stream')
    expect(todos.actions.slow.meta.options).toEqual({})
    const custom = action.query(
      { input: z.object({}), cache: { ttlMs: 5 }, route: { method: 'GET', path: '/x' } },
      function* () {},
    )
    expect(custom.meta.options).toEqual({ cache: { ttlMs: 5 } })
  })

  it('dispatches locally with validation, ctx.db/log/call/emit, failure fidelity', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos] })
        expect(server.api.todos.create).toEqual({ service: 'todos', action: 'create' })

        const created = yield* server.call(todos, 'create', { title: 'write tests' })
        expect(created).toMatchObject({ title: 'write tests', done: false })
        const listed = yield* server.call(todos, 'list', {})
        expect(listed).toHaveLength(1)

        // input validation: one server.validation with the field path in the causes
        const bad = yield* attempt(server.call(todos, 'create', { title: '' }))
        expect((bad as AnyType).error).toBe(ServerErrors.Validation)
        expect((bad as AnyType).causes.some((cause: string) => cause.startsWith('title:'))).toBe(
          true,
        )

        // a handler failure keeps its tag and gains the action breadcrumb
        const boom = yield* attempt(server.call(todos, 'explode', { code: 'todo.custom' }))
        expect((boom as AnyType).error).toBe('todo.custom')
        expect(
          (boom as AnyType).causes.some((cause: string) =>
            cause.startsWith('action:todos.explode'),
          ),
        ).toBe(true)

        // unknown action
        const none = yield* attempt(server.call(todos as AnyType, 'nope', {}))
        expect((none as AnyType).error).toBe(ServerErrors.NotFound)

        // nested call + emit from inside a handler
        const events = yield* server.events('todo.created')
        const nested = yield* server.call(todos, 'nested', { title: 'nested' })
        expect(nested.title).toBe('nested')
        const event = yield* events.next()
        expect((event.value as AnyType).payload.title).toBe('nested')
      }),
    )
  })

  it('plugins: dispatch hooks wrap in install order, may replace ctx, options are validated', async () => {
    const seen: string[] = []
    const Auth = definePlugin<ServerDef.PluginContext, []>({
      name: 'test-auth',
      version: '0.0.0',
      *setup() {
        return {
          hooks: {
            name: 'auth',
            *dispatch(call, ctx, next) {
              seen.push(`auth:${call.action}`)
              return yield* next(call, { ...ctx, auth: { user: 'ada' } as AnyType })
            },
          },
          options: { auth: z.enum(['user', 'none']) },
        }
      },
    }).build()
    const Timing = definePlugin<ServerDef.PluginContext, [options: { label: string }]>({
      name: 'test-timing',
      version: '0.0.0',
      *setup(options) {
        return {
          hooks: {
            name: options.label,
            *dispatch(call, ctx, next) {
              seen.push(`${options.label}:in ${(ctx.auth as AnyType)?.user ?? 'anon'}`)
              const value = yield* next(call, ctx)
              seen.push(`${options.label}:out`)
              return value
            },
          },
        }
      },
    }).build()
    const whoami = service('who', {
      am: action.query({ output: z.string(), auth: 'user' }, function* ({ ctx }) {
        return (ctx.auth as AnyType).user
      }),
    })
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [whoami],
          plugins: [Auth, Timing.use({ label: 'timing' })],
        })
        expect(yield* server.call(whoami, 'am')).toBe('ada')
        expect(seen).toEqual(['auth:am', 'timing:in ada', 'timing:out'])
      }),
    )

    // an option nobody owns, and an option that fails its validator, refuse the server
    const orphan = service('o', { x: action.query({ cache: { ttlMs: 1 } }, function* () {}) })
    const outcome = await run(function* () {
      yield* storage()
      return yield* createServer({ services: [orphan], plugins: [Auth] })
    })
    expect((outcome as AnyType).error).toBe(ServerErrors.Configuration)
    // `auth: 'admin'` is a COMPILE error now (the requirement is a role ARRAY) — the
    // runtime validator is the second line of defence, and this proves it still holds
    const invalid = service('i', {
      // @ts-expect-error a bare role string is not a Requirement — `['admin']` is
      x: action.query({ auth: 'admin' }, function* () {}),
    })
    const outcome2 = await run(function* () {
      yield* storage()
      return yield* createServer({ services: [invalid], plugins: [Auth] })
    })
    expect((outcome2 as AnyType).error).toBe(ServerErrors.Configuration)
  })

  it('a hook returning a Result envelope is normalized: values unwrap, failures re-raise', async () => {
    // the natural observer shape — `attempt` folds the chain into a Result the hook returns
    const Observer = definePlugin<ServerDef.PluginContext, []>({
      name: 'test-observer',
      version: '0.0.0',
      *setup() {
        return {
          hooks: {
            name: 'observer',
            *dispatch(call, ctx, next) {
              return yield* attempt(() => next(call, ctx))
            },
          },
        }
      },
    }).build()
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], plugins: [Observer] })

        // the client sees the VALUE, never `{ value: { ... } }`
        const created = yield* server.call(todos, 'create', { title: 'enveloped' })
        expect(created.title).toBe('enveloped')
        expect((created as AnyType).value).toBeUndefined()

        // and a captured failure propagates as a failure, not as a success payload
        const boom = yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
        expect((boom as AnyType).error).toBe('x.y')
      }),
    )
  })

  it('deadlines: cancel aborts the handler; detach lets it finish and records the outcome', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], timeoutMs: 100 })
        const late = yield* attempt(server.call(todos, 'slowCancel', { ms: 300 }))
        expect((late as AnyType).error).toBe(ServerErrors.TimeoutPending)
        const detached = yield* attempt(server.call(todos, 'slow', { ms: 200 }, { timeoutMs: 50 }))
        expect((detached as AnyType).error).toBe(ServerErrors.TimeoutPending)
        // the detached handler finished on its own and left an outcome behind
        yield* sleep(250)
        const kernel = yield* Server.actions.describe()
        const pruned = yield* kernel.outcomes!.actions.prune()
        expect(pruned).toBe(0)
      }),
    )
  })

  it('stream outputs come back branded; spans, logs and failures are reported', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const reported: ObserveDef.Event[] = []
        const Spy = definePlugin<ServerDef.PluginContext, []>({
          name: 'spy',
          version: '0.0.0',
          *setup() {
            return {
              hooks: {
                name: 'spy',
                *observe(event) {
                  reported.push(event)
                },
              },
            }
          },
        }).build()
        const server = yield* createServer({ services: [todos], plugins: [Spy] })
        const out = yield* server.call(todos, 'count', { n: 3 })
        expect(out instanceof ReadableStream).toBe(true)
        const values: number[] = []
        const flow = yield* stream.flow(out as AnyType)
        for (;;) {
          const step = yield* flow.next()
          if (step.done) {
            break
          }
          values.push(step.value as number)
        }
        expect(values).toEqual([0, 1, 2])

        // the plainest stream answer: a handler returning an ARRAY is normalized to a flow
        const letters = yield* server.call(todos, 'letters')
        const lettersFlow = yield* stream.flow(letters as AnyType)
        const seen: string[] = []

        for (;;) {
          const step = yield* lettersFlow.next()

          if (step.done) {
            break
          }

          seen.push(step.value as string)
        }

        expect(seen).toEqual(['a', 'b', 'c'])

        yield* server.call(todos, 'create', { title: 'logged' })
        yield* attempt(server.call(todos, 'explode', { code: 'x.y' }))
        const spans = reported.filter(event => event.t === 'span')
        expect(spans.map(event => (event as AnyType).row.name)).toEqual([
          'todos.count',
          'todos.letters',
          'todos.create',
          'todos.explode',
        ])
        expect(spans.map(event => (event as AnyType).row.status)).toEqual([
          'ok',
          'ok',
          'ok',
          'failed',
        ])
        const log = reported.find(event => event.t === 'log') as AnyType
        expect(log.row).toMatchObject({
          level: 'info',
          msg: 'creating',
          data: { title: 'logged' },
        })
        expect(log.row.requestId).toBe((spans[1] as AnyType).row.requestId)
        const failure = reported.find(event => event.t === 'failure') as AnyType
        expect(failure.row).toMatchObject({
          tag: 'x.y',
          where: 'dispatch:todos.explode',
        })
      }),
    )
  })

  it('the manifest lists every action with kind, route, planes and brands', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], name: 'tests', version: '1.2.3' })
        const manifest = yield* server.manifest()
        expect(manifest.name).toBe('tests')
        const count = manifest.actions.find(entry => entry.action === 'count')!
        expect(count).toMatchObject({
          kind: 'stream',
          route: { method: 'GET', path: '/todos/count' },
          outputPlane: 'stream',
          outputBrand: 'ndjson',
        })
      }),
    )
  })
})

describe('kernel — calling by ref', () => {
  it('a typed ref calls the same action as the definition, with no runtime import of it', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos] })

        // built from the service TYPE alone — `refs` only ever sees the name string
        const api = refs<typeof todos>('todos')

        const created = yield* server.call(api.create, { title: 'by ref' })
        expect(created.title).toBe('by ref')

        // the handle's own api map carries the same refs
        const listed = yield* server.call(server.api.todos.list, {})
        expect(listed.map(row => row.title)).toEqual(['by ref'])

        // and the definition form still works, unchanged
        expect((yield* server.call(todos, 'list', {})).length).toBe(1)

        // a garbage target is a configuration failure, not a crash
        const bad = yield* attempt(() => server.call({} as AnyType, 'list', {}))
        expect((bad as AnyType).error).toBe(ServerErrors.Configuration)

        yield* server.stop()
      }),
    )
  })
})
