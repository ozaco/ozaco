import { install } from 'std:plugin'

import { BunSqlAdapter } from 'db:impl/bun-sql'
import { PgAdapter } from 'db:impl/pg'

import { runAdapterSuite } from './helpers'

/** Set DB_TEST_PG_URL (e.g. postgres://localhost/ozaco_test) to run these against a live server.
 * The suite drops and recreates its tables on every test. */
const url = process.env.DB_TEST_PG_URL

runAdapterSuite({
  label: 'pg',
  enabled: Boolean(url),
  raw: true,
  install: () => install(PgAdapter, { url: url! }),
})

runAdapterSuite({
  label: 'bun-sql',
  enabled: Boolean(url),
  raw: true,
  install: () => install(BunSqlAdapter, { url: url! }),
})
