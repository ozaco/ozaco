import type { CodecDef } from 'std:codec'
import { run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import type { WsDef } from 'std:ws'
import { Ws } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { fakeCodec } from '../helpers/fake-codec'

import { echoServer, pushServer } from './helpers'

const fake = fakeCodec('FAKE')
const noisy = fakeCodec('NOISY')

/** Installs Ws (with optional install-wide defaults), JsonCodec, and FAKE. */
function* bootstrap(defaults?: WsDef.Options) {
  yield* install(Ws, defaults)
  yield* install(JsonCodec) // priority 999 — the routed Codec protocol would pick this
  yield* install(fake) // priority 500
}

describe('install-wide codec default', () => {
  it('install(Ws, { codec }) applies to every connect; a per-connect codec overrides it', async () => {
    const server = echoServer()
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ codec: fake })

          // no per-connect option → the install-wide default frames the message
          const defaulted = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
          const defaultedSub = yield* defaulted.messages
          yield* defaulted.send({ n: 1 })
          const viaDefault = yield* defaultedSub.next()

          // per-connect codec overrides the install default: JSON text echoes back and parses
          const pinned = yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            codec: JsonCodec,
          })
          const pinnedSub = yield* pinned.messages
          yield* pinned.send({ n: 2 })
          const viaOverride = yield* pinnedSub.next()

          return { viaDefault: viaDefault.value, viaOverride: viaOverride.value }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        viaDefault: 'FAKE:{"n":1}',
        viaOverride: { n: 2 },
      })
    } finally {
      server.stop(true)
    }
  })
})

describe('connect codec option', () => {
  it('encoding goes through the preferred codec even when routing would pick another', async () => {
    const server = echoServer()
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap()

          const conn = yield* Ws.actions.connect(`ws://localhost:${server.port}`, {
            codec: fake,
          })
          const subscription = yield* conn.messages

          yield* conn.send({ n: 1 })
          const echoed = yield* subscription.next()

          // the echoed text frame starts with 'FAKE:' (not '{'), so it passes through raw —
          // visible proof the PREFERRED codec encoded it, not the higher-priority JsonCodec
          return echoed.value
        }),
      )

      expect(unwrap(outcome)).toBe('FAKE:{"n":1}')
    } finally {
      server.stop(true)
    }
  })

  it('decoding uses the preferred codec; without the option the routed one applies', async () => {
    const readFirst = (server: ReturnType<typeof pushServer>, codec?: CodecDef) =>
      run(() =>
        scoped(function* () {
          yield* install(Ws)
          yield* install(JsonCodec)
          // outranks JsonCodec, so the ROUTED protocol picks it — and its parse mangles plain JSON
          yield* install(noisy, { priority: 1500 })

          const conn = yield* Ws.actions.connect(
            `ws://localhost:${server.port}`,
            codec ? { codec } : {},
          )
          const subscription = yield* conn.messages
          const first = yield* subscription.next()

          return first.value
        }),
      )

    const preferred = pushServer('{"n":7}')
    try {
      // with the option: parsed by JsonCodec into the object
      expect(unwrap(await readFirst(preferred, JsonCodec))).toEqual({ n: 7 })
    } finally {
      preferred.stop(true)
    }

    const routed = pushServer('{"n":7}')
    try {
      // without it: the routed NOISY codec fails to parse and the frame degrades to the raw string
      expect(unwrap(await readFirst(routed))).toBe('{"n":7}')
    } finally {
      routed.stop(true)
    }
  })
})
