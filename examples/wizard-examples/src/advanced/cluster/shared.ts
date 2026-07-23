import { Pool, sql, usePool } from 'db:core'
import { RealtimeDb, table } from 'db:realtime'
import { Broker, DefaultBroker, Gateway } from 'server:core'
import { resource } from 'server:wizard'
import { attempt, ensure, operation } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { BunGateway } from 'server:gateway/bun'
import { NatsTransport } from 'server:transport/nats'
import { BunIO } from 'std:io/impl/bun'
import { ConsoleTransport } from 'std:logger/transport/console'
import { z } from 'zod'

/** One collection, deployed identically on every node of the cluster. */
export const notes = table('notes', { title: z.string(), done: z.boolean().default(false) })
export const noteResource = resource(notes, { type: 'crud' })

export interface NodeOptions {
  /** Unique per process — see the comment in {@link startNode}. */
  readonly nodeId: string
  readonly port: number
  /** Path to the SHARED SQLite file every node opens (so a re-run query sees the other node's writes). */
  readonly database: string
  readonly nats: string
}

/**
 * Bring up one cluster node: a broker (with a UNIQUE `nodeId`), a gateway, a NATS transport, a pool
 * over the SHARED database, and the notes resource.
 *
 * Cross-node reactive fan-out turns on **automatically** — there is no bus to construct or pass.
 * Installing `NatsTransport` alongside a realtime resource is enough: when the resource mounts its
 * realtime channel, the wizard attaches a Broker-backed change bus, and the bus rides whatever
 * transport is installed (NATS here). Drop the `NatsTransport` install and the exact same code is a
 * correct single-node app — the change signal simply stays in-process.
 */
export const startNode = operation(function* (options: NodeOptions) {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.info })
  yield* install(ConsoleTransport)
  // A UNIQUE nodeId per process: it becomes each committed write's `origin`. A node forwards OTHER
  // nodes' writes to its watchers and drops the echo of its own — give two nodes the SAME id and each
  // would mistake the other's writes for its own echo and ignore them.
  yield* install(DefaultBroker, { nodeId: options.nodeId })
  yield* install(NatsTransport, { servers: options.nats })
  yield* install(BunGateway, {})
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: `file:${options.database}` })
  // The shared SQLite file is opened by every node at once. busy_timeout (wait, don't instantly
  // throw) + WAL (readers never block the single writer) so a watcher's list query and the writer's
  // inserts don't collide with "database is locked". In production the shared store is Postgres.
  const pool = yield* usePool()
  yield* pool.query(sql`PRAGMA busy_timeout = 5000`)
  yield* attempt(pool.query(sql`PRAGMA journal_mode = WAL`))
  yield* install(RealtimeDb, { tables: [notes] })
  yield* install(noteResource)
  yield* Broker.actions.start()
  yield* Gateway.actions.start({ port: options.port, host: '127.0.0.1' })
  // Graceful shutdown: on SIGINT/SIGTERM `main` unwinds this scope. `Bun.serve` has no teardown
  // finalizer of its own, so stop the gateway here — that halts the socket pumps, closes live WS
  // connections, and stops the server, letting the process exit on a single Ctrl-C. (The NATS
  // transport closes its own connection the same way.)
  yield* ensure(function* () {
    // `drainMs: 0` → stop the server immediately instead of waiting out the graceful drain window.
    // On SIGINT we want a hard stop: sockets + in-flight are already terminated, and the local watch
    // client would otherwise keep reconnecting and hold the graceful drain open.
    yield* Broker.actions.destroy()
    yield* Gateway.actions.destroy({ drainMs: 0 })
  })
})
