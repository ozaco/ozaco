import { createQueue, withResolvers } from 'std:effect'

import type { Helpers } from '../types/helpers'
import type { WsDef } from '../types/ws'

import { RECONNECT_DEFAULTS } from './const'

const budgetOf = (options?: WsDef.ReconnectOptions): Helpers.ReconnectBudget | undefined =>
  options
    ? {
        retries: options.retries ?? RECONNECT_DEFAULTS.retries,
        delayMs: options.delayMs ?? RECONNECT_DEFAULTS.delayMs,
        backoff: options.backoff ?? RECONNECT_DEFAULTS.backoff,
        maxDelayMs: options.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs,
      }
    : undefined

/**
 * Create the state ONE connection lives in. Nothing here touches a socket: the dialer adopts
 * generations into `socket`, the supervisors react to `outages`, the handle reads the flags —
 * and `settle` is the single permanent-end path all of them share.
 */
export const createSession = (url: string | URL, options: WsDef.Options): Helpers.Session => {
  // `send` parks on this gate during a reconnect window; every reopen and the permanent end
  // resolve the current gate and arm a fresh one.
  let stateGate = withResolvers<void>('ws:state-change')

  const session: Helpers.Session = {
    url,
    options,
    reconnect: budgetOf(options.reconnect),

    frames: createQueue<unknown, WsDef.FlowClose>(),
    outages: createQueue<WsDef.CloseInfo, void>(),
    closed: withResolvers<WsDef.CloseInfo>('ws:closed'),

    socket: undefined,
    ended: false,
    closedByClient: false,
    reconnects: 0,
    lastClose: undefined,
    erred: undefined,

    stateChanged: () => stateGate.operation,

    notifyState() {
      const gate = stateGate
      stateGate = withResolvers<void>('ws:state-change')
      gate.resolve()
    },

    settle(close, info) {
      if (session.ended) {
        return
      }

      session.ended = true
      session.lastClose = info
      session.frames.close(close)
      session.closed.resolve(info)
      session.outages.close()
      session.notifyState()
    },
  }

  return session
}
