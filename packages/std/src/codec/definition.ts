import { defineProtocol } from 'std:plugin'

import pkg from '../../package.json'

import {
  codecDecodeFrameHandler,
  codecDecodeFramesHandler,
  codecEncodeFrameHandler,
  codecGetTransportsHandler,
  codecHasCodecHandler,
  codecRegisterHandler,
  codecUnregisterHandler,
} from './internal/router'
import type { CodecDef } from './types'

export const CODEC = Symbol.for('std:codec')

/**
 * The codec protocol: a registry of encoders/decoders kept in ASCENDING priority order (the active,
 * highest-priority codec is the LAST entry of `getTransports()`). `Codec.actions.*` route to the
 * highest-priority registered codec through the inline `exec` below; the registry actions
 * (`register` / `unregister` / `getTransports` / `hasCodec` / `encodeFrame` / `decodeFrame`) are plain handlers
 * and never route. Install a codec impl (e.g. `JsonCodec`) to populate the registry. Lives in `std` so any std consumer — `std:fetch`, the server
 * broker/transport, … — can encode/decode without coupling to a higher layer.
 */
export const Codec = defineProtocol<CodecDef.Context, CodecDef.Actions, CodecDef.Handlers>({
  name: 'std/codec',
  version: pkg.version,

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
        (entry.value as CodecDef.Context).priority >= (best.value as CodecDef.Context).priority
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
    hasCodec: codecHasCodecHandler,
    encodeFrame: codecEncodeFrameHandler,
    decodeFrame: codecDecodeFrameHandler,
    decodeFrames: codecDecodeFramesHandler,
  },
})
