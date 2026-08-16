import { DbClient } from 'db:core'
import { bridgeChangeBus } from 'server:wizard'
import { fork, scoped, until } from 'std:effect'
import { install } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

import { tasks } from './helpers'

describe('wizard change-bus bridge', () => {
  it('no-ops (false) when broker/db are not installed', async () => {
    const result = await runScoped(function* () {
      return yield* bridgeChangeBus()
    })

    expect(result).toBe(false)
  })

  it('two db nodes over one broker: a write on A wakes the watchers on B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-wizard-bus-'))
    const path = join(dir, 'shared.sqlite')

    try {
      const result = await runScoped(function* () {
        yield* bootstrap()

        let release: () => void = () => {}
        const ready = new Promise<void>(resolve => {
          release = resolve
        })

        const nodeB = yield* fork(() =>
          scoped(function* () {
            yield* install(SqliteAdapter, { path })

            const db = yield* install(DbClient, { tables: [tasks] })

            expect(yield* bridgeChangeBus()).toBe(true)
            // idempotent — a bus is already attached
            expect(yield* bridgeChangeBus()).toBe(false)

            const feed = yield* db.changes('tasks')
            const snaps = yield* db.query('tasks').watch()

            yield* snaps.next()

            release()

            // the foreign write arrives as an INVALIDATION (no doc); the re-read sees the row
            const event = yield* feed.next()
            const snap = yield* snaps.next()

            return {
              event: event.value as AnyType,
              titles: (snap.value as AnyType).rows.map((row: AnyType) => row.title),
            }
          }),
        )

        yield* until(ready)

        yield* scoped(function* () {
          yield* install(SqliteAdapter, { path })

          const db = yield* install(DbClient, { tables: [tasks] })

          expect(yield* bridgeChangeBus()).toBe(true)

          yield* db.insert('tasks', { title: 'cross-node' })
        })

        return yield* nodeB
      })

      expect(result.event).toMatchObject({
        table: 'tasks',
        op: 'insert',
        source: 'bus',
        doc: null,
      })
      expect(result.titles).toEqual(['cross-node'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
