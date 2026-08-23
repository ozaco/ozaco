import { install } from 'std:plugin'

import { MemoryAdapter } from 'db:impl/memory'

import { runAdapterSuite } from './helpers'

runAdapterSuite({
  label: 'memory',
  enabled: true,
  raw: false,
  install: () => install(MemoryAdapter),
})
