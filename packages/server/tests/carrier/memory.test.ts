import { createLink, MemoryTransport } from 'transport:impl/memory'

import { runCarrierSuite } from '../suites/carrier'

const link = createLink()

runCarrierSuite({
  label: 'memory',
  enabled: true,
  transport: () => MemoryTransport.use({ prefix: 'app', link }),
})
