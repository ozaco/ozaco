import type { Helpers as EffectHelpers, Queue, Utils } from 'std:effect'
import type { Result } from 'std:result'

import type { WsDef } from './ws'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /**
   * ONE connection's lifetime state, shared by the dialer, the supervisors, and the handle. Every
   * socket generation feeds the same `frames` queue, so `messages` stays one continuous flow
   * across reconnects; `settle` is the single permanent-end path.
   */
  export interface Session {
    readonly url: string | URL
    readonly options: WsDef.Options
    /** Resolved reconnect budget — absent on a single-shot connection. */
    readonly reconnect: Utils.Budget | undefined

    /** Raw frames from every generation; codec-decoded lazily on pull by `messages`. */
    readonly frames: Queue<unknown, WsDef.FlowClose>
    /** Each non-client close of the CURRENT generation, for the reconnect supervisor. */
    readonly outages: Queue<WsDef.CloseInfo, void>
    /** Resolves with the final close info once the connection permanently ends. */
    readonly closed: EffectHelpers.FutureWithResolvers<WsDef.CloseInfo>

    /** Current socket generation — adopted inside `onopen`, replaced on every reopen. */
    socket: WsDef.SocketLike | undefined
    /** Permanently ended: `frames` is closed and `closed` is resolved. */
    ended: boolean
    /** `close()` was called (or the scope tore down) — never reconnect past this point. */
    closedByClient: boolean
    reconnects: number
    lastClose: WsDef.CloseInfo | undefined
    /** Post-open socket error on a single-shot connection — becomes the flow's failure close. */
    erred: Result.Failure<unknown> | undefined

    /** The gate `send` parks on through a reconnect window; notified on every state change. */
    readonly state: Utils.Gate
    /** Permanent end — runs at most once: closes `frames`, resolves `closed`, ends the
     * supervisor, wakes any parked sender. */
    settle(close: WsDef.FlowClose, info: WsDef.CloseInfo): void
  }
}
