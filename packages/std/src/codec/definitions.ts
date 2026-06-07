import { operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import {
  codecDecode,
  codecDecodeStream,
  codecEncode,
  codecEncodeStream,
  codecGetTransportsHandler,
  codecRegisterHandler,
  codecUnregisterHandler,
} from './internal/router'
import type { CodecDef } from './types'

export const CODEC = Symbol.for('std:codec')

/**
 * Whether any codec is registered in the current scope. Use this (not `Codec.context.get()`) to
 * decide whether to auto-install a default codec — installing an impl populates the shared registry,
 * never the protocol's own context. The registry is keyed by a stable string, so this reflects
 * registrations made by any module instance (e.g. a broker in another bundle).
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
export const Codec = defineProtocol<
  CodecDef.Context,
  unknown,
  unknown[],
  CodecDef.Actions,
  CodecDef.Handlers
>({
  name: 'std/codec',
  version: '0.0.0',

  subtype: CODEC,
  cloneable: true,

  handlers: {
    encodeRoot: codecEncode,
    decodeRoot: codecDecode,
    encodeStreamRoot: codecEncodeStream,
    decodeStreamRoot: codecDecodeStream,

    register: codecRegisterHandler,
    unregister: codecUnregisterHandler,
    getTransports: codecGetTransportsHandler,
  },
})
