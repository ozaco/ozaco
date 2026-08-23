import { install } from 'std:plugin'

import { RedisTransport } from 'transport:impl/redis'

import { runTransportSuite } from './suite'

/** Set TRANSPORT_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379) to run these against a live server
 * — `moon run transport:test-redis` spins a disposable container. */
const url = process.env.TRANSPORT_TEST_REDIS_URL

runTransportSuite({
  label: 'redis',
  enabled: Boolean(url),
  install: (prefix = 'suite') => install(RedisTransport, { prefix, url: url!, ackWaitMs: 1000 }),
  expect: { receipts: true, requestReply: false, groups: true, durable: true },
  ackWaitMs: 1000,
})
