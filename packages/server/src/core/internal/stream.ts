import { STREAM_DECL } from '../const'
import type { Helpers } from '../types/helpers'
import type { StreamDef } from '../types/stream'

/** The brands core knows out of the box; `stream.brand(...)` registers more. */
export const registry = new Map<string, StreamDef.BrandSpec>()

export const register = (brand: string, spec: StreamDef.BrandSpec): StreamDef.BrandSpec => {
  registry.set(brand, spec)

  return spec
}

export const decl = <B extends string, T>(
  brand: B,
  spec: StreamDef.BrandSpec,
): StreamDef.Decl<B, T> => ({
  _t: STREAM_DECL,
  brand,
  spec: register(brand, spec),
})

/** A stream output a handler answered with as a Flow, not materialized yet (see `materialize`). */
export const isDeferred = (value: unknown): value is Helpers.DeferredStream =>
  typeof value === 'object' &&
  value !== null &&
  (value as Helpers.DeferredStream)._t === 'deferred-stream'
