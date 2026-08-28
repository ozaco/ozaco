import { DbAdapter, DbClient, DbErrors } from 'db:core'
import { tableSpecOf } from 'db:internal'
import { attempt, run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

import { users } from './helpers'

describe('plugin lifecycle', () => {
  it('DbClient without an adapter fails db.configuration', async () => {
    unwrap(
      await run(function* () {
        yield* install(BunIO)
        const outcome = yield* attempt(install(DbClient, { tables: [users] }))
        expect(isFailure(outcome)).toBe(true)
        expect((outcome as AnyType).error).toBe(DbErrors.Configuration)
      }),
    )
  })

  it('adapters are cloneable: routed dispatch targets the LAST install, `adapter` pins one', async () => {
    unwrap(
      await run(function* () {
        yield* install(MemoryAdapter)
        yield* install(SqliteAdapter)
        // the routed protocol dispatch resolves the most recently installed adapter
        expect((yield* DbAdapter.actions.describe()).adapter).toBe('sqlite')
        // a pinned handle always targets its own impl, whatever was installed after it
        expect((yield* MemoryAdapter.actions.describe()).adapter).toBe('memory')

        yield* install(BunIO)
        const routed = yield* install(DbClient, { tables: [users] })
        const routedInfo = yield* DbAdapter.actions.describe()
        expect(routedInfo.capabilities.raw).toBe(true)
        yield* routed.insert('users', { name: 'ada' })
        expect(yield* routed.query('users').count()).toBe(1)
        // the row went to sqlite, not memory
        expect(yield* MemoryAdapter.actions.introspect(tableSpecOf(users))).toBeNull()

        yield* install(BunIO)
        const pinned = yield* install(DbClient, { tables: [users], adapter: MemoryAdapter })
        yield* pinned.insert('users', { name: 'grace' })
        const stored = yield* MemoryAdapter.actions.find({
          table: tableSpecOf(users),
          filter: null,
          order: [],
          limit: null,
          offset: null,
        })
        expect(stored.map(row => row.name)).toEqual(['grace'])
      }),
    )
  })

  it('sqlite closes its handle with the scope — the file reopens cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozaco-db-'))
    const path = join(dir, 'lifecycle.sqlite')
    try {
      unwrap(
        await run(() =>
          scoped(function* () {
            yield* install(SqliteAdapter, { path })
            yield* install(BunIO)
            const db = yield* install(DbClient, { tables: [users] })
            yield* db.insert('users', { name: 'persisted' })
          }),
        ),
      )
      unwrap(
        await run(() =>
          scoped(function* () {
            yield* install(SqliteAdapter, { path })
            yield* install(BunIO)
            const db = yield* install(DbClient, { tables: [users] })
            const row = yield* db.query('users').first()
            expect((row as AnyType).name).toBe('persisted')
          }),
        ),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failed transaction body does not wedge later scope teardown', async () => {
    const task = run(() =>
      scoped(function* () {
        yield* install(SqliteAdapter)
        yield* install(BunIO)
        const db = yield* install(DbClient, { tables: [users] })
        yield* attempt(
          db.transaction(function* (tx: AnyType) {
            yield* tx.insert('users', { name: 'doomed' })
            throw new Error('boom')
          }),
        )
        yield* db.insert('users', { name: 'after' })
        return 'closed'
      }),
    )
    const winner = await Promise.race([
      task.then(() => 'completed'),
      new Promise(resolve => {
        setTimeout(() => resolve('timeout'), 3000)
      }),
    ])
    expect(winner).toBe('completed')
  })

  it('the full reactive stack lets the process exit naturally (graceful shutdown)', async () => {
    const fixture = join(import.meta.dir, 'fixtures', 'shutdown.ts')
    const proc = Bun.spawn([process.execPath, fixture], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const killer = setTimeout(() => {
      proc.kill()
    }, 8000)
    const exitCode = await proc.exited
    clearTimeout(killer)
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toBe('')
    expect(stdout).toContain('memory-done')
    expect(stdout).toContain('sqlite-done')
    expect(stdout.trim().endsWith('all-done')).toBe(true)
    expect(exitCode).toBe(0)
  }, 10_000)
})
