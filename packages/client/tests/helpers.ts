// oxlint-disable import/exports-last
import { column, DbClient, table, useDb } from 'db:core'
import { Broker, DefaultBroker, DefaultGateway, Gateway, useRequest } from 'server:core'
import { crud, installWizard, mutation, query, resource, wizard } from 'server:wizard'
import { operation } from 'std:effect'
import { FetchClient } from 'std:fetch'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { Ws } from 'std:ws'

import { MemoryAdapter } from 'db:impl/memory'
import { BunGatewayAdapter } from 'server:gateway/bun'
import { Docs } from 'server:plugin/docs'
import { BunIO } from 'std:io/impl/bun'
import { z } from 'zod'

/** The fixture table the client suites run against. */
export const tasks = table('tasks', {
  title: column.text(),
  done: column.boolean().default(false),
  priority: column.int().default(0),
})

/** Access guard: any bearer suffices — the fixture asserts token PLUMBING, not verification. */
const authedOnly = operation(function* () {
  const request = yield* useRequest()

  return typeof request.meta['authorization'] === 'string'
})

/** Realtime-watchable custom query — `sync` frames carry `rows: [value]`. */
const stats = query({
  watch: true,
  *handler() {
    const db = yield* useDb(tasks)
    const total = yield* db.query('tasks').count()
    const done = yield* db.query('tasks').where({ done: true }).count()

    return { total, done }
  },
})

/** Guarded mutation: 403 without an authorization header, marks everything done with one. */
const finishAll = mutation({
  args: z.object({ note: z.string().optional() }),
  access: authedOnly,
  *handler(args) {
    const db = yield* useDb(tasks)
    const page = yield* db.query('tasks').where({ done: false }).paginate({ limit: 100 })

    for (const doc of page.data) {
      yield* db.patch('tasks', doc._id, { done: true })
    }

    return { finished: page.data.length, note: args.note ?? null }
  },
})

export const tasksResource = resource(tasks, {
  ...crud(tasks, { filters: ['done'], pageSize: 5, maxPageSize: 10 }),
  stats,
  finishAll,
})

export const api = wizard({ tasks: tasksResource })

export type Api = typeof api

/** Broker + memory db + bun gateway + wizard + docs, started on a random port. */
export const bootServer = operation(function* () {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker)
  yield* Broker.actions.start()
  yield* install(MemoryAdapter)
  yield* install(DbClient, { tables: [tasks] })
  yield* install(BunGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw' })
  yield* installWizard(api)
  yield* install(Docs, { title: 'Client Fixture API', version: '1.0.0', auth: true })
  yield* Docs.actions.from({ prefix: '/tasks', service: tasksResource.$wizard.service })
  yield* Docs.actions.mount()

  return yield* Gateway.actions.start({ port: 0 })
})

/** What `createClient` requires in scope — FetchClient + Ws + JsonCodec. The codec is already
 * registered by the server fixture in this scope (`DefaultBroker` installs it as the baseline),
 * so installing it again here would fail with 'codec already registered'. */
export const bootClientEnv = operation(function* () {
  yield* install(FetchClient)
  yield* install(Ws)
})

/** Reject a hanging promise instead of letting a broken watch stall the whole suite. */
export const withTimeout = <T>(promise: Promise<T>, ms = 4000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined

  const guard = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`))
    }, ms)
  })

  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(timer)
  })
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

/** A promise plus its resolver — the bridge from watch callbacks into awaited assertions. */
export const deferred = <T>(): Deferred<T> => {
  let settle: (value: T) => void = () => {}

  const promise = new Promise<T>(resolve => {
    settle = resolve
  })

  return { promise, resolve: settle }
}
