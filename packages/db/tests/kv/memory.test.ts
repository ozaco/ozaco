import { createMemoryKv, MemoryKv } from 'db:impl/memory-kv'

import { runKvSuite } from './suite'

// one store per file: every install (any scope) joins the same in-process backend
const link = createMemoryKv()

runKvSuite({
  label: 'memory',
  enabled: true,
  use: (prefix = 'suite') => MemoryKv.use({ prefix, link }),
  expect: { persistent: false, atomic: false },
})
