import type { CodecDef } from 'std:codec'
import { Codec } from 'std:codec'
import type { Flow, Operation } from 'std:effect'
import { flow, until } from 'std:effect'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { FetchErrors } from '../errors'
import type { FetchDef } from '../types'

/** Lift one platform body reader into an Operation; a thrown read error is reified as-is. */
const reader = <T>(read: () => Promise<T>) =>
  function* (): Operation<T> {
    try {
      return yield* until(read())
    } catch (error) {
      return yield* asFailure(error)
    }
  }

/**
 * Wrap a platform `Response`. A `preferred` codec impl pins `body()`/`flow()` decoding to that
 * implementation instead of the routed `Codec` protocol (it must still be installed in scope).
 */
export const createFetchResponse = (raw: Response, preferred?: CodecDef): FetchDef.Response => {
  const readBytes = reader(() => raw.arrayBuffer().then(buffer => new Uint8Array(buffer)))

  function* readRaw() {
    if (!raw.body) {
      return yield* fail(FetchErrors.Parse, 'response has no body')
    }

    return flow(raw.body as AnyType) as Flow<Uint8Array, void>
  }

  function* readBody() {
    const bytes = yield* readBytes()
    if (bytes.length === 0) {
      return undefined
    }

    return yield* (preferred ?? Codec).actions.decode(bytes)
  }

  function* readFlow() {
    if (!raw.body) {
      return yield* fail(FetchErrors.Parse, 'response has no body')
    }

    return yield* (preferred ?? Codec).actions.decodeFlow(flow(raw.body as AnyType), true)
  }

  const self: FetchDef.Response = {
    native: raw,

    get ok() {
      return raw.ok
    },
    get status() {
      return raw.status
    },
    get statusText() {
      return raw.statusText
    },
    get headers() {
      return raw.headers
    },
    get url() {
      return raw.url
    },
    get redirected() {
      return raw.redirected
    },
    get bodyUsed() {
      return raw.bodyUsed
    },
    get type() {
      return raw.type
    },

    json: <T = unknown>() => reader(() => raw.json() as Promise<T>)(),
    text: reader(() => raw.text()),
    arrayBuffer: reader(() => raw.arrayBuffer()),
    blob: reader(() => raw.blob()),
    formData: reader(() => raw.formData()),
    bytes: readBytes,
    body: readBody as AnyType,
    flow: readFlow as AnyType,
    raw: readRaw,

    *expect() {
      if (!raw.ok) {
        return yield* fail(FetchErrors.HttpStatus, `${raw.url}: ${raw.status} ${raw.statusText}`)
      }

      return self
    },
  }

  return self
}
