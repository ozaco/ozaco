import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import {
  codecGetTransportsHandler,
  codecRegisterHandler,
  codecUnregisterHandler,
} from './internal/router'
import type { CodecDef } from './types'

export const CODEC = Symbol.for('std:codec')

/**
 * Whether any codec is registered in the CURRENT scope. Use this (not `Codec.context.get()`) to
 * decide whether to auto-install a default codec. The registry is a scope-local effect Context
 * (`CodecRegistryContext`, inherited DOWNWARD through the protocol context) — NOT a global
 * string-keyed table. It reflects registrations visible in the current scope chain only, not those
 * made in unrelated scopes/bundles.
 */
export const hasCodec = operation(function* () {
  return (yield* codecGetTransportsHandler()).length > 0
})

/**
 * The codec protocol: a registry of encoders/decoders sorted by priority. `Codec.actions.*` route to
 * the highest-priority registered codec (via the `*Root` handlers). Install a codec impl (e.g.
 * `JsonCodec`) to populate the registry. Lives in `std` so any std consumer — `std:fetch`, the server
 * broker/transport, … — can encode/decode without coupling to a higher layer.
 */
export const Codec = defineProtocol<CodecDef.Context, CodecDef.Actions, CodecDef.Handlers>({
  name: 'std/codec',
  version: '0.0.0',

  subtype: CODEC,
  cloneable: true,

  // `Codec.actions.encode/decode/...` run the HIGHEST-priority installed codec (ties: the most
  // recently installed). Installing JSON (priority 999) + TOML/YAML (500) keeps JSON active; install
  // a codec with a higher `{ priority }` to prefer it. A direct `SomeCodec.actions.*` call is
  // unaffected — it always targets that specific codec (used by the server/ai to force JSON).
  *exec(entries, run) {
    let best: (typeof entries)[number] | undefined

    for (const entry of entries) {
      if (
        !best ||
        (entry.contextValue as CodecDef.Context).priority >=
          (best.contextValue as CodecDef.Context).priority
      ) {
        best = entry
      }
    }

    return yield* run(best)
  },

  handlers: {
    register: codecRegisterHandler,
    unregister: codecUnregisterHandler,
    getTransports: codecGetTransportsHandler,
  },
})
