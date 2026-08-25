import { run } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'
import { Rtc } from 'std:webrtc'

import { afterAll, describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { createSignalPair } from './fake'

// The REAL leg: no `rtcImpl` override, so `connect` exercises the Bun/Node auto-import of the
// optional `node-datachannel` polyfill (installed as a dev dependency in this repo). Skips
// cleanly when the native module is unavailable. The specifiers stay variables so tsc never
// resolves the package's own (DOM-lib-conflicting) type declarations.
const polyfillSpecifier = 'node-datachannel/polyfill'
const polyfill = await import(polyfillSpecifier).catch(() => undefined)

afterAll(async () => {
  if (polyfill) {
    // libdatachannel keeps worker threads alive — without this the test process never exits
    const nativeSpecifier = 'node-datachannel'
    const native = (await import(nativeSpecifier)) as { cleanup?: () => void }
    native.cleanup?.()
  }
})

describe.skipIf(!polyfill)('webrtc over node-datachannel (auto-import)', () => {
  it('connects two real loopback peers and exchanges frames', async () => {
    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Rtc)

      const [signalA, signalB] = createSignalPair()
      const peerA = yield* Rtc.actions.connect(signalA)
      const peerB = yield* Rtc.actions.connect(signalB, { polite: true })

      const chatA = yield* peerA.channel('e2e', { openTimeoutMs: 15_000 })
      const channelsB = yield* peerB.channels
      const emitted = yield* channelsB.next()
      if (emitted.done) {
        return 'channels flow closed early'
      }
      const chatB = emitted.value

      yield* chatA.send({ ping: 1 })
      yield* chatB.send('pong')

      const messagesB = yield* chatB.messages
      const messagesA = yield* chatA.messages
      const structured = yield* messagesB.next()
      const text = yield* messagesA.next()

      yield* peerA.close()
      yield* peerB.close()

      return {
        structured: structured.done ? 'closed' : structured.value,
        text: text.done ? 'closed' : text.value,
      }
    })

    expect(unwrap(outcome)).toEqual({ structured: { ping: 1 }, text: 'pong' })
  }, 30_000)
})
