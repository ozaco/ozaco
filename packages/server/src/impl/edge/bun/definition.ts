import type { EdgeDef } from 'server:core'
import { Edge } from 'server:core'
import { edgeActions, openEdge } from 'server:internal'

import pkg from '../../../../package.json'

import { driver, StateRef } from './internal'

/** The Bun edge: `Bun.serve` + native WebSocket upgrades behind the core engine. */
export const BunEdge = Edge.implement<EdgeDef.Options, []>({
  name: 'server-edge-bun',
  version: pkg.version,
  description: 'HTTP + WebSocket edge on Bun.serve',

  *setup() {
    yield* StateRef.set({ server: null })
    yield* openEdge()
    return { runtime: 'bun' }
  },
}).build(edgeActions(driver))
