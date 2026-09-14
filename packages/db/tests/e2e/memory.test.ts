import { MemoryAdapter } from 'db:impl/memory'

import { runAdapterSuite } from './helpers'

runAdapterSuite({
  label: 'memory',
  enabled: true,
  raw: false,
  use: () => MemoryAdapter.use(),
})
