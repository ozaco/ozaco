import { install } from 'std:plugin'

import { SqliteAdapter } from 'db:impl/sqlite'

import { runAdapterSuite } from './helpers'

runAdapterSuite({
  label: 'sqlite',
  enabled: true,
  raw: true,
  install: () => install(SqliteAdapter),
})
