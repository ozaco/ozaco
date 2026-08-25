import { DbClient, column, table } from 'db:core'
import { run, sleep, until } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

import { runAdapterSuite } from './helpers'

runAdapterSuite({
  label: 'sqlite',
  enabled: true,
  raw: true,
  install: () => install(SqliteAdapter),
})

describe('sqlite — concurrent connections', () => {
  it('writes WAIT for a competing connection (WAL + busy_timeout) instead of failing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ozaco-sqlite-')), 'busy.sqlite')
    const todos = table('todos', { title: column.text() })

    unwrap(
      await run(function* () {
        yield* install(BunIO)
        yield* install(SqliteAdapter, { path, busyTimeoutMs: 3000 })
        yield* install(DbClient, { tables: [todos] })
        const db = (yield* DbClient.context.expect()) as AnyType

        // the adapter flipped the FILE to WAL — readers can't block this writer any more
        const probe = new Database(path)
        const mode = probe.query('PRAGMA journal_mode').get() as AnyType
        expect(String(mode?.journal_mode ?? mode)).toBe('wal')

        probe.close()

        // an EXTERNAL PROCESS takes the write lock and sits on it for 400ms (a separate
        // process, because bun:sqlite's busy wait blocks THIS event loop while it waits)
        const script = `
          const { Database } = require('bun:sqlite')
          const db = new Database(${JSON.stringify(path)})
          db.exec('PRAGMA busy_timeout = 0')
          db.exec('BEGIN IMMEDIATE')
          db.exec("INSERT INTO todos (_id, _created_at, _updated_at, _version, title) VALUES ('x', 0, 0, '0', 'held')")
          await Bun.sleep(400)
          db.exec('COMMIT')
          db.close()
        `
        const child = Bun.spawn(['bun', '-e', script])
        yield* sleep(150)

        // our write does NOT fail — it waits out the other process's lock and lands
        const made = yield* db.insert('todos', { title: 'waited' })
        expect(made.title).toBe('waited')
        yield* until(child.exited)

        yield* sleep(50)
        const rows = yield* db.query('todos').collect()
        expect(rows.map((row: AnyType) => row.title).toSorted()).toEqual(['held', 'waited'])
      }),
    )
  }, 15_000)
})
