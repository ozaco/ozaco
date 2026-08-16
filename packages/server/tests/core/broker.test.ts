import {
  Broker,
  CoreErrors,
  defineAction,
  defineService,
  useCall,
  useLog,
  useResponse,
  useTrace,
} from 'server:core'
import type { Trace } from 'server:core'
import { attempt } from 'std:effect'
import { fail, isFailure, isJust } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { runResult, runScoped } from '../helpers'

import { bootstrap } from './helpers'

const TodoErrors = { NotFound: 'todos.not-found' } as const

const makeTodos = () =>
  defineService({
    name: 'todos',
    version: '1.0.0',
    actions: {
      get: defineAction(
        {
          input: z.object({ id: z.string() }),
          errors: { [TodoErrors.NotFound]: 404 },
        },
        function* (body) {
          if (body.id === 'missing') {
            return yield* fail(TodoErrors.NotFound, `todo "${body.id}" not found`)
          }

          return { id: body.id, title: `todo ${body.id}` }
        },
      ),
      created: defineAction(function* () {
        const res = yield* useResponse()

        res.status = 201
        res.meta['x-extra'] = 'yes'

        return 'created'
      }),
      whoami: defineAction(function* () {
        const call = yield* useCall()
        const trace = yield* useTrace()
        const log = yield* useLog()

        yield* log.debug('whoami', {})

        return { service: call.service, serviceId: call.serviceId, requestId: trace.requestId }
      }),
    },
  })

describe('DefaultBroker', () => {
  it('dispatches a typed call end to end', async () => {
    const result = await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      return yield* Broker.actions.call(todos, 'get', { id: '42' })
    })

    expect(result).toEqual({ id: '42', title: 'todo 42' })
  })

  it('exchange carries the response draft status/meta and a cid', async () => {
    const reply = await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      return yield* Broker.actions.exchange(todos, 'created')
    })

    expect(reply.kind).toBe('value')
    expect(reply.status).toBe(201)
    expect(reply.meta['x-extra']).toBe('yes')
    expect(reply.cid.length).toBeGreaterThan(0)
  })

  it('handler failures keep tag + status + full breadcrumb chain', async () => {
    const outcome = await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      const failure = yield* attempt(() => Broker.actions.call(todos, 'get', { id: 'missing' }))
      const reply = yield* Broker.actions.exchange(todos, 'get', { id: 'missing' })

      return { failure, reply }
    })

    expect(isFailure(outcome.failure)).toBe(true)
    if (isFailure(outcome.failure)) {
      expect(outcome.failure.error).toBe(TodoErrors.NotFound)

      const causes = outcome.failure.causes.join(' | ')

      expect(causes).toContain('action:get(')
      expect(causes).toContain('req:')
      expect(causes).toContain('lane:todos')
      expect(causes).toContain('call:todos.get')
    }

    expect(outcome.reply.kind).toBe('failure')
    if (outcome.reply.kind === 'failure') {
      expect(outcome.reply.status).toBe(404)
      expect(outcome.reply.failure.error).toBe(TodoErrors.NotFound)
    }
  })

  it('nested calls share the requestId and extend the lane', async () => {
    const inner = defineService({
      name: 'inner-svc',
      actions: {
        boom: defineAction(function* () {
          return yield* fail('inner.boom', 'deep failure')
        }),
      },
    })
    const outer = defineService({
      name: 'outer-svc',
      actions: {
        run: defineAction(function* () {
          return yield* Broker.actions.call(inner, 'boom', undefined)
        }),
      },
    })

    const failure = await runResult(function* () {
      yield* bootstrap()
      yield* Broker.actions.register(inner)
      yield* Broker.actions.register(outer)

      yield* Broker.actions.call(outer, 'run', undefined)
    })

    expect(isFailure(failure)).toBe(true)
    if (isFailure(failure)) {
      const causes = failure.causes.join(' | ')

      expect(causes).toContain('lane:outer-svc>inner-svc')

      const requestIds = [...causes.matchAll(/req:(\S+)/gu)].map(match => match[1])

      expect(requestIds.length).toBeGreaterThan(1)
      expect(new Set(requestIds).size).toBe(1)
    }
  })

  it('invoke plants call info, trace and a bound logger', async () => {
    const result = (await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      return yield* Broker.actions.call(todos, 'whoami', undefined)
    })) as { service: string; serviceId: string; requestId: string }

    expect(result.service).toBe('todos')
    expect(result.serviceId).toMatch(/^todos@1\.0\.0#/u)
    expect(result.requestId).toMatch(/^r_/u)
  })

  it('unknown action → no-route; unknown service → unavailable', async () => {
    const outcome = await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      const noRoute = yield* attempt(() => Broker.actions.call('todos', 'nope', undefined))
      const noService = yield* attempt(() => Broker.actions.call('ghosts', 'get', undefined))

      return { noRoute, noService }
    })

    expect(isFailure(outcome.noRoute) && outcome.noRoute.error === CoreErrors.NoRoute).toBe(true)
    expect(isFailure(outcome.noService) && outcome.noService.error === CoreErrors.Unavailable).toBe(
      true,
    )
  })

  it('lifecycle gates: not-started, paused, destroyed', async () => {
    const outcome = await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      yield* Broker.actions.pause()
      const paused = yield* attempt(() => Broker.actions.call(todos, 'get', { id: '1' }))

      yield* Broker.actions.resume()
      const resumed = yield* Broker.actions.call(todos, 'get', { id: '1' })

      yield* Broker.actions.destroy()
      const destroyed = yield* attempt(() => Broker.actions.call(todos, 'get', { id: '1' }))

      return { paused, resumed, destroyed }
    })

    expect(isFailure(outcome.paused) && outcome.paused.error === CoreErrors.Paused).toBe(true)
    expect(outcome.resumed).toEqual({ id: '1', title: 'todo 1' })
    expect(isFailure(outcome.destroyed) && outcome.destroyed.error === CoreErrors.Destroyed).toBe(
      true,
    )
  })

  it('service setup runs on register; register is idempotent-guarded', async () => {
    const outcome = await runScoped(function* () {
      let ran = 0
      const service = defineService({
        name: 'setup-svc',
        actions: { noop: defineAction(function* () {}) },
        *setup() {
          ran += 1
        },
      })

      yield* bootstrap()
      yield* Broker.actions.register(service)

      const duplicate = yield* attempt(() => Broker.actions.register(service))
      const hosts = yield* Broker.actions.hosts('setup-svc')
      const services = yield* Broker.actions.getServices()

      return { ran, duplicate, hosts, services }
    })

    expect(outcome.ran).toBe(1)
    expect(
      isFailure(outcome.duplicate) && outcome.duplicate.error === CoreErrors.Configuration,
    ).toBe(true)
    expect(outcome.hosts).toBe(true)
    expect(outcome.services).toEqual(['setup-svc'])
  })

  it('emit delivers locally with a trace; on() unsubscribes', async () => {
    const outcome = await runScoped(function* () {
      yield* bootstrap()

      const seen: { payload: unknown; trace: Trace | undefined }[] = []
      const off = yield* Broker.actions.on('todo.created', (payload, trace) => {
        seen.push({ payload, trace })
      })

      yield* Broker.actions.emit('todo.created', { id: '1' })
      off()
      yield* Broker.actions.emit('todo.created', { id: '2' })
      yield* Broker.actions.broadcast('todo.created', { id: '3' })

      return seen
    })

    expect(outcome).toHaveLength(1)
    expect(outcome[0]?.payload).toEqual({ id: '1' })
    expect(outcome[0]?.trace?.requestId).toMatch(/^r_/u)
  })

  it('idempotencyKey dedupes: the handler runs once, the reply is shared', async () => {
    const outcome = await runScoped(function* () {
      let runs = 0
      const counter = defineService({
        name: 'counter',
        actions: {
          bump: defineAction(function* () {
            runs += 1

            return runs
          }),
        },
      })

      yield* bootstrap()
      yield* Broker.actions.register(counter)

      const first = yield* Broker.actions.call(counter, 'bump', undefined, {
        idempotencyKey: 'op-1',
      })
      const second = yield* Broker.actions.call(counter, 'bump', undefined, {
        idempotencyKey: 'op-1',
      })
      const third = yield* Broker.actions.call(counter, 'bump', undefined)

      return { runs, first, second, third }
    })

    expect(outcome.runs).toBe(2)
    expect(outcome.first).toBe(1)
    expect(outcome.second).toBe(1)
    expect(outcome.third).toBe(2)
  })

  it('records opt-in outcomes queryable by cid', async () => {
    const outcome = await runScoped(function* () {
      const todos = makeTodos()

      yield* bootstrap()
      yield* Broker.actions.register(todos)

      const reply = yield* Broker.actions.exchange(todos, 'get', { id: '7' }, { outcome: true })
      const stored = yield* Broker.actions.outcome(reply.cid)

      return { reply, stored }
    })

    expect(outcome.reply.kind).toBe('value')
    expect(isJust(outcome.stored)).toBe(true)
    if (isJust(outcome.stored)) {
      expect(outcome.stored.value.state).toBe('fulfilled')
      expect(outcome.stored.value.serviceId).toMatch(/^todos@1\.0\.0#/u)
    }
  })
})
