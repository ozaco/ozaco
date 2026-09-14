import type { Operation } from 'std:effect'
import { fork, resource } from 'std:effect'

import type { WsDef } from '../types/ws'

import { SCOPE_CLOSED } from './const'
import { dial } from './dial'
import { createHandle } from './handle'
import { keepAlive } from './keepalive'
import { supervise } from './reconnect'
import { createSession } from './session'

/**
 * Open a connection as a RESOURCE bound to the caller's scope: the body dials the first socket
 * generation (raising `WsErrors.Connect` on a handshake failure), forks the reconnect supervisor and
 * keepalive pumps, provides the connection handle, and — when the scope closes — closes the
 * socket and finalizes in its teardown. Every socket generation feeds ONE shared raw-frame queue,
 * so `messages` is a single continuous flow across reconnects.
 */
export const createConnection = (
  impl: WsDef.ImplLike,
  url: string | URL,
  options: WsDef.Options,
): Operation<WsDef.Connection> =>
  resource(function* (provide) {
    const session = createSession(url, options)

    // initial dial — a handshake failure (WsErrors.Connect) surfaces directly to the connect() caller
    yield* dial(session, impl)

    if (session.reconnect) {
      const budget = session.reconnect
      yield* fork(() => supervise(session, impl, budget))
    }

    if (options.keepalive) {
      const keepalive = options.keepalive
      yield* fork(() => keepAlive(session, keepalive))
    }

    const connection = createHandle(session)

    try {
      yield* provide(connection)
    } finally {
      // scope teardown: the connection is a resource — close the socket and finalize. Treated as
      // a clean client close: never reconnected, the flow ends `true`, `closed` resolves.
      yield* connection.close(SCOPE_CLOSED.code, SCOPE_CLOSED.reason)
    }
  })
