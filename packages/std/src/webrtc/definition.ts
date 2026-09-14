import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../package.json'

import { RtcErrors } from './errors'
import { resolveImpl } from './internal/impl'
import { createPeer } from './internal/peer'
import type { RtcDef } from './types/rtc'

/**
 * The WebRTC protocol handle: the routed `Rtc.actions.connect` dispatch plus the hook surface
 * (`Rtc.around({ connect })` and friends). Install {@link RtcClient} to provide the
 * implementation; without it any dispatch fails with `missing-action`.
 */
const RtcProtocol = defineProtocol<RtcDef.Context, RtcDef.Contract>({
  name: 'std/webrtc',
  version: pkg.version,
  description: 'WebRTC peer protocol: `connect` negotiates a peer bound to the caller scope',
})

/**
 * The platform implementation of the protocol. `RtcClient.use({ ...defaults, impl })` once per
 * scope, then `Rtc.actions.connect(signal, options)` opens a peer RESOURCE bound to the caller's
 * scope — when the scope closes, `rtc:bye` is signalled, the connection closes, and every channel
 * and background pump is torn down. Install-time defaults merge (shallow, per top-level key)
 * under each call's own options. The peer-connection constructor is the `impl` option: omitted,
 * the platform `RTCPeerConnection` is used and, on Bun/Node without one, the optional
 * `node-datachannel` polyfill is auto-imported; pass a fake in tests, or `false` to simulate a
 * platform without any implementation. Channel frames go through the registered `std:codec`.
 */
const RtcClientImpl = RtcProtocol.implement<RtcDef.Context, [options?: RtcDef.ClientOptions]>({
  name: 'std/webrtc-client',
  version: pkg.version,
  description: 'Scoped WebRTC peer with perfect negotiation, Flow channels, and ICE restart',

  *setup(options) {
    const { impl, ...defaults } = options ?? {}

    return { defaults, impl }
  },
})

const RtcClientPlugin: RtcDef = RtcClientImpl.build({
  connect: operation(function* (signal: RtcDef.SignalLike, options?: RtcDef.Options) {
    const { defaults, impl: injected } = yield* RtcClientImpl.context.expect()

    const impl = yield* resolveImpl(injected)
    if (!impl) {
      return yield* fail(
        RtcErrors.Unsupported,
        'no RTCPeerConnection implementation available (pass `impl` to RtcClient.use or install node-datachannel)',
      )
    }

    return yield* createPeer(impl, signal, { ...defaults, ...options })
  }, 'rtc-connect'),
})

export const Rtc = RtcProtocol
export const RtcClient = RtcClientPlugin
