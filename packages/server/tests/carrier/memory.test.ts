import { install } from 'std:plugin'

import { createLink, MemoryTransport } from 'transport:impl/memory'

import { runCarrierSuite } from '../suites/carrier'

const link = createLink()

runCarrierSuite({
  label: 'memory',
  enabled: true,
  transport: () => install(MemoryTransport, { prefix: 'app', link }),
})
