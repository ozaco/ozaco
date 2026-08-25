import { operation } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../package.json'

import { wsImpl } from './context'
import { createConnection } from './internal/connection'
import type { WsDef } from './types'

const WsImpl = definePlugin<WsDef.Context, [defaults?: WsDef.Options]>({
  name: 'std/ws',
  version: pkg.version,
  description: 'Scoped WebSocket client with auto-reconnect and keepalive',

  *setup(defaults) {
    return { defaults: defaults ?? {} }
  },
})

/**
 * The WebSocket plugin. `install(Ws, defaults?)` once per scope, then
 * `Ws.actions.connect(url, options)` opens a connection RESOURCE bound to the caller's scope —
 * when the scope closes, the socket closes and every background pump is torn down. Install-time
 * `defaults` merge (shallow, per top-level key) under each call's own options. Dispatches through
 * the `wsImpl` context (defaults to the platform `WebSocket`; override it in tests) and frames
 * messages through the registered `std:codec`, so install a codec for structured values.
 */
export const Ws = WsImpl.build<WsDef.Actions>({
  connect: operation(function* (url: string | URL, options?: WsDef.Options) {
    const { defaults } = yield* WsImpl.context.expect()
    const merged = { ...defaults, ...options }

    const Ctor = yield* wsImpl.get()
    if (!Ctor) {
      return yield* fail('ws/unsupported', 'no WebSocket implementation available (set wsImpl)')
    }

    return yield* createConnection(Ctor, url, merged)
  }, 'ws-connect'),
})
