import type { Subscription } from 'std:effect'
import { attempt, filter, toSorted, useContext } from 'std:effect'
import { fail, isSuccess } from 'std:result'

import { Codec } from '../definition'
import { CodecErrors } from '../errors'
import type { CodecDef } from '../types'

import { CodecRegistryContext } from './context'

export function* sortedCodecs(
  entries: CodecDef[],
  transport: CodecDef,
  transportCtx: CodecDef.Context,
) {
  return yield* toSorted(entries, function* (a, b) {
    const aCtx = a === transport ? transportCtx : yield* useContext(a)
    const bCtx = b === transport ? transportCtx : yield* useContext(b)

    return aCtx.priority - bCtx.priority
  })
}

export const codecRegisterHandler: CodecDef.Handlers['register'] = function* (
  transport,
  transportCtx,
) {
  const existing = yield* codecGetTransportsHandler()

  let conflict = false
  let reinstall = false
  for (const target of existing) {
    if ((yield* useContext(target)).name !== transportCtx.name) {
      continue
    }

    // the SAME impl under the same name — typically a child scope re-installing a codec its parent
    // already registered — is idempotent; only a DIFFERENT impl claiming the name conflicts
    if (target === transport) {
      reinstall = true
    } else {
      conflict = true
    }
  }

  if (conflict) {
    return yield* fail(
      CodecErrors.AlreadyRegistered,
      `codec ${transportCtx.name} is already registered`,
    )
  }

  // a re-install keeps its single entry but re-sorts it: the new install may carry a new priority
  const entries = reinstall ? existing : [...existing, transport]
  yield* CodecRegistryContext.set(yield* sortedCodecs(entries, transport, transportCtx))
}

export const codecUnregisterHandler: CodecDef.Handlers['unregister'] = function* (transport) {
  const existing = yield* codecGetTransportsHandler()
  const transportCtx = yield* useContext(transport)

  yield* CodecRegistryContext.set(
    yield* filter(existing, function* (target) {
      const targetCtx = yield* useContext(target)

      return targetCtx.name !== transportCtx.name
    }),
  )
}

export const codecGetTransportsHandler: CodecDef.Handlers['getTransports'] = function* () {
  return (yield* CodecRegistryContext.get()) ?? []
}

/**
 * Whether any codec is registered in the CURRENT scope. The registry is a scope-local effect
 * Context (`CodecRegistryContext`, inherited DOWNWARD) — NOT a global table: it reflects the
 * registrations visible in the current scope chain only.
 */
export const codecHasCodecHandler: CodecDef.Handlers['hasCodec'] = function* () {
  return (yield* codecGetTransportsHandler()).length > 0
}

// the frame handlers are generic in the contract (`<T>(…) => Operation<T>`) but hand back either
// the untouched input or the codec's output, so the implementations are written against `unknown`
// and cast to the handler type — `T` is a caller-side annotation, never a runtime guarantee
export const codecEncodeFrameHandler = function* (data: unknown, preferred?: CodecDef) {
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data
  }
  return yield* (preferred ?? Codec).actions.stringify(data)
} as CodecDef.Handlers['encodeFrame']

export const codecDecodeFrameHandler = function* (data: unknown, preferred?: CodecDef) {
  if (typeof data !== 'string') {
    return data
  }
  const trimmed = data.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = yield* attempt((preferred ?? Codec).actions.parse(data))
    return isSuccess(parsed) ? parsed.value : data
  }
  return data
} as CodecDef.Handlers['decodeFrame']

export const codecDecodeFramesHandler = function* (
  source: Subscription<unknown, unknown>,
  preferred?: CodecDef,
) {
  return {
    *next() {
      const item = yield* source.next()
      if (item.done) {
        return item
      }

      return { done: false, value: yield* Codec.actions.decodeFrame(item.value, preferred) }
    },
  }
} as CodecDef.Handlers['decodeFrames']
