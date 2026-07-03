import type { Stream } from 'std:effect'
import { operation, stream, until } from 'std:effect'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import type { FetchDef } from '../types'

export const createFetchResponse = (raw: Response): FetchDef.Response => {
  const readJson = operation(function* <T>() {
    try {
      return (yield* until(raw.json())) as T
    } catch (error) {
      return yield* asFailure(error)
    }
  })

  const readText = operation(function* () {
    try {
      return yield* until(raw.text())
    } catch (error) {
      return yield* asFailure(error)
    }
  })

  const readArrayBuffer = operation(function* () {
    try {
      return yield* until(raw.arrayBuffer())
    } catch (error) {
      return yield* asFailure(error)
    }
  })

  const readBlob = operation(function* () {
    try {
      return yield* until(raw.blob())
    } catch (error) {
      return yield* asFailure(error)
    }
  })

  const readFormData = operation(function* () {
    try {
      return yield* until(raw.formData())
    } catch (error) {
      return yield* asFailure(error)
    }
  })

  const readBytes = operation(function* () {
    try {
      const buf = yield* until(raw.arrayBuffer())
      return new Uint8Array(buf)
    } catch (error) {
      return yield* asFailure(error)
    }
  })

  const readRaw = operation(function* () {
    if (!raw.body) {
      return yield* fail('parse', 'response has no body')
    }

    return stream(raw.body as AnyType) as Stream<Uint8Array, void>
  })

  const readBody = operation(function* () {
    const bytes = yield* readBytes()
    return bytes.length > 0 ? yield* JsonCodec.actions.decode(bytes) : undefined
  })

  const readStream = operation(function* () {
    if (!raw.body) {
      return yield* fail('parse', 'response has no body')
    }

    return yield* JsonCodec.actions.decodeStream(stream(raw.body as AnyType), true)
  })

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
    stream: readStream as AnyType,
    raw: readRaw,
    expect: operation(function* () {
      yield* until(Promise.resolve())
      if (!raw.ok) {
        return yield* fail('http-status', `${raw.url}: ${raw.status} ${raw.statusText}`)
      }
      return self
    }),
  }
  return self
}
