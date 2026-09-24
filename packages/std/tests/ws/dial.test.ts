import { run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { WsDef } from 'std:ws'
import { Ws } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { wsMock } from './helpers'

/** What the `impl` constructor received for the last socket: the standard `protocols` second arg
 * or the Bun/Node options-object form. */
type ConstructorArg =
  | string
  | string[]
  | { protocols?: string | string[]; headers?: AnyType; tls?: AnyType }

const constructed: { url: string; arg: ConstructorArg | undefined }[] = []

/** An in-memory socket that opens on a microtask and closes on demand — no network. */
class FakeSocket implements WsDef.SocketLike {
  readyState = 0
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  sent = 0
  onopen: ((event: AnyType) => void) | null = null
  onmessage: ((event: { data: AnyType }) => void) | null = null
  onerror: ((event: AnyType) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null

  constructor(url: string | URL, arg?: ConstructorArg) {
    constructed.push({ url: String(url), arg })
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.({})
    })
  }

  send(): void {
    this.sent += 1
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }))
  }
}

/** Connect once through the fake and hand back what its constructor saw. */
const dialWith = async (options: WsDef.Options) => {
  constructed.length = 0

  const outcome = await run(function* () {
    yield* wsMock(FakeSocket).use()
    const connection = yield* Ws.actions.connect('ws://fake.test/socket', options)
    const readyState = connection.readyState
    yield* connection.close()

    return readyState
  })

  expect(unwrap(outcome)).toBe(1)
  expect(constructed).toHaveLength(1)

  return constructed[0]!
}

describe('dial: constructor arguments', () => {
  it('protocols alone pass as the standard second constructor arg', async () => {
    const seen = await dialWith({ protocols: ['graphql-ws', 'json'] })

    expect(seen.url).toBe('ws://fake.test/socket')
    expect(seen.arg).toEqual(['graphql-ws', 'json'])
  })

  it('a single protocol string passes through untouched', async () => {
    const seen = await dialWith({ protocols: 'graphql-ws' })

    expect(seen.arg).toBe('graphql-ws')
  })

  it('no protocols and no headers → a bare (url) constructor call', async () => {
    const seen = await dialWith({})

    expect(seen.arg).toBeUndefined()
  })

  it('headers produce the Bun/Node options-object form, carrying protocols alongside', async () => {
    const headers = { authorization: 'Bearer token' }
    const seen = await dialWith({ headers, protocols: ['json'] })

    expect(seen.arg).toEqual({ headers, protocols: ['json'] })
  })

  it('headers without protocols produce the options-object form with headers only', async () => {
    const headers = { authorization: 'Bearer token' }
    const seen = await dialWith({ headers })

    expect(seen.arg).toEqual({ headers })
  })

  it('tls alone produces the options-object form carrying only tls', async () => {
    const tls = { ca: 'PEM', rejectUnauthorized: false }
    const seen = await dialWith({ tls })

    expect(seen.arg).toEqual({ tls })
  })

  it('tls rides alongside headers and protocols in the options-object form', async () => {
    const headers = { authorization: 'Bearer token' }
    const tls = { cert: 'CERT', key: 'KEY' }
    const seen = await dialWith({ headers, protocols: 'json', tls })

    expect(seen.arg).toEqual({ headers, protocols: 'json', tls })
  })

  it('in a browser (document + window present) headers are dropped and protocols pass plainly', async () => {
    const globals = globalThis as AnyType
    const hadDocument = 'document' in globals
    const hadWindow = 'window' in globals
    const previousDocument = globals.document
    const previousWindow = globals.window

    globals.document = {}
    globals.window = {}
    try {
      const withProtocols = await dialWith({
        headers: { authorization: 'Bearer token' },
        protocols: ['json'],
      })
      const headersOnly = await dialWith({ headers: { authorization: 'Bearer token' } })
      const tlsOnly = await dialWith({ tls: { rejectUnauthorized: false } })

      expect(withProtocols.arg).toEqual(['json'])
      expect(headersOnly.arg).toBeUndefined()
      expect(tlsOnly.arg).toBeUndefined()
    } finally {
      if (hadDocument) {
        globals.document = previousDocument
      } else {
        delete globals.document
      }
      if (hadWindow) {
        globals.window = previousWindow
      } else {
        delete globals.window
      }
    }
  })
})
