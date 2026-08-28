import type { EdgeDef } from 'server:core'
import { Edge, ServerErrors } from 'server:core'
import { edgeActions, edgeDefaults, openEdge } from 'server:internal'
import { fail } from 'std:result'

import pkg from '../../../../package.json'

import { driver, StateRef } from './internal'
import { denoImpl } from './utils/context'

/** The Deno edge: `Deno.serve` + `Deno.upgradeWebSocket` behind the core engine (runtime
 * injectable through `denoImpl`). */
export const DenoEdge: EdgeDef.Handle = Edge.implement<EdgeDef.Options, []>({
  name: 'server-edge-deno',
  version: pkg.version,
  description: 'HTTP + WebSocket edge on Deno.serve',

  *setup() {
    const runtime = yield* denoImpl.get()
    if (!runtime) {
      return yield* fail(
        ServerErrors.Configuration,
        'no Deno runtime: run under Deno or set `denoImpl` to a compatible serve/upgrade pair',
      )
    }
    yield* StateRef.set({ server: null, runtime })
    yield* openEdge()
    return { runtime: 'deno' }
  },
}).build({
  ...edgeDefaults(),
  ...edgeActions(driver),
})
