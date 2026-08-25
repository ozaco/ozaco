import { Codec } from 'std:codec'
import type { Flow, Future } from 'std:effect'
import { createQueue, operation, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { RtcDef } from '../types/rtc'

import { sizeOf } from './observe'

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
  const highWaterMark = options.highWaterMark ?? 1_048_576

  const queue = createQueue<unknown, RtcDef.FlowClose>()
  const closedResolvers = withResolvers<RtcDef.FlowClose>('rtc:channel-closed')
  const openedResolvers = withResolvers<void>('rtc:channel-open')

  const state = {
    /** The CURRENT generation's native (undefined while suspended for a redial). */
    native: undefined as RtcDef.ChannelLike | undefined,
    ended: false,
    closedByClient: false,
    suspended: false,
    /** Channel-level error observed before the close event — becomes the flow's failure close. */
    erred: undefined as Result.Failure<unknown> | undefined,
  }

  // `send` parks on this gate while the buffer is above the high-water mark; every
  // `bufferedamountlow` and the permanent end resolve the current gate and arm a fresh one.
  let drainGate = withResolvers<void>('rtc:channel-drain')
  const notifyDrain = () => {
    const gate = drainGate
    drainGate = withResolvers<void>('rtc:channel-drain')
    gate.resolve()
  }

  // `send` parks on this gate while connecting or suspended; every open, rebind-to-open, and the
  // permanent end resolve the current gate and arm a fresh one.
  let openGate = withResolvers<void>('rtc:channel-open-gate')
  const notifyOpen = () => {
    const gate = openGate
    openGate = withResolvers<void>('rtc:channel-open-gate')
    gate.resolve()
  }

  /** Permanent end — runs at most once: closes the messages queue (buffered frames still drain
   * to the consumer first), resolves `closed`, wakes any parked sender or open-waiter. */
  const settle = (close: RtcDef.FlowClose) => {
    if (state.ended) {
      return
    }
    state.ended = true
    queue.close(close)
    closedResolvers.resolve(close)
    openedResolvers.reject(fail('rtc/channel', `channel "${first.label}" closed before it opened`)) // no-op once already open
    notifyOpen()
    notifyDrain()
  }

  const unwire = (native: RtcDef.ChannelLike) => {
    // oxlint-disable unicorn/prefer-add-event-listener
    native.onopen = null
    native.onmessage = null
    native.onbufferedamountlow = null
    native.onerror = null
    native.onclose = null
  }

  // on* assignment (not addEventListener): ChannelLike is the handler-property shape shared by
  // the browser RTCDataChannel and the node-datachannel polyfill.
  /* oxlint-disable unicorn/prefer-add-event-listener */
  const wire = (native: RtcDef.ChannelLike) => {
    native.bufferedAmountLowThreshold = options.lowWaterMark ?? 262_144
    // receive binary frames as ArrayBuffer, not the browser-default Blob — consistent across
    // implementations and passed straight through by `decodeFrame`.
    native.binaryType = 'arraybuffer'

    native.onopen = () => {
      if (state.native === native) {
        openedResolvers.resolve()
        notifyOpen()
      }
    }
    native.onmessage = event => {
      if (!state.ended && state.native === native) {
        // count BEFORE enqueuing: `queue.add` resumes a parked consumer synchronously, so a
        // reader that snapshots the metrics right after its `next()` would otherwise miss this one
        if (observe) {
          observe.counters.messagesReceived += 1
          observe.counters.bytesReceived += sizeOf(event.data)
        }
        queue.add(event.data)
      }
    }
    native.onbufferedamountlow = () => {
      notifyDrain()
    }
    native.onerror = () => {
      if (!state.ended && !state.closedByClient && state.native === native) {
        state.erred = fail(
          'rtc/channel',
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
      openedResolvers.resolve()
      notifyOpen()
    }
  }

  state.native = first
  wire(first)
  if (first.readyState === 'open') {
    openedResolvers.resolve() // wrapped after the fact (e.g. a pre-opened remote channel)
  }

  const closed = operation(function* () {
    return yield* closedResolvers.operation
  })() as Future<RtcDef.FlowClose>

  // a Flow is `Operation<Subscription>`; this hands back a subscription whose `next()` pulls a
  // raw frame off the queue and codec-decodes it — buffered frames survive until read.
  const messages = {
    *[Symbol.iterator]() {
      return {
        next: operation(function* () {
          const item = yield* queue.next()
          if (item.done) {
            return item
          }
          return { done: false, value: yield* Codec.actions.decodeFrame(item.value, codec) }
        }),
      }
    },
  } as Flow<unknown, RtcDef.FlowClose>

  const handle: RtcDef.Channel = {
    get native() {
      return state.native as RtcDef.ChannelLike
    },
    label: first.label,
    get readyState() {
      return state.native?.readyState ?? (state.ended ? 'closed' : 'connecting')
    },
    send: operation(function* (data: unknown) {
      const payload = yield* Codec.actions.encodeFrame(data, codec)
      while (true) {
        if (state.ended || state.closedByClient) {
          return // permanently closed → WHATWG silent discard
        }
        // read the CURRENT gates before checking, so a wake between check and park still lands
        const opening = openGate
        const draining = drainGate
        const native = state.native
        if (!native || state.suspended || native.readyState === 'connecting') {
          yield* opening.operation // park until (re)open or the permanent end, then re-check
          continue
        }
        if (native.readyState === 'closing' || native.readyState === 'closed') {
          return // closing underneath us with no redial → WHATWG silent discard
        }
        if (native.bufferedAmount > highWaterMark) {
          yield* draining.operation // backpressure: wait for bufferedamountlow, then re-check
          continue
        }
        native.send(payload as AnyType)
        if (observe) {
          observe.counters.messagesSent += 1
          observe.counters.bytesSent += sizeOf(payload)
        }
        return
      }
    }, 'rtc-channel-send'),
    messages,
    close: operation(function* () {
      state.closedByClient = true
      if (!state.ended) {
        const native = state.native
        if (native && (native.readyState === 'open' || native.readyState === 'connecting')) {
          native.close()
        }
        settle(true)
      }
      yield* closedResolvers.operation
    }, 'rtc-channel-close'),
    closed,
  }

  return {
    handle,
    opened: openedResolvers.operation,
    end: close => {
      state.closedByClient = true
      const native = state.native
      if (
        !state.ended &&
        native &&
        (native.readyState === 'open' || native.readyState === 'connecting')
      ) {
        native.close()
      }
      settle(close)
    },
    suspend,
    rebind,
  }
}
