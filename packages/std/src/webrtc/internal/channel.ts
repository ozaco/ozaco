import { Codec } from 'std:codec'
import type { Flow } from 'std:effect'
import { createFuture, createGate, createQueue, guard, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { RtcCauses, RtcErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { CHANNEL_DEFAULTS } from './const'
import { sizeOf } from './observe'

/** Whether a native can still take a `close()` call. */
const isLive = (native: RtcDef.ChannelLike | undefined): native is RtcDef.ChannelLike =>
  native !== undefined && (native.readyState === 'open' || native.readyState === 'connecting')

/** Forward only the wire-init subset of the merged channel options to `createDataChannel`. */
export const initOf = (channel: RtcDef.ChannelOptions): RtcDef.ChannelInit => ({
  ...(channel.ordered === undefined ? {} : { ordered: channel.ordered }),
  ...(channel.maxRetransmits === undefined ? {} : { maxRetransmits: channel.maxRetransmits }),
  ...(channel.maxPacketLifeTime === undefined
    ? {}
    : { maxPacketLifeTime: channel.maxPacketLifeTime }),
  ...(channel.protocol === undefined ? {} : { protocol: channel.protocol }),
})

/**
 * Wrap a native data channel into the effect-native handle: one queue-backed `messages` Flow
 * (codec-decoded on pull, buffered until consumed), a `send` that parks while the channel is
 * still connecting, suspended for a session redial, or while `bufferedAmount` sits above the
 * high-water mark (woken by `bufferedamountlow`), and a `closed` future. With session `reconnect`
 * the peer `suspend`s the entry when a generation dies and `rebind`s it onto the next
 * generation's native — the handle and its flows are continuous across redials. Close semantics
 * are deterministic: a local `close()`/`end()` settles immediately after `native.close()`
 * (already-buffered incoming frames still drain to the consumer first); a remote/impl close
 * settles on the `close` event — unless `retain()` says the session is redialing, in which case
 * the entry suspends instead — with a preceding `error` turning the close value into
 * `rtc/channel`.
 */
export const wrapChannel = (
  first: RtcDef.ChannelLike,
  options: RtcDef.ChannelOptions,
  wiring: Helpers.ChannelWiring = {},
): Helpers.ChannelEntry => {
  const { codec, retain, observe } = wiring
  const highWaterMark = options.highWaterMark ?? CHANNEL_DEFAULTS.highWaterMark
  const lowWaterMark = options.lowWaterMark ?? CHANNEL_DEFAULTS.lowWaterMark

  const queue = createQueue<unknown, RtcDef.FlowClose>()
  const closed = createFuture<RtcDef.FlowClose>()
  const openedResolvers = withResolvers<void>(RtcCauses.ChannelOpen)

  const state = {
    /** The CURRENT generation's native (undefined while suspended for a redial). */
    native: undefined as RtcDef.ChannelLike | undefined,
    ended: false,
    closedByClient: false,
    suspended: false,
    /** Channel-level error observed before the close event — becomes the flow's failure close. */
    erred: undefined as Result.Failure<unknown> | undefined,
  }

  // `send` parks on `drain` while the buffer is above the high-water mark (notified by
  // `bufferedamountlow`), and on `open` while connecting or suspended (notified by every open and
  // rebind-to-open); the permanent end notifies both.
  const drain = createGate(RtcCauses.ChannelDrain)
  const open = createGate(RtcCauses.ChannelOpen)

  const markOpen = () => {
    openedResolvers.resolve()
    open.notify()
  }

  /** Permanent end — runs at most once: closes the messages queue (buffered frames still drain
   * to the consumer first), resolves `closed`, wakes any parked sender or open-waiter. */
  const settle = (close: RtcDef.FlowClose) => {
    if (state.ended) {
      return
    }

    state.ended = true
    queue.close(close)
    closed.resolve(close)
    // no-op once already open
    openedResolvers.reject(
      fail(RtcErrors.Channel, `channel "${first.label}" closed before it opened`),
    )
    open.notify()
    drain.notify()
  }

  // on* assignment (not addEventListener): ChannelLike is the handler-property shape shared by
  // the browser RTCDataChannel and the node-datachannel polyfill.
  /* oxlint-disable unicorn/prefer-add-event-listener */

  const unwire = (native: RtcDef.ChannelLike) => {
    native.onopen = null
    native.onmessage = null
    native.onbufferedamountlow = null
    native.onerror = null
    native.onclose = null
  }

  const wire = (native: RtcDef.ChannelLike) => {
    native.bufferedAmountLowThreshold = lowWaterMark
    // receive binary frames as ArrayBuffer, not the browser-default Blob — consistent across
    // implementations and passed straight through by `decodeFrame`.
    native.binaryType = 'arraybuffer'

    native.onopen = () => {
      if (state.native === native) {
        markOpen()
      }
    }

    native.onmessage = event => {
      if (state.ended || state.native !== native) {
        return
      }

      // count BEFORE enqueuing: `queue.add` resumes a parked consumer synchronously, so a
      // reader that snapshots the metrics right after its `next()` would otherwise miss this one
      if (observe) {
        observe.counters.messagesReceived += 1
        observe.counters.bytesReceived += sizeOf(event.data)
      }

      queue.add(event.data)
    }

    native.onbufferedamountlow = () => {
      drain.notify()
    }

    native.onerror = () => {
      if (!state.ended && !state.closedByClient && state.native === native) {
        state.erred = fail(
          RtcErrors.Channel,
          `data channel error: ${native.label}`,
        ) as Result.Failure<unknown>
      }
    }

    native.onclose = () => {
      if (state.native !== native) {
        return // a superseded generation — nothing to do
      }

      if (!state.closedByClient && !state.ended && retain?.()) {
        // the native died under a session that is redialing — suspend and await the rebind
        suspend()
        return
      }

      settle(state.closedByClient ? true : (state.erred ?? true))
    }
  }

  /* oxlint-enable unicorn/prefer-add-event-listener */

  const suspend = () => {
    if (state.ended) {
      return
    }

    const native = state.native
    state.suspended = true
    state.native = undefined

    if (native) {
      unwire(native)
    }
  }

  const rebind = (native: RtcDef.ChannelLike) => {
    if (state.ended) {
      return
    }

    state.suspended = false
    state.native = native
    wire(native)

    if (native.readyState === 'open') {
      markOpen()
    }
  }

  /** Close the current native (if it can still take it) and settle with `close`. */
  const end = (close: RtcDef.FlowClose) => {
    state.closedByClient = true

    if (!state.ended && isLive(state.native)) {
      state.native.close()
    }

    settle(close)
  }

  state.native = first
  wire(first)

  if (first.readyState === 'open') {
    openedResolvers.resolve() // wrapped after the fact (e.g. a pre-opened remote channel)
  }

  // a Flow is `Operation<Subscription>`: every pull codec-decodes one raw frame off the queue —
  // buffered frames survive until read.
  const messages: Flow<unknown, RtcDef.FlowClose> = {
    *[Symbol.iterator]() {
      return yield* Codec.actions.decodeFrames(queue, codec)
    },
  }

  const handle: RtcDef.Channel = {
    label: first.label,
    messages,
    closed: closed.future,

    get native() {
      return state.native as RtcDef.ChannelLike
    },
    get readyState() {
      return state.native?.readyState ?? (state.ended ? 'closed' : 'connecting')
    },

    send: guard(function* (data: unknown) {
      const payload = yield* Codec.actions.encodeFrame(data, codec)

      while (true) {
        if (state.ended || state.closedByClient) {
          return // permanently closed → WHATWG silent discard
        }

        // read the CURRENT gates before checking, so a wake between check and park still lands
        const opening = open.wait()
        const draining = drain.wait()
        const native = state.native

        if (!native || state.suspended || native.readyState === 'connecting') {
          yield* opening // park until (re)open or the permanent end, then re-check
          continue
        }

        if (native.readyState === 'closing' || native.readyState === 'closed') {
          return // closing underneath us with no redial → WHATWG silent discard
        }

        if (native.bufferedAmount > highWaterMark) {
          yield* draining // backpressure: wait for bufferedamountlow, then re-check
          continue
        }

        native.send(payload as AnyType)

        if (observe) {
          observe.counters.messagesSent += 1
          observe.counters.bytesSent += sizeOf(payload)
        }

        return
      }
    }, RtcCauses.ChannelSend),

    close: guard(function* () {
      end(true)
      yield* closed.future
    }, RtcCauses.ChannelClose),
  }

  return { handle, opened: openedResolvers.operation, end, suspend, rebind }
}
