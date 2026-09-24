import { runAdapterSuite } from 'db:testing'

import { MemoryAdapter } from 'db:impl/memory'

runAdapterSuite({
  label: 'memory',
  enabled: true,
  raw: false,
  use: () => MemoryAdapter.use(),
})
