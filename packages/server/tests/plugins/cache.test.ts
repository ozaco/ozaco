import { Kv, useDb } from 'db:core'
import { action, createServer, service } from 'server:core'
import { Cache } from 'server:plugins'
import type { Operation } from 'std:effect'
import { all, attempt, run, sleep } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import { enableTracing, Tracer, traceparentOf } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage, testSchema } from '../helpers'

let installs = 0

/** An in-memory std:trace `Tracer` installed around the server: every span and log record. */
const memoryTracer = () => {
  installs += 1
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/cache-tracer-${installs}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
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
  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, named, exceptions }
}

/** A std Logger transport keeping every entry. */
const captureLogger = () => {
  installs += 1
  const entries: LoggerDef.Entry[] = []

  const plugin = LoggerTransport.implement({
    name: `test/cache-capture-${installs}`,
    version: '1.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace }
    },
  }).build({
    *write(entry: LoggerDef.Entry) {
      entries.push(entry)
    },
    *flush() {},
    *close() {},
  })

  return { plugin, entries }
}

/** A Kv whose `invalidate` fails while `broken.on` (the store is down). */
const breakable = () => {
  const broken = { on: false }

  function* install(): Operation<void> {
    // a readonly-rest member (`invalidate(...tags: readonly string[])`) types its hook like any
    yield* Kv.around({
      *invalidate(args, next) {
        if (broken.on) {
          return yield* fail('test.kv-down', 'the kv store is down')
        }
        return yield* next(...args)
      },
    })
  }

  return { broken, install }
}

const make = () => {
  const counters = { computed: 0 }
  const svc = service('c', {
    get: action.query(
      {
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), n: z.number() }),
        cache: { ttlMs: 10_000, tags: ['todos'] },
      },
      function* ({ input, ctx }) {
        counters.computed += 1
        const n = counters.computed
        yield* ctx.span('c.compute', function* () {
          yield* sleep(input.id.startsWith('slow') ? 20 : 0)
        })
        if (input.id.startsWith('bad')) {
          return yield* fail('c.broken', `cannot compute ${input.id}`)
        }
        return { id: input.id, n }
      },
    ),
    mine: action.query(
      { output: z.number(), cache: { ttlMs: 10_000, vary: ['auth.id'] } },
      function* () {
        counters.computed += 1
        return counters.computed
      },
    ),
    bump: action.mutation({ invalidate: ['todos'] }, function* () {}),
    write: action.mutation({ input: z.object({ title: z.string() }) }, function* ({ input }) {
      const db = yield* useDb(testSchema)
      yield* db.insert('todos', { title: input.title, done: false })
    }),
  })
  return { svc, counters }
}

describe('cache', () => {
  it('caches query results by input/vary, invalidates by tags, mutations and db changes', async () => {
    const { svc, counters } = make()
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        yield* server.start()
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 1 })
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 1 })
        expect(yield* server.call(svc, 'get', { id: 'b' })).toEqual({ id: 'b', n: 2 })
        expect(counters.computed).toBe(2)
        // the store holds the entries under the cache prefix, as envelopes
        const { keys } = yield* Kv.actions.keys('cache:')
        expect(keys.length).toBe(2)
        expect(yield* Kv.actions.get(keys[0]!)).toMatchObject({
          $oz: 1,
          v: { id: expect.any(String) },
        })

        // a mutation with `invalidate` drops the tag
        yield* server.call(svc, 'bump')
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 3 })

        // a db write to the tagged table invalidates too (via the change feed)
        yield* server.call(svc, 'write', { title: 'x' })
        yield* sleep(30)
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 4 })

        // vary on auth only: the same user shares one entry
        expect(yield* server.call(svc, 'mine')).toBe(5)
        expect(yield* server.call(svc, 'mine')).toBe(5)
        yield* server.stop()
      }),
    )
  })
})

describe('cache — telemetry', () => {
  it('a lookup is an INTERNAL `cache` span: a miss computes UNDER it, a hit LINKS the producer', async () => {
    const tracer = memoryTracer()
    const { svc } = make()
    const stored: AnyType[] = []

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 1 })
        expect(yield* server.call(svc, 'get', { id: 'a' })).toEqual({ id: 'a', n: 1 })
        const { keys } = yield* Kv.actions.keys('cache:')
        stored.push(yield* Kv.actions.get(keys[0]!))
      }),
    )

    const [miss, hit] = tracer.named('cache c.get')
    const [first, second] = tracer.named('c.get')
    const compute = tracer.named('c.compute')
    expect(tracer.named('cache c.get')).toHaveLength(2)
    expect(compute).toHaveLength(1)

    // ALWAYS internal, the plugin's own scope, under the dispatch span
    for (const data of [miss!, hit!]) {
      expect(data.kind).toBe('internal')
      expect(data.scope.name).toBe('@ozaco/server/cache')
      expect(data.status.code).toBe('unset')
      expect(data.attributes).toMatchObject({
        'ozaco.cache.key': expect.stringMatching(/^cache:c\.get:/u),
        'ozaco.cache.store': 'memory',
        'ozaco.cache.ttl_ms': 10_000,
        'ozaco.cache.coalesced': false,
      })
    }
    expect(miss!.parent?.spanId).toBe(first!.context.spanId)
    expect(hit!.parent?.spanId).toBe(second!.context.spanId)
    expect(miss!.attributes['ozaco.cache.hit']).toBe(false)
    expect(hit!.attributes['ozaco.cache.hit']).toBe(true)

    // the handler's work on the miss nests under the cache span
    expect(compute[0]!.parent?.spanId).toBe(miss!.context.spanId)

    // the entry carries its producer; the hit (another trace) links it
    expect(stored[0]).toEqual({
      $oz: 1,
      v: { id: 'a', n: 1 },
      tp: traceparentOf(miss!.context),
    })
    expect(miss!.links).toEqual([])
    expect(hit!.context.traceId).not.toBe(miss!.context.traceId)
    expect(hit!.links).toHaveLength(1)
    expect(hit!.links[0]!.context).toMatchObject({
      traceId: miss!.context.traceId,
      spanId: miss!.context.spanId,
    })
    expect(hit!.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'cache.producer' })
  })

  it('a coalesced wait links the producer; a legacy plain value is a hit without a link', async () => {
    const tracer = memoryTracer()
    const { svc, counters } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })

        const both = yield* all([
          server.call(svc, 'get', { id: 'slow-x' }),
          server.call(svc, 'get', { id: 'slow-x' }),
        ])
        expect(both[0]).toEqual(both[1])
        expect(counters.computed).toBe(1)

        // an entry written before the envelope existed: served as is
        yield* server.call(svc, 'get', { id: 'legacy' })
        const { keys } = yield* Kv.actions.keys('cache:')
        for (const key of keys) {
          const entry = (yield* Kv.actions.get(key)) as AnyType
          if (entry.v.id === 'legacy') {
            yield* Kv.actions.set(key, { id: 'legacy', n: 99 }, { ttlMs: 10_000 })
          }
        }
        expect(yield* server.call(svc, 'get', { id: 'legacy' })).toEqual({ id: 'legacy', n: 99 })
      }),
    )

    const spans = tracer.named('cache c.get')
    const coalesced = spans.find(data => data.attributes['ozaco.cache.coalesced'] === true)!
    const key = coalesced.attributes['ozaco.cache.key']
    const miss = spans.find(
      data => data.attributes['ozaco.cache.key'] === key && data !== coalesced,
    )!
    expect(miss.attributes).toMatchObject({
      'ozaco.cache.hit': false,
      'ozaco.cache.coalesced': false,
    })
    expect(coalesced.attributes['ozaco.cache.hit']).toBe(false)
    expect(coalesced.links).toHaveLength(1)
    expect(coalesced.links[0]!.context.spanId).toBe(miss.context.spanId)
    expect(coalesced.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'cache.producer' })

    const legacy = spans.at(-1)!
    expect(legacy.attributes['ozaco.cache.hit']).toBe(true)
    expect(legacy.links).toEqual([])
  })

  it('a failed miss is recorded once per trace — a coalesced waiter gets its own record', async () => {
    const tracer = memoryTracer()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        const outcomes = yield* all([
          attempt(server.call(svc, 'get', { id: 'bad-slow' })),
          attempt(server.call(svc, 'get', { id: 'bad-slow' })),
        ])
        expect(outcomes.map(outcome => (outcome as AnyType).error)).toEqual([
          'c.broken',
          'c.broken',
        ])
      }),
    )

    const exceptions = tracer.exceptions()
    const traces = tracer.named('c.get').map(data => data.context.traceId)
    expect(exceptions).toHaveLength(2)
    expect(new Set(exceptions.map(log => log.context?.traceId))).toEqual(new Set(traces))
    for (const log of exceptions) {
      expect(log).toMatchObject({ eventName: 'ozaco.action.exception', severityNumber: 17 })
    }
    for (const data of [...tracer.named('c.get'), ...tracer.named('cache c.get')]) {
      expect(data.status.code).toBe('error')
      expect(data.attributes['error.type']).toBe('c.broken')
    }
  })

  it('a mutation evicts on its span; a failed invalidation is logged, never fails the mutation', async () => {
    const tracer = memoryTracer()
    const logger = captureLogger()
    const kv = breakable()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* kv.install()
        yield* DefaultLogger.use({ level: LogLevel.info })
        yield* logger.plugin.use()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        yield* server.call(svc, 'bump')
        kv.broken.on = true
        // the mutation committed: a store outage afterwards does not undo nor fail it
        expect(yield* server.call(svc, 'bump')).toBeUndefined()
      }),
    )

    const [ok, outage] = tracer.named('c.bump')
    expect(ok!.events.map(event => event.name)).toEqual(['ozaco.cache.evict'])
    expect(ok!.events[0]!.attributes).toEqual({ 'ozaco.cache.tags': ['todos'] })

    // the outage: no evict event, the span stays unset, ONE WARN exception on it
    expect(outage!.status.code).toBe('unset')
    expect(outage!.events.map(event => event.name)).toEqual(['exception'])
    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.exceptions()[0]).toMatchObject({
      severityNumber: 13,
      attributes: { 'exception.type': 'test.kv-down' },
    })
    expect(tracer.exceptions()[0]!.context?.spanId).toBe(outage!.context.spanId)

    // ... and ONE Logger line, correlated to the mutation, under the plugin's scope
    const lines = logger.entries.filter(entry => entry.level >= LogLevel.warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      msg: 'cache invalidation failed after the mutation',
      bindings: { logger: '@ozaco/server/cache' },
    })
    expect(lines[0]!.failures[0]?.error).toBe('test.kv-down')
    expect(lines[0]!.trace?.spanId).toBe(outage!.context.spanId)
    const bridged = tracer.logs.find(log => log.body === lines[0]!.msg)!
    expect(bridged.scope.name).toBe('@ozaco/server/cache')
  })

  it('without a Logger the failed invalidation still reaches the sinks (a line + one WARN)', async () => {
    const tracer = memoryTracer()
    const kv = breakable()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* kv.install()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        kv.broken.on = true
        yield* server.call(svc, 'bump')
      }),
    )

    const bump = tracer.named('c.bump')[0]!
    const line = tracer.logs.find(
      log => log.body === 'cache invalidation failed after the mutation',
    )!
    expect(line).toMatchObject({ severityNumber: 13, scope: { name: '@ozaco/server/cache' } })
    expect(line.attributes['ozaco.cache.tags']).toEqual(['todos'])
    expect(line.context?.spanId).toBe(bump.context.spanId)
    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.exceptions()[0]!.severityNumber).toBe(13)
  })

  it("a swallowed failure is recorded whatever the Logger's level lets through", async () => {
    const tracer = memoryTracer()
    const kv = breakable()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* kv.install()
        // the Logger drops WARN lines: the failures themselves must still reach the sinks
        yield* DefaultLogger.use({ level: LogLevel.error })
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        yield* server.start()
        kv.broken.on = true
        yield* server.call(svc, 'bump')
        yield* server.call(svc, 'write', { title: 'b' })
        yield* sleep(30)
        yield* server.stop()
      }),
    )

    // ONE WARN each — the mutation's (on its span) and the change feed's (on its root)
    const bump = tracer.named('c.bump')[0]!
    const invalidation = tracer.named('cache.invalidate todos')[0]!
    expect(
      tracer
        .exceptions()
        .map(log => [log.severityNumber, log.context?.spanId])
        .toSorted(),
    ).toEqual(
      [
        [13, bump.context.spanId],
        [13, invalidation.context.spanId],
      ].toSorted(),
    )
    expect(invalidation.status.code).toBe('error')
  })

  it('a change-feed invalidation is an errors-only root linking the writer', async () => {
    const tracer = memoryTracer()
    const logger = captureLogger()
    const kv = breakable()
    const { svc } = make()

    unwrap(
      await run(function* () {
        yield* storage()
        yield* kv.install()
        yield* DefaultLogger.use({ level: LogLevel.info })
        yield* logger.plugin.use()
        yield* tracer.plugin.use()
        const server = yield* createServer({ services: [svc], plugins: [Cache] })
        yield* server.start()

        // a healthy invalidation leaves nothing behind
        yield* server.call(svc, 'write', { title: 'a' })
        yield* sleep(30)
        expect(tracer.named('cache.invalidate todos')).toHaveLength(0)

        // a failing one is exported, linked to the write that caused it, and logged
        kv.broken.on = true
        yield* server.call(svc, 'write', { title: 'b' })
        yield* sleep(30)
        yield* server.stop()
      }),
    )

    const writes = tracer.named('c.write')
    const invalidations = tracer.named('cache.invalidate todos')
    expect(invalidations).toHaveLength(1)
    const invalidation = invalidations[0]!
    expect(invalidation).toMatchObject({
      kind: 'internal',
      parent: null,
      scope: { name: '@ozaco/server/cache' },
      status: { code: 'error' },
    })
    expect(invalidation.attributes).toMatchObject({
      'ozaco.cache.tags': ['todos'],
      'ozaco.cache.store': 'memory',
      'error.type': 'test.kv-down',
    })
    expect(invalidation.context.traceId).not.toBe(writes[1]!.context.traceId)
    expect(invalidation.links).toHaveLength(1)
    expect(invalidation.links[0]!.context.spanId).toBe(writes[1]!.context.spanId)
    expect(invalidation.links[0]!.attributes).toEqual({ 'ozaco.link.reason': 'change.writer' })

    // ONE record of the failure (WARN, the Logger line's), correlated to the invalidation
    expect(tracer.exceptions()).toHaveLength(1)
    expect(tracer.exceptions()[0]!.context?.spanId).toBe(invalidation.context.spanId)
    const lines = logger.entries.filter(entry => entry.level >= LogLevel.warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.msg).toBe('cache invalidation of todos failed')
    expect(lines[0]!.trace?.traceId).toBe(invalidation.context.traceId)
  })
})
