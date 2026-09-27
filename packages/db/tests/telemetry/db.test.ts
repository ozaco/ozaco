/**
 * db CLIENT spans (`traced(adapter)`): child-only, named `{op} {table}`, the backend's identity,
 * parameterized query text, the driver's status code on a failure — and never a span for the
 * change logs or a background re-query.
 */
import type { Database } from 'db:core'
import { column, Db, DbClient, DbErrors, defineSchema, table } from 'db:core'
import { untraced } from 'db:internal'
import type { Operation } from 'std:effect'
import { attempt, fork, run, sleep } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { span } from 'std:trace'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryAdapter } from 'db:impl/memory'
import { PgAdapter } from 'db:impl/pg'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'

import pkg from '../../package.json'

import { traced, tracedResult } from './helpers'

const todos = table('todos', { title: column.text(), done: column.boolean().default(false) })
const accounts = table('accounts', { email: column.text() }).unique('by_email', ['email'])
const schema = defineSchema({ todos, accounts })

const scope = { name: '@ozaco/db', version: pkg.version }

function* memoryDb(options: Partial<Database.Options> = {}) {
  yield* BunIO.use()
  yield* MemoryAdapter.use()
  return (yield* DbClient.use({ schema, ...options })) as AnyType
}

function* sqliteDb(options: Partial<Database.Options> = {}) {
  yield* BunIO.use()
  yield* SqliteAdapter.use({ path: join(mkdtempSync(join(tmpdir(), 'ozaco-db-trace-')), 'app.db') })
  return (yield* DbClient.use({ schema, ...options })) as AnyType
}

/** A recording parent span around `body`. */
const request = <T>(body: () => Operation<T>): Operation<T> => span('request', () => body())

describe('db spans — child-only', () => {
  it('no recording parent ⇒ no span at all; under one ⇒ `{op} {table}` children', async () => {
    const { tracer } = await traced(function* (live) {
      const db = yield* memoryDb()
      yield* db.insert('todos', { title: 'untraced' })
      yield* db.query('todos').collect()
      expect(live.spans).toEqual([])

      yield* request(function* () {
        yield* db.insert('todos', { title: 'traced' })
        yield* db.query('todos').count()
        yield* db.query('todos').collect()
      })
    })

    // the change-log writes (`__changes_todos`) never show up
    expect(tracer.names()).toEqual(['insert todos', 'count todos', 'find todos', 'request'])
    const root = tracer.span('request')
    for (const name of ['insert todos', 'count todos', 'find todos']) {
      expect(tracer.span(name).parent?.spanId).toBe(root.context.spanId)
    }
  })

  it('memory adapter: INTERNAL spans, system ozaco.memory, namespace memory, no query text', async () => {
    const { tracer } = await traced(function* () {
      const db = yield* memoryDb()
      yield* request(() => db.insert('todos', { title: 'a' }))
    })

    const insert = tracer.span('insert todos')
    expect(insert.kind).toBe('internal')
    expect(insert.scope).toEqual(scope)
    expect(insert.attributes).toEqual({
      'db.system.name': 'ozaco.memory',
      'db.namespace': 'memory',
      'db.collection.name': 'todos',
      'db.operation.name': 'insert',
    })
    expect(insert.status).toEqual({ code: 'unset' })
  })

  it('sqlite: CLIENT spans with the file basename, parameterized query text and batch size', async () => {
    const { tracer } = await traced(function* () {
      const db = yield* sqliteDb()
      yield* request(function* () {
        yield* db.insertMany('todos', [
          { title: 'secret-1' },
          { title: 'secret-2' },
          { title: 'secret-3' },
        ])
        yield* db.query('todos').filter({ title: 'secret-1' }).collect()
        yield* db.delete('todos', 'missing')
      })
    })

    const insert = tracer.span('insert todos')
    expect(insert.kind).toBe('client')
    expect(insert.attributes).toMatchObject({
      'db.system.name': 'sqlite',
      'db.namespace': 'app.db',
      'db.collection.name': 'todos',
      'db.operation.name': 'insert',
      'db.operation.batch.size': 3,
    })
    const text = String(insert.attributes['db.query.text'])
    expect(text).toStartWith('INSERT INTO')
    expect(text).toContain('?')
    expect(text).not.toContain('secret')

    const find = tracer.span('find todos')
    expect(String(find.attributes['db.query.text'])).toStartWith('SELECT')
    expect(String(find.attributes['db.query.text'])).not.toContain('secret')
    expect(find.attributes['db.operation.batch.size']).toBeUndefined()
    // returned rows are an opt-in
    expect(find.attributes['db.response.returned_rows']).toBeUndefined()

    expect(tracer.span('delete todos').attributes['db.operation.name']).toBe('delete')
    expect(tracer.names().some(name => name.includes('__changes_'))).toBe(false)
  })

  it('observe.returnedRows stamps db.response.returned_rows', async () => {
    const { tracer } = await traced(function* () {
      const db = yield* memoryDb({ observe: { returnedRows: true } })
      yield* db.insertMany('todos', [{ title: 'a' }, { title: 'b' }])
      yield* request(() => db.query('todos').collect())
    })

    expect(tracer.span('find todos').attributes['db.response.returned_rows']).toBe(2)
  })

  it('a transaction is a `transaction` span over its statements', async () => {
    const { tracer } = await traced(function* () {
      const db = yield* sqliteDb()
      yield* request(() =>
        db.transaction(function* (tx: AnyType) {
          yield* tx.insert('todos', { title: 'in tx' })
        }),
      )
    })

    const tx = tracer.span('transaction')
    expect(tx.kind).toBe('client')
    expect(tx.attributes).toMatchObject({
      'db.system.name': 'sqlite',
      'db.operation.name': 'transaction',
    })
    // BEGIN / COMMIT are not the span's text; the statements have their own spans
    expect(tx.attributes['db.query.text']).toBeUndefined()
    expect(tracer.span('insert todos').parent?.spanId).toBe(tx.context.spanId)
    expect(tx.parent?.spanId).toBe(tracer.span('request').context.spanId)
  })

  it('a conflict retry: `ozaco.db.tx.retry` on the caller, the failed attempt handled (WARN)', async () => {
    const { tracer } = await traced(function* () {
      const db = yield* memoryDb()
      let attempts = 0
      yield* request(() =>
        db.transaction(function* (tx: AnyType) {
          attempts += 1
          yield* tx.insert('todos', { title: `attempt ${attempts}` })
          if (attempts === 1) {
            return yield* fail(DbErrors.Conflict, 'serialization failure')
          }
        }),
      )
    })

    const root = tracer.span('request')
    expect(root.events.map(event => [event.name, event.attributes])).toEqual([
      ['ozaco.db.tx.retry', { 'ozaco.db.transaction.attempt': 2 }],
    ])

    // the failed attempt's span is held until its failure settles (the request ended): it is
    // exported after the successful one
    const [succeeded, failed] = tracer.all('transaction')
    expect(succeeded!.attributes['error.type']).toBeUndefined()
    expect(failed!.attributes['error.type']).toBe(DbErrors.Conflict)
    // handled by the retry: `error.type` only, the status stays unset
    expect(failed!.status.code).toBe('unset')

    const [exception] = tracer.exceptions()
    expect(tracer.exceptions()).toHaveLength(1)
    expect(exception!.eventName).toBe('db.client.operation.exception')
    expect(exception!.severityNumber).toBe(13)
    expect(exception!.context?.spanId).toBe(failed!.context.spanId)
  })

  it('a constraint failure: error.type, the SQLite code as status code, the driver error as raw', async () => {
    const { tracer, result } = await tracedResult(function* () {
      const db = yield* sqliteDb()
      yield* db.insert('accounts', { email: 'ada@example.com' })
      yield* request(() => db.insert('accounts', { email: 'ada@example.com' }))
    })

    expect(isFailure(result)).toBe(true)
    const failure = result as AnyType
    expect(failure.error).toBe(DbErrors.Unique)
    // the SQLiteError is the failure's `raw` (one level, its text the message); its code rides
    // the `sqlite <code>` cause the span reads, the plugin runtime's labels after it (the
    // adapter's action and impl, then the dispatch and the protocol)
    expect(failure.causes.filter(isFailure)).toHaveLength(0)
    expect(failure.raw).toBeInstanceOf(Error)
    expect(failure.raw.code).toStartWith('SQLITE_CONSTRAINT')
    expect(failure.message).toBe(failure.raw.message)
    expect(failure.causes).toEqual([
      `sqlite ${failure.raw.code}`,
      'insert',
      `sqlite@${pkg.version}`,
      'dispatch',
      `db-adapter@${pkg.version}`,
    ])

    const insert = tracer.span('insert accounts')
    expect(insert.status.code).toBe('error')
    expect(insert.attributes['error.type']).toBe(DbErrors.Unique)
    // the status cause's code exactly — a label (`sqlite@<version>`) is never read as one
    expect(insert.attributes['db.response.status_code']).toBe(failure.raw.code)
    expect(insert.events.map(event => event.name)).toEqual(['exception'])

    const [exception] = tracer.exceptions()
    expect(tracer.exceptions()).toHaveLength(1)
    expect(exception!.eventName).toBe('db.client.operation.exception')
    expect(exception!.severityNumber).toBe(17)
  })

  it('raw: `raw` spans; only a parameterized statement is recorded as text', async () => {
    const { tracer } = await traced(function* () {
      yield* sqliteDb()
      yield* request(function* () {
        yield* Db.actions.raw('SELECT title FROM todos WHERE title = ?', ['x'], { table: 'todos' })
        yield* Db.actions.raw("SELECT 'literal'")
      })
    })

    const [bound, bare] = tracer.all('raw')
    expect(bound!.attributes).toMatchObject({
      'db.operation.name': 'raw',
      'db.query.text': 'SELECT title FROM todos WHERE title = ?',
    })
    // the decode table is not necessarily the statement's target: no collection
    expect(bound!.attributes['db.collection.name']).toBeUndefined()
    expect(bare!.attributes['db.query.text']).toBeUndefined()
  })

  it('a watch: the first read is the subscriber’s, live re-queries run with no span', async () => {
    const { tracer } = await traced(function* () {
      const db = yield* memoryDb()
      yield* span('session', function* () {
        const live = yield* db.query('todos').watch()
        const first = yield* live.next()
        expect(first.value.rows).toHaveLength(0)

        // a writer outside any span; the watch recomputes twice under the long-lived session
        yield* fork(() =>
          untraced(function* () {
            yield* sleep(5)
            yield* db.insert('todos', { title: 'one' })
            yield* sleep(5)
            yield* db.insert('todos', { title: 'two' })
          }),
        )
        expect((yield* live.next()).value.rows).toHaveLength(1)
        expect((yield* live.next()).value.rows).toHaveLength(2)
      })
    })

    expect(tracer.names()).toEqual(['find todos', 'session'])
  })

  it('no tracer installed: the handle works exactly as before', async () => {
    const outcome = await run(function* () {
      const db = yield* memoryDb()
      yield* request(() => db.insert('todos', { title: 'a' }))
      return yield* db.query('todos').count()
    })

    expect(unwrap(outcome)).toBe(1)
  })
})

/** Set DB_TEST_PG_URL to check the Postgres identity and the SQLSTATE status code. */
const url = process.env.DB_TEST_PG_URL

describe.skipIf(!url)('db spans — postgres', () => {
  it('namespace = the database, server address/port, SQLSTATE status code', async () => {
    const parsed = new URL(url ?? 'postgres://localhost/x')
    const { tracer } = await tracedResult(function* () {
      yield* BunIO.use()
      yield* PgAdapter.use({ url: url! })
      const db = (yield* DbClient.use({ schema, migrations: 'manual' })) as AnyType
      yield* Db.actions.dropTable('accounts')
      yield* Db.actions.migrate()
      yield* db.insert('accounts', { email: 'ada@example.com' })
      yield* attempt(request(() => db.insert('accounts', { email: 'ada@example.com' })))
    })

    const insert = tracer.span('insert accounts')
    expect(insert.kind).toBe('client')
    expect(insert.attributes).toMatchObject({
      'db.system.name': 'postgresql',
      'db.namespace': decodeURIComponent(parsed.pathname.slice(1)),
      'server.address': parsed.hostname,
      'server.port': Number(parsed.port || 5432),
      'db.response.status_code': '23505',
      'error.type': DbErrors.Unique,
    })
    expect(String(insert.attributes['db.query.text'])).toContain('$1')
  })
})
