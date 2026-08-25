import { install } from 'std:plugin'

import { createMemoryKv, MemoryKv } from 'db:impl/kv/memory'

import { runKvSuite } from './suite'

// one store per file: every install (any scope) joins the same in-process backend
const link = createMemoryKv()

runKvSuite({
  label: 'memory',
  enabled: true,
  install: (prefix = 'suite') => install(MemoryKv, { prefix, link }),
  expect: { persistent: false, atomic: false },
})
