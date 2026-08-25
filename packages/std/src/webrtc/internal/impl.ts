import { attempt, operation, until } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { rtcImpl } from '../context'
import type { RtcDef } from '../types/rtc'

/** Probe result cache — the polyfill import is attempted at most once per process. */
let polyfilled: RtcDef.PeerCtor | false | undefined

const onNodeOrBun = () =>
  typeof process !== 'undefined' && Boolean(process.versions?.node ?? process.versions?.bun)

/**
 * Resolve the peer-connection constructor: an injected/global `rtcImpl` wins; otherwise, on
 * Bun/Node, the optional `node-datachannel` polyfill is dynamically imported (once) and used.
 * Returns `undefined` when nothing is available — `connect` turns that into `rtc/unsupported`.
 * The import specifier stays a variable so bundlers and tsc treat the optional dependency as
 * fully external.
 */
export const resolveImpl = operation(function* () {
  const injected = yield* rtcImpl.get()
  if (injected) {
    return injected
  }
  if (injected === false || !onNodeOrBun()) {
    return undefined
  }
  if (polyfilled === undefined) {
    const specifier = 'node-datachannel/polyfill'
    const imported = yield* attempt(() => until(import(specifier)))
    const module_ = isSuccess(imported) ? (imported.value as AnyType) : undefined
    polyfilled = (module_?.RTCPeerConnection ?? module_?.default?.RTCPeerConnection ?? false) as
      | RtcDef.PeerCtor
      | false
  }
  return polyfilled === false ? undefined : polyfilled
}, 'rtc-resolve-impl')
