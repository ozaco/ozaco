import { createConnectionLoader, createNodeByIdLoader, Pool, sql, usePool } from 'db:core'
import { main } from 'std:effect'
import { install } from 'std:plugin'

import { SqliteDriver } from 'db:impl/sqlite'
import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

/**
 * The core `@ozaco/db` dataloaders (the `@slonik/dataloaders` port) over a plain pool:
 *
 * - `createNodeByIdLoader` batches many ids into ONE `... WHERE id IN (...)` and caches by key, so a
 *   repeated `load` is served without a round-trip.
 * - `createConnectionLoader` returns a Relay cursor connection with keyset pagination (forward via
 *   `first`/`after`, backward via `last`/`before`) plus a total `count`.
 *
 * No field-name-transformation interceptor here — loaders read raw column names.
 */
await main(function* () {
  yield* install(BunIO) // IO provides uuid() for pool/connection ids
  yield* install(JsonCodec) // the connection loader encodes cursors through the codec
  yield* install(SqliteDriver)
  yield* install(Pool, { connectionUri: ':memory:' })
  const pool = yield* usePool()

  yield* pool.query(sql`
    CREATE TABLE widget (
      id     INTEGER PRIMARY KEY,
      name   TEXT    NOT NULL,
      weight INTEGER NOT NULL
    )
  `)
  yield* pool.query(sql`
    INSERT INTO widget (id, name, weight) VALUES
      (1, 'alpha', 30), (2, 'bravo', 10), (3, 'charlie', 50),
      (4, 'delta', 20), (5, 'echo', 40)
  `)

  // --- node-by-id loader (batch + cache) ---
  const byId = createNodeByIdLoader(pool, { table: 'widget' })
  const batch = yield* byId.loadMany([1, 3, 999])
  console.log('loadMany [1,3,999]:', batch.map(row => row?.name ?? 'null').join(', '))
  console.log('load 2:', (yield* byId.load(2))?.name)
  console.log('load 2 (cache hit):', (yield* byId.load(2))?.name)

  // --- relay connection loader (order by weight ASC, page size 2) ---
  const widgets = createConnectionLoader(pool, { table: 'widget' })
  const order = { column: 'weight', direction: 'ASC' as const }

  const page1 = yield* widgets.load({ first: 2, orderBy: order })
  console.log(
    'page1:',
    page1.edges.map(edge => edge.node.name).join(', '),
    '| count:',
    page1.count,
    '| hasNext:',
    page1.pageInfo.hasNextPage,
  )

  const page2 = yield* widgets.load({
    first: 2,
    orderBy: order,
    after: page1.pageInfo.endCursor ?? undefined,
  })
  console.log(
    'page2:',
    page2.edges.map(edge => edge.node.name).join(', '),
    '| hasNext:',
    page2.pageInfo.hasNextPage,
    '| hasPrev:',
    page2.pageInfo.hasPreviousPage,
  )

  const lastPage = yield* widgets.load({ last: 2, orderBy: order })
  console.log(
    'lastPage:',
    lastPage.edges.map(edge => edge.node.name).join(', '),
    '| hasPrev:',
    lastPage.pageInfo.hasPreviousPage,
  )

  yield* Pool.actions.close()
})
