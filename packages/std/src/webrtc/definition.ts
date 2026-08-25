import { operation } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { resolveImpl } from './internal/impl'
import { createPeer } from './internal/peer'
import type { RtcDef } from './types/rtc'

const RtcImpl = definePlugin<RtcDef.Context, [defaults?: RtcDef.Options]>({
  name: 'std/webrtc',
  version: '0.0.0',
  description: 'Scoped WebRTC peer with perfect negotiation, Flow channels, and ICE restart',

  *setup(defaults) {
    return { defaults: defaults ?? {} }
  },
})

/**
 * The WebRTC plugin. `install(Rtc, defaults?)` once per scope, then
 * `Rtc.actions.connect(signal, options)` opens a peer RESOURCE bound to the caller's scope —
 * when the scope closes, `rtc:bye` is signalled, the connection closes, and every channel and
 * background pump is torn down. Install-time `defaults` merge (shallow, per top-level key) under
 * each call's own options. Dispatches through the `rtcImpl` context (defaults to the platform
 * `RTCPeerConnection`; on Bun/Node the optional `node-datachannel` polyfill is auto-imported when
 * the global is absent) and frames channel messages through the registered `std:codec`, so
 * install a codec for structured values.
 */
export const Rtc = RtcImpl.build<RtcDef.Actions>({
  connect: operation(function* (signal: RtcDef.SignalLike, options?: RtcDef.Options) {
    const { defaults } = yield* RtcImpl.context.expect()
    const merged = { ...defaults, ...options }

    const Ctor = yield* resolveImpl()
    if (!Ctor) {
      return yield* fail(
        'rtc/unsupported',
        'no RTCPeerConnection implementation available (set rtcImpl or install node-datachannel)',
      )
    }

    return yield* createPeer(Ctor, signal, merged)
  }, 'rtc-connect'),
})
