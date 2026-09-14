import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import { WsErrors } from './errors'
import { createConnection } from './internal/connection'
import type { WsDef } from './types/ws'

/**
 * The WebSocket protocol handle: the routed `Ws.actions.connect` dispatch plus the hook surface
 * (`Ws.around({ connect })` and friends). Install {@link WsClient} to provide the implementation;
 * without it any dispatch fails with `missing-action`.
 */
const WsProtocol = defineProtocol<WsDef.Context, WsDef.Contract>({
  name: 'std/ws',
  version: pkg.version,
  description: 'WebSocket client protocol: `connect` opens a connection bound to the caller scope',
})

/**
 * The platform implementation of the protocol. `WsClient.use({ ...defaults, impl })` once per
 * scope, then `Ws.actions.connect(url, options)` opens a connection RESOURCE bound to the caller's
 * scope — when the scope closes, the socket closes and every background pump is torn down.
 * Install-time defaults merge (shallow, per top-level key) under each call's own options. The
 * socket constructor is the `impl` option (defaults to the platform `WebSocket`; pass a fake in
 * tests, or `false` to simulate a platform without one). Frames go through the registered
 * `std:codec`, so install a codec for structured values.
 */
const WsClientImpl = WsProtocol.implement<WsDef.Context, [options?: WsDef.ClientOptions]>({
  name: 'std/ws-client',
  version: pkg.version,
  description: 'Scoped WebSocket client over the platform WebSocket, with reconnect and keepalive',

  *setup(options) {
    const { impl, ...defaults } = options ?? {}

    return {
      defaults,
      impl: impl === undefined ? ((globalThis as AnyType).WebSocket as WsDef.ImplLike) : impl,
    }
  },
})

const WsClientPlugin: WsDef = WsClientImpl.build({
  connect: operation(function* (url: string | URL, options?: WsDef.Options) {
    const { defaults, impl } = yield* WsClientImpl.context.expect()
    if (!impl) {
      return yield* fail(
        WsErrors.Unsupported,
        'no WebSocket implementation available (pass `impl` to WsClient.use)',
      )
    }

    return yield* createConnection(impl, url, { ...defaults, ...options })
  }, 'ws-connect'),
})

export const Ws = WsProtocol
export const WsClient = WsClientPlugin
