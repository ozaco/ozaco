import { createContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { RtcDef } from '../types/rtc'

/**
 * The peer-connection implementation `connect()` dispatches through. Defaults to the platform
 * global `RTCPeerConnection` (browser, Deno); when that is absent on Bun/Node, `connect` lazily
 * imports the optional `node-datachannel` polyfill instead. Override it (tests, a custom stack)
 * with `rtcImpl.set(impl)` or `rtcImpl.with(impl, op)` in the running scope — set `false` to
 * simulate a platform with no implementation (the auto-import is skipped too).
 */
export const rtcImpl = createContext<RtcDef.ImplLike | false>(
  'std:webrtc',
  (globalThis as AnyType).RTCPeerConnection as RtcDef.ImplLike,
)
