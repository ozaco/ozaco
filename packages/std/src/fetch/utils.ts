import type { CodecDef } from 'std:codec'
import { Codec } from 'std:codec'
import type { Flow, Operation } from 'std:effect'
import { flow, until } from 'std:effect'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { FetchDef } from './types'

/** Wrap a platform `Response`. A `preferred` codec impl pins `body()`/`flow()` decoding to that
 * implementation instead of the routed `Codec` protocol (it must still be installed in scope). */
export const createFetchResponse = (raw: Response, preferred?: CodecDef): FetchDef.Response => {
  function* readJson<T>(): Operation<T> {
    try {
      return (yield* until(raw.json())) as T
    } catch (error) {
      return yield* asFailure(error)
    }
  }

  function* readText() {
    try {
      return yield* until(raw.text())
    } catch (error) {
      return yield* asFailure(error)
    }
  }

  function* readArrayBuffer() {
    try {
      return yield* until(raw.arrayBuffer())
    } catch (error) {
      return yield* asFailure(error)
    }
  }

  function* readBlob() {
    try {
      return yield* until(raw.blob())
    } catch (error) {
      return yield* asFailure(error)
    }
  }

  function* readFormData() {
    try {
      return yield* until(raw.formData())
    } catch (error) {
      return yield* asFailure(error)
    }
  }

  function* readBytes() {
    try {
      const buf = yield* until(raw.arrayBuffer())
      return new Uint8Array(buf)
    } catch (error) {
      return yield* asFailure(error)
    }
  }

  function* readRaw() {
    if (!raw.body) {
      return yield* fail('parse', 'response has no body')
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
      return yield* fail('parse', 'response has no body')
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
    json: <T = unknown>() => readJson<T>(),
    text: readText,
    arrayBuffer: readArrayBuffer,
    blob: readBlob,
    formData: readFormData,
    bytes: readBytes,
    body: readBody as AnyType,
    flow: readFlow as AnyType,
    raw: readRaw,

    *expect() {
      yield* until(Promise.resolve())
      if (!raw.ok) {
        return yield* fail('http-status', `${raw.url}: ${raw.status} ${raw.statusText}`)
      }
      return self
    },
  }
  return self
}
