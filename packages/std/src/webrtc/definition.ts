// oxlint-disable import/exports-last
import { guard } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../package.json'

import { RtcCauses, RtcErrors } from './errors'
import { resolveImpl } from './internal/impl'
import { createPeer } from './internal/peer'
import type { RtcDef } from './types/rtc'

/**
 * The WebRTC protocol handle: the routed `Rtc.actions.connect` dispatch plus the hook surface
 * (`Rtc.around({ connect })` and friends). Install {@link RtcClient} to provide the
 * implementation; without it any dispatch fails with `missing-action`.
 */
export const Rtc = defineProtocol<RtcDef.Context, RtcDef.Contract>({
  name: 'std/webrtc',
  version: pkg.version,
  description: 'WebRTC peer protocol: `connect` negotiates a peer bound to the caller scope',
})

/**
 * The platform implementation of the protocol. `RtcClient.use(defaults?)` once per scope, then
 * `Rtc.actions.connect(signal, options)` opens a peer RESOURCE bound to the caller's scope — when
 * the scope closes, `rtc:bye` is signalled, the connection closes, and every channel and
 * background pump is torn down. Install-time defaults merge (shallow, per top-level key) under
 * each call's own options. Peers are constructed with the platform `RTCPeerConnection`, resolved
 * at connect time; on Bun/Node without one the optional `node-datachannel` polyfill is
 * auto-imported. To substitute an implementation, implement the `Rtc` protocol instead
 * (`Rtc.implement(...).build({ connect })`) — see `tests/webrtc/fake.ts` for the mock. Channel
 * frames go through the registered `std:codec`.
 */
const RtcClientImpl = Rtc.implement<RtcDef.Context, [defaults?: RtcDef.Options]>({
  name: 'std/webrtc-client',
  version: pkg.version,
  description: 'Scoped WebRTC peer with perfect negotiation, Flow channels, and ICE restart',

  *setup(defaults) {
    return { defaults: defaults ?? {} }
  },
})

export const RtcClient = RtcClientImpl.build({
  connect: guard(function* (signal: RtcDef.SignalLike, options?: RtcDef.Options) {
    const { defaults } = yield* RtcClientImpl.context.expect()

    const impl = yield* resolveImpl()
    if (!impl) {
      return yield* fail(
        RtcErrors.Unsupported,
        'no RTCPeerConnection implementation available (install node-datachannel on Bun/Node)',
      )
    }

    return yield* createPeer(impl, signal, { ...defaults, ...options })
  }, RtcCauses.Connect),
})
