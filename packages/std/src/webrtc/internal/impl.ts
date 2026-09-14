import { attempt, operation, until } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { RtcDef } from '../types/rtc'

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
 * Resolve the peer-connection implementation: an `impl` given to `RtcClient.use` wins (`false`
 * means "none, and do not probe"); otherwise the platform global `RTCPeerConnection`; otherwise,
 * on Bun/Node, the optional `node-datachannel` polyfill is dynamically imported (once) and used.
 * Returns `undefined` when nothing is available — `connect` turns that into
 * `RtcErrors.Unsupported`.
 */
export const resolveImpl = operation(function* (injected: RtcDef.ImplLike | false | undefined) {
  if (injected) {
    return injected
  }

  if (injected === false) {
    return undefined
  }

  const global = (globalThis as AnyType).RTCPeerConnection as RtcDef.ImplLike | undefined
  if (global) {
    return global
  }

  if (!onNodeOrBun()) {
    return undefined
  }

  polyfilled ??= yield* loadPolyfill()

  return polyfilled === false ? undefined : polyfilled
}, 'rtc-resolve-impl')
