import { budgetOf, createFuture, createGate, createQueue } from 'std:effect'

import { WsCauses } from '../errors'
import type { Helpers } from '../types/helpers'
import type { WsDef } from '../types/ws'

/**
 * Create the state ONE connection lives in. Nothing here touches a socket: the dialer adopts
 * generations into `socket`, the supervisors react to `outages`, the handle reads the flags —
 * and `settle` is the single permanent-end path all of them share.
 */
export const createSession = (url: string | URL, options: WsDef.Options): Helpers.Session => {
  const session: Helpers.Session = {
    url,
    options,
    reconnect: budgetOf(options.reconnect),

    frames: createQueue<unknown, WsDef.FlowClose>(),
    outages: createQueue<WsDef.CloseInfo, void>(),
    closed: createFuture<WsDef.CloseInfo>(),
    // `send` parks here during a reconnect window; every reopen and the permanent end notify it
    state: createGate(WsCauses.StateChange),

    socket: undefined,
    ended: false,
    closedByClient: false,
    reconnects: 0,
    lastClose: undefined,
    erred: undefined,

    settle(close, info) {
      if (session.ended) {
        return
      }

      session.ended = true
      session.lastClose = info
      session.frames.close(close)
      session.closed.resolve(info)
      session.outages.close()
      session.state.notify()
    },
  }

  return session
}
