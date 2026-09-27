/**
 * Kv spans: every op of a store is a child-only `{op} kv` span with the BACKING store's identity;
 * the adapter calls a store makes open no db spans, and a `wrap` miss computes under the caller.
 */
import type { KvDef } from 'db:core'
import { column, DbClient, defineSchema, Kv, table, useDb } from 'db:core'
import { kvActions } from 'db:internal'
import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'
import { span } from 'std:trace'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { SqliteAdapter } from 'db:impl/sqlite'
import { TableKv } from 'db:impl/table-kv'
import { BunIO } from 'std:io/impl/bun'

import pkg from '../../package.json'

import { traced } from './helpers'

const request = <T>(body: () => Operation<T>): Operation<T> => span('request', () => body())

describe('kv spans', () => {
  it('memory store: INTERNAL `{op} kv` spans only under a recording parent', async () => {
    const { tracer } = await traced(function* (live) {
      yield* MemoryKv.use({ prefix: 'cache' })
      yield* Kv.actions.set('outside', 1)
      expect(live.spans).toEqual([])

      yield* request(function* () {
        yield* Kv.actions.set('a', 1)
        yield* Kv.actions.get('a')
        yield* Kv.actions.mget(['a', 'b', 'c'])
        yield* Kv.actions.incr('n')
      })
    })

    expect(tracer.names()).toEqual(['set kv', 'get kv', 'mget kv', 'incr kv', 'request'])
    const get = tracer.span('get kv')
    expect(get.kind).toBe('internal')
    expect(get.scope).toEqual({ name: '@ozaco/db', version: pkg.version })
    expect(get.attributes).toEqual({
      'db.system.name': 'ozaco.memory',
      'db.namespace': 'memory',
      'db.collection.name': 'cache',
      'db.operation.name': 'get',
    })
    expect(tracer.span('mget kv').attributes['db.operation.batch.size']).toBe(3)
  })

  it('table store: CLIENT spans with the backing database identity, no db spans under them', async () => {
    const { tracer } = await traced(function* () {
      yield* BunIO.use()
      yield* SqliteAdapter.use({
        path: join(mkdtempSync(join(tmpdir(), 'ozaco-kv-trace-')), 'kv.db'),
      })
      yield* TableKv.use({ prefix: 'app', table: 'cache' })
      yield* request(function* () {
        yield* Kv.actions.set('greeting', 'hello', { tags: ['t'] })
        yield* Kv.actions.invalidate('t')
      })
    })

    expect(tracer.names()).toEqual(['set kv', 'invalidate kv', 'request'])
    expect(tracer.span('set kv').kind).toBe('client')
    expect(tracer.span('set kv').attributes).toEqual({
      'db.system.name': 'sqlite',
      'db.namespace': 'kv.db',
      'db.collection.name': 'cache',
      'db.operation.name': 'set',
    })
  })

  it('a store over a traced DbClient: its adapter calls open no db spans under the kv span', async () => {
    const notes = table('notes', { body: column.text() })

    // a store whose driver reads through the application's DbClient (traced adapter)
    const driver: KvDef.Driver = {
      capabilities: { persistent: false, atomic: false, scan: false },
      *get() {
        const db = (yield* useDb()) as AnyType
        yield* db.query('notes').collect()
        return null
      },
      *set() {},
      *del() {
        return 0
      },
      *has() {
        return false
      },
      *ttl() {
        return null
      },
      *expire() {
        return false
      },
      *incr() {
        return 0
      },
      *keys() {
        return { keys: [], cursor: null }
      },
      *invalidate() {
        return 0
      },
      *clear() {
        return 0
      },
    }
    const DbBackedKv = Kv.implement<KvDef.Options, []>({
      name: 'kv-db-backed',
      version: '1.0.0',
      *setup() {
        return { store: 'db-backed', prefix: 'x', capabilities: driver.capabilities }
      },
    }).build(kvActions(driver))

    const { tracer } = await traced(function* () {
      yield* BunIO.use()
      yield* MemoryAdapter.use()
      const db = (yield* DbClient.use({ schema: defineSchema({ notes }) })) as AnyType
      yield* DbBackedKv.use()
      yield* request(function* () {
        yield* Kv.actions.get('k')
        yield* db.query('notes').collect()
      })
    })

    // the kv span's own find is suppressed; the handler's find (outside the kv span) is traced
    expect(tracer.names()).toEqual(['get kv', 'find notes', 'request'])
    // no telemetry of its own: the store name stands in
    expect(tracer.span('get kv').attributes).toMatchObject({
      'db.system.name': 'db-backed',
      'db.namespace': 'db-backed',
      'db.collection.name': 'x',
    })
    expect(tracer.span('get kv').kind).toBe('client')
  })

  it('wrap: its get and set are spans, a miss computes under the CALLER’s span', async () => {
    const notes = table('notes', { body: column.text() })

    const { tracer } = await traced(function* () {
      yield* BunIO.use()
      yield* MemoryAdapter.use()
      const db = (yield* DbClient.use({ schema: defineSchema({ notes }) })) as AnyType
      yield* MemoryKv.use({ prefix: 'cache' })
      yield* request(() =>
        Kv.actions.wrap('all-notes', { ttlMs: 1000 }, () => db.query('notes').collect()),
      )
    })

    expect(tracer.names()).toEqual(['get kv', 'find notes', 'set kv', 'request'])
    const root = tracer.span('request').context.spanId
    for (const name of ['get kv', 'find notes', 'set kv']) {
      expect(tracer.span(name).parent?.spanId).toBe(root)
    }
  })
})
