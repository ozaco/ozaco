import type { EdgeDef } from 'server:core'
import { Edge, edgeActions, edgeDefaults, openEdge } from 'server:core'

import pkg from '../../../../package.json'

import { driver, StateRef } from './internal'

/** The Bun edge: `Bun.serve` + native WebSocket upgrades behind the core engine. */
export const BunEdge: EdgeDef.Handle = Edge.implement<EdgeDef.Options, []>({
  name: 'server-edge-bun',
  version: pkg.version,
  description: 'HTTP + WebSocket edge on Bun.serve',

  *setup() {
    yield* StateRef.set({ server: null })
    yield* openEdge()
    return { runtime: 'bun' }
  },
}).build({
  ...edgeDefaults(),
  ...edgeActions(driver),
})
