import type { AnyType } from 'std:shared'

import { DenoEdge, denoImpl } from 'server:impl/edge/deno'

import { runEdgeSuite } from '../suites/edge'

import { fakeDeno } from './fake-deno'

runEdgeSuite({
  label: 'deno',
  enabled: true,
  edge: DenoEdge.use(),
  listens: true,
  *use() {
    yield* denoImpl.set(fakeDeno as AnyType)
  },
})
