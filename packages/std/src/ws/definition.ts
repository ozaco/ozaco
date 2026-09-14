// oxlint-disable import/exports-last
import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import { WsCauses, WsErrors } from './errors'
import { createConnection } from './internal/connection'
import type { WsDef } from './types/ws'

/**
 * The WebSocket protocol handle: the routed `Ws.actions.connect` dispatch plus the hook surface
 * (`Ws.around({ connect })` and friends). Install {@link WsClient} to provide the implementation;
 * without it any dispatch fails with `missing-action`.
 */
export const Ws = defineProtocol<WsDef.Context, WsDef.Contract>({
  name: 'std/ws',
  version: pkg.version,
  description: 'WebSocket client protocol: `connect` opens a connection bound to the caller scope',
})

/**
 * The platform implementation of the protocol. `WsClient.use(defaults?)` once per scope, then
 * `Ws.actions.connect(url, options)` opens a connection RESOURCE bound to the caller's scope —
 * when the scope closes, the socket closes and every background pump is torn down. Install-time
 * defaults merge (shallow, per top-level key) under each call's own options. Sockets are
 * constructed with the platform `WebSocket` global, read at connect time; to substitute one,
 * implement the `Ws` protocol instead (`Ws.implement(...).build({ connect })`) — see
 * `tests/ws/helpers.ts` for the mock. Frames go through the registered `std:codec`, so install a
 * codec for structured values.
 */
const WsClientImpl = Ws.implement<WsDef.Context, [defaults?: WsDef.Options]>({
  name: 'std/ws-client',
  version: pkg.version,
  description: 'Scoped WebSocket client over the platform WebSocket, with reconnect and keepalive',

  *setup(defaults) {
    return { defaults: defaults ?? {} }
  },
})

export const WsClient = WsClientImpl.build({
  connect: operation(function* (url: string | URL, options?: WsDef.Options) {
    const { defaults } = yield* WsClientImpl.context.expect()

    const impl = (globalThis as AnyType).WebSocket as WsDef.ImplLike | undefined
    if (!impl) {
      return yield* fail(WsErrors.Unsupported, 'this platform has no WebSocket global')
    }

    return yield* createConnection(impl, url, { ...defaults, ...options })
  }, WsCauses.Connect),
})
