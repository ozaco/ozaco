import { createMemoryBus, Db, DbClient } from 'db:core'
import { run, scoped } from 'std:effect'
import type { Operation } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'

import { runScoped, users } from './helpers'

describe('change bus', () => {
  it('memory bus fans every publish out to every endpoint (echoes included)', async () => {
    await runScoped(function* () {
      const bus = createMemoryBus()
      const a = bus.endpoint('node-a')
      const b = bus.endpoint('node-b')
      const feed = yield* b.events
      yield* a.publish([
        { table: 'users', id: '1', op: 'insert', version: 1, origin: 'node-a' },
        { table: 'users', id: '2', op: 'insert', version: 2, origin: 'node-a' },
      ])
      const first = yield* feed.next()
      const second = yield* feed.next()
      expect((first.value as AnyType).id).toBe('1')
      expect((second.value as AnyType).origin).toBe('node-a')
    })
  })

  it('two nodes over a shared sqlite file: writes on one wake watchers on the other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-db-bus-'))
    const path = join(dir, 'shared.sqlite')
    const bus = createMemoryBus()

    let release: () => void = () => {}
    const nodeBReady = new Promise<void>(resolve => {
      release = resolve
    })

    const nodeOf = function* (origin: string): Operation<AnyType> {
      yield* install(SqliteAdapter, { path })
      const db = yield* install(DbClient, { tables: [users], bus: bus.endpoint(origin) })
      return db
    }

    try {
      const nodeB = run(() =>
        scoped(function* () {
          const db = yield* nodeOf('node-b')
          const feed = yield* db.changes('users')
          const snaps = yield* db.query('users').watch()
          yield* snaps.next()
          release()

          // the foreign write arrives as an INVALIDATION (no doc) and the re-read sees the row
          const event = yield* feed.next()
          expect(event.value).toMatchObject({ op: 'insert', source: 'bus', doc: null })
          const snap = yield* snaps.next()
          return (snap.value as AnyType).rows.map((row: AnyType) => row.name)
        }),
      )

      await nodeBReady
      const writer = run(() =>
        scoped(function* () {
          const db = yield* nodeOf('node-a')
          expect(yield* Db.actions.hasBus()).toBe(true)
          yield* db.insert('users', { name: 'remote-ada' })
        }),
      )
      unwrap(await writer)

      const names = unwrap(await nodeB)
      expect(names).toEqual(['remote-ada'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
