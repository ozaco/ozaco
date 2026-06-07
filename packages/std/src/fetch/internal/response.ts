import { Codec, hasCodec, JsonCodec } from 'std:codec'
import type { Stream } from 'std:effect'
import { operation, stream, until } from 'std:effect'
import { install } from 'std:plugin'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { FetchDef } from '../types'

import { errorMessage } from './common'

export const createFetchResponse = (raw: Response): FetchDef.Response => {
  const readJson = operation(function* <T>() {
    try {
      return (yield* until(raw.json())) as T
    } catch (error) {
      return yield* fail(
        'parse',
        `${raw.url}: json parse failed: ${errorMessage(asFailure(error))}`,
      )
    }
  })

  const readText = operation(function* () {
    try {
      return yield* until(raw.text())
    } catch (error) {
      return yield* fail('parse', `${raw.url}: text read failed: ${errorMessage(asFailure(error))}`)
    }
  })

  const readArrayBuffer = operation(function* () {
    try {
      return yield* until(raw.arrayBuffer())
    } catch (error) {
      return yield* fail(
        'parse',
        `${raw.url}: arrayBuffer read failed: ${errorMessage(asFailure(error))}`,
      )
    }
  })

  const readBlob = operation(function* () {
    try {
      return yield* until(raw.blob())
    } catch (error) {
      return yield* fail('parse', `${raw.url}: blob read failed: ${errorMessage(asFailure(error))}`)
    }
  })

  const readFormData = operation(function* () {
    try {
      return yield* until(raw.formData())
    } catch (error) {
      return yield* fail(
        'parse',
        `${raw.url}: formData read failed: ${errorMessage(asFailure(error))}`,
      )
    }
  })

  const readBytes = operation(function* () {
    try {
      const buf = yield* until(raw.arrayBuffer())
      return new Uint8Array(buf)
    } catch (error) {
      return yield* fail(
        'parse',
        `${raw.url}: bytes read failed: ${errorMessage(asFailure(error))}`,
      )
    }
  })

  // a codec is needed to decode body()/stream(); auto-install JsonCodec when the consumer hasn't
  // installed one (the server broker installs its own first, so this is a no-op there).
  const ensureCodec = operation(function* () {
    if (!(yield* hasCodec())) {
      yield* install(JsonCodec)
    }
  })

  const readRaw = operation(function* () {
    if (!raw.body) {
      return yield* fail('parse', 'response has no body')
    }

    return stream(raw.body as AnyType) as Stream<Uint8Array, void>
  })

  const readBody = operation(function* () {
    yield* ensureCodec()

    const bytes = yield* readBytes()
    return bytes.length > 0 ? yield* Codec.actions.decode(bytes) : undefined
  })

  const readStream = operation(function* () {
    yield* ensureCodec()

    if (!raw.body) {
      return yield* fail('parse', 'response has no body')
    }

    return yield* Codec.actions.decodeStream(stream(raw.body as AnyType), true)
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
