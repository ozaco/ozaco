import { install } from 'std:plugin'

import { RedisTransport } from 'transport:impl/redis'

import { runCarrierSuite } from '../suites/carrier'

const url = process.env.TRANSPORT_TEST_REDIS_URL
const prefix = `app${crypto.randomUUID().slice(0, 6)}`

runCarrierSuite({
  label: 'redis',
  enabled: Boolean(url),
  transport: () => install(RedisTransport, { prefix, url: url! }),
})
