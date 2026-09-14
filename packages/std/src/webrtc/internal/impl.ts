import { attempt, operation, until } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { RtcDef } from '../types/rtc'
import { rtcImpl } from '../utils/context'

/** Probe result cache — the polyfill import is attempted at most once per process. */
let polyfilled: RtcDef.ImplLike | false | undefined

const onNodeOrBun = () =>
  typeof process !== 'undefined' && Boolean(process.versions?.node ?? process.versions?.bun)

/** Import the optional `node-datachannel` polyfill once. The specifier stays a variable so
 * bundlers and tsc treat the optional dependency as fully external. */
const loadPolyfill = operation(function* () {
  const specifier = 'node-datachannel/polyfill'
  const imported = yield* attempt(() => until(import(specifier)))
  const module_ = isSuccess(imported) ? (imported.value as AnyType) : undefined

  return (module_?.RTCPeerConnection ?? module_?.default?.RTCPeerConnection ?? false) as
    | RtcDef.ImplLike
    | false
}, 'rtc-load-polyfill')

/**
 * Resolve the peer-connection implementation: an injected/global `rtcImpl` wins; otherwise, on
 * Bun/Node, the optional `node-datachannel` polyfill is dynamically imported (once) and used.
 * Returns `undefined` when nothing is available — `connect` turns that into `rtc/unsupported`.
 */
export const resolveImpl = operation(function* () {
  const injected = yield* rtcImpl.get()
  if (injected) {
    return injected
  }

  if (injected === false || !onNodeOrBun()) {
    return undefined
  }

  polyfilled ??= yield* loadPolyfill()

  return polyfilled === false ? undefined : polyfilled
}, 'rtc-resolve-impl')
