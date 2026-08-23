import type { EdgeDef } from 'server:core'
import { Edge, edgeActions, edgeDefaults, openEdge, ServerErrors } from 'server:core'
import { fail } from 'std:result'

import { createServer as createHttpServer } from 'node:http'

import { driver, StateRef } from './internal'

/** The Node edge: `node:http` (+ the optional `ws` peer for socket routes) behind the core engine. */
export const NodeEdge: EdgeDef.Handle = Edge.implement<EdgeDef.Options, []>({
  name: 'server-edge-node',
  version: '0.5.0',
  description: 'HTTP + WebSocket edge on node:http',

  *setup() {
    if (typeof createHttpServer !== 'function') {
      return yield* fail(ServerErrors.Configuration, 'node:http is not available here')
    }
    yield* StateRef.set({ server: null, wss: null })
    yield* openEdge()
    return { runtime: 'node' }
  },
}).build({
  ...edgeDefaults(),
  ...edgeActions(driver),
})
