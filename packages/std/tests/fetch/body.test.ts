import { run } from 'std:effect'
import { Fetch, FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { afterAll, describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

const encoder = new TextEncoder()

const TEXT_BODY = 'merhaba dünya — çok güzel'
const JSON_BODY = { kind: 'greeting', text: 'merhaba', n: 42 }

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)

    if (pathname === '/text') {
      return new Response(TEXT_BODY, { headers: { 'content-type': 'text/plain;charset=utf-8' } })
    }

    if (pathname === '/json') {
      return Response.json(JSON_BODY)
    }

    if (pathname === '/empty') {
      return new Response('')
    }

    return new Response('fallthrough')
  },
})

const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

describe('platform body readers', () => {
  it('json<T>() parses a JSON body', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/json`)
      return yield* response.json<typeof JSON_BODY>()
    })

    expect(unwrap(outcome)).toEqual(JSON_BODY)
  })

  it('text() returns the exact UTF-8 body', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/text`)
      return yield* response.text()
    })

    expect(unwrap(outcome)).toBe(TEXT_BODY)
  })

  it('bytes(), arrayBuffer(), and blob() expose the same raw payload', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const bytesResponse = yield* Fetch.actions.get(`${base}/text`)
      const bytes = yield* bytesResponse.bytes()
      const bufferResponse = yield* Fetch.actions.get(`${base}/text`)
      const buffer = yield* bufferResponse.arrayBuffer()
      const blobResponse = yield* Fetch.actions.get(`${base}/text`)
      const blob = yield* blobResponse.blob()

      return {
        bytes,
        bufferLength: buffer.byteLength,
        blobSize: blob.size,
        blobType: blob.type,
      }
    })

    const expected = encoder.encode(TEXT_BODY)
    expect(unwrap(outcome)).toEqual({
      bytes: expected,
      bufferLength: expected.byteLength,
      blobSize: expected.byteLength,
      blobType: 'text/plain;charset=utf-8',
    })
  })
})

describe('codec-backed body()', () => {
  it('decodes the whole payload through the installed codec', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)
      yield* install(JsonCodec)

      const response = yield* Fetch.actions.get(`${base}/json`)
      return yield* response.body<typeof JSON_BODY>()
    })

    expect(unwrap(outcome)).toEqual(JSON_BODY)
  })

  it('without any installed codec it fails with missing-action', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/json`)
      return yield* response.body()
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('missing-action')
    }
  })
})

describe('empty bodies', () => {
  it('body() resolves to undefined instead of asking the codec to decode nothing', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)
      yield* install(JsonCodec)

      const response = yield* Fetch.actions.get(`${base}/empty`)

      return {
        value: yield* response.body(),
      }
    })

    expect(unwrap(outcome)).toEqual({ value: undefined })
  })

  it('json() on an empty body resolves to null under Bun', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/empty`)
      return yield* response.json()
    })

    expect(unwrap(outcome)).toBeNull()
  })
})
