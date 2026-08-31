/**
 * Install transport → change bus → storage — fixed to the zero-dependency picks: memory
 * transport (a shared `link` makes several in-process nodes one cluster), sqlite (a shared
 * `dbPath` makes one database for the cluster), memory kv. The bus rides the same transport
 * the carrier does, so every node sees every change (cache invalidation, realtime watches)
 * when they share a database.
 */
import { DbBus, DbClient } from 'db:core'
import type { Operation } from 'std:effect'

import { MemoryKv } from 'db:impl/memory-kv'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunIO } from 'std:io/impl/bun'
import { MemoryTransport } from 'transport:impl/memory'

import { TRANSPORT_PREFIX } from '../const'
import type { DemoOptions } from '../types/demo'
import { schema } from '../utils/tables'

import { seedUsers } from './auth'

export function* infrastructure(options: DemoOptions): Operation<void> {
  yield* BunIO.use()
  yield* MemoryTransport.use(
    options.link
      ? { prefix: TRANSPORT_PREFIX, link: options.link as never }
      : { prefix: TRANSPORT_PREFIX },
  )
  yield* DbBus.use()
  yield* SqliteAdapter.use({ path: options.dbPath ?? ':memory:' })
  yield* DbClient.use({ schema })
  yield* MemoryKv.use()
  yield* seedUsers()
}
