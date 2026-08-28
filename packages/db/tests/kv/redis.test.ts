import { install } from 'std:plugin'

import { RedisKv } from 'db:impl/redis-kv'

import { runKvSuite } from './suite'

/** Set TRANSPORT_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379) to run these against a live server
 * — `moon run db:test-redis` spins a disposable container. */
const url = process.env.TRANSPORT_TEST_REDIS_URL

runKvSuite({
  label: 'redis',
  enabled: Boolean(url),
  install: (prefix = 'suite') => install(RedisKv, { prefix, url: url! }),
  expect: { persistent: true, atomic: true },
})
