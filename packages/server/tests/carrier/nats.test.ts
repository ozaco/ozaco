import { install } from 'std:plugin'

import { NatsTransport } from 'transport:impl/nats'

import { runCarrierSuite } from '../suites/carrier'

const url = process.env.TRANSPORT_TEST_NATS_URL
const prefix = `app${crypto.randomUUID().slice(0, 6)}`

runCarrierSuite({
  label: 'nats',
  enabled: Boolean(url),
  transport: () => install(NatsTransport, { prefix, servers: url!, storage: 'memory' }),
})
