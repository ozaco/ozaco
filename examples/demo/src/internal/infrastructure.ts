import { DefaultPalette } from 'cli:palette'
import { TerminalTracer } from 'cli:trace'
/**
 * Install logging → transport → change bus → storage → queue — fixed to the zero-dependency
 * picks: the std Logger (console lines that are ALSO log records of the active span, in every
 * telemetry sink), memory transport (a shared `link` makes several in-process nodes one
 * cluster), sqlite (a shared `dbPath` makes one database for the cluster), the kv AS ROWS of that
 * sqlite (`TableKv`: cache entries and rate-limit counters survive a restart and, on a shared
 * file, are one store for the whole cluster — no redis), and the job queue as rows of it too
 * (`@ozaco/db/queue`). The bus rides the same transport the carrier does, so every node sees
 * every change (cache invalidation, realtime watches, queue wake-ups) when they share a database.
 */
import { DbBus, DbClient } from 'db:core'
import { Queue } from 'db:queue'
import type { Operation } from 'std:effect'
import { Logger } from 'std:logger'
import { Trace } from 'std:trace'

import { NodeTerminal } from 'cli:impl/node'
import { SqliteAdapter } from 'db:impl/sqlite'
import { TableKv } from 'db:impl/table-kv'
import { BunIO } from 'std:io/impl/bun'
import { DefaultLogger } from 'std:logger/impl/default'
import { ConsoleTransport } from 'std:logger/transport/console'
import { TraceTransport } from 'std:logger/transport/trace'
import { MemoryTransport } from 'transport:impl/memory'

import { TRANSPORT_PREFIX } from '../const'
import type { DemoOptions } from '../types/demo'
import { jobsTable, schema } from '../utils/tables'

import { seedUsers } from './auth'

/**
 * The std Logger, BEFORE anything that logs (transport, db, the server): `DefaultLogger` +
 * `ConsoleTransport` + `TraceTransport` — every line prints AND becomes one log record,
 * correlated to the span it was logged in (`createServer` sees the bridge and installs none of
 * its own; lines logged by the infrastructure below, outside the node, reach the observing node's
 * sinks through the process fallback). A Logger the caller installed already (a script's root
 * install) is kept as it is.
 */
function* logging(): Operation<void> {
  if ((yield* Logger.context.get()) !== undefined) {
    return
  }

  yield* DefaultLogger.use()
  // both read the logger's level at setup — installed after it
  yield* ConsoleTransport.use()
  yield* TraceTransport.use()
}

/**
 * The terminal timeline (`options.timeline`): `TerminalTracer` draws every trace this node (and
 * the infrastructure under it) produces as one block when it completes, through the cli
 * `Terminal` with the terminal's own colours and glyphs. A std:trace sink installed here means
 * tracing is on around the node, so `createServer` observes even without an exporter. A tracer
 * the caller installed already is kept.
 */
function* timeline(): Operation<void> {
  if (yield* Trace.actions.isTracing()) {
    return
  }

  yield* NodeTerminal.use()
  yield* DefaultPalette.use()
  yield* TerminalTracer.use()
}

export function* infrastructure(options: DemoOptions): Operation<void> {
  yield* logging()

  if (options.timeline) {
    yield* timeline()
  }
  yield* BunIO.use()
  yield* MemoryTransport.use(
    options.link
      ? { prefix: TRANSPORT_PREFIX, link: options.link as never }
      : { prefix: TRANSPORT_PREFIX },
  )
  yield* DbBus.use()
  yield* SqliteAdapter.use({ path: options.dbPath ?? ':memory:' })
  yield* DbClient.use({ schema })
  yield* TableKv.use({ prefix: 'demo' })
  // the queue on every node (anyone may enqueue); the WORKER runs where `jobs` is hosted, and
  // its attempts (root spans) run as the `jobs` service, not as the node
  yield* Queue.use({ table: jobsTable.name, service: 'jobs' })
  yield* seedUsers()
}
