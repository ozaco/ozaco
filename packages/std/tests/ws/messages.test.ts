import { attempt, run, scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import { Ws } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { echoServer, pushServer } from './helpers'

describe('messages flow', () => {
  it('round-trips a structured value through the codec (send → echo → decoded)', async () => {
    const server = echoServer()
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(JsonCodec)
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
          yield* connection.send({ kind: 'greeting', text: 'hello', n: 42 })

          const subscription = yield* connection.messages
          const first = yield* subscription.next()
          yield* connection.close()

          return first.done ? 'closed-early' : first.value
        }),
      )

      expect(unwrap(outcome)).toEqual({ kind: 'greeting', text: 'hello', n: 42 })
    } finally {
      server.stop(true)
    }
  })

  it('delivers multiple sequential messages in send order', async () => {
    const server = echoServer()
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        yield* connection.send({ seq: 1 })
        yield* connection.send(['two', 2])
        yield* connection.send({ seq: 3 })

        const subscription = yield* connection.messages
        const values = [
          (yield* subscription.next()).value,
          (yield* subscription.next()).value,
          (yield* subscription.next()).value,
        ]
        yield* connection.close()

        return values
      })

      expect(unwrap(outcome)).toEqual([{ seq: 1 }, ['two', 2], { seq: 3 }])
    } finally {
      server.stop(true)
    }
  })

  it('buffers frames that arrive before anyone consumes the flow', async () => {
    const server = pushServer(
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: 2 }),
      JSON.stringify({ n: 3 }),
    )
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        // let the pushed frames land while nobody is subscribed — queue-backed, so nothing drops
        yield* sleep(50)

        const subscription = yield* connection.messages
        const values = [
          (yield* subscription.next()).value,
          (yield* subscription.next()).value,
          (yield* subscription.next()).value,
        ]
        yield* connection.close()

        return values
      })

      expect(unwrap(outcome)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    } finally {
      server.stop(true)
    }
  })

  it('passes non-structured frames through untouched (text, invalid JSON, binary)', async () => {
    const server = pushServer('plain text', '{broken json', new Uint8Array([7, 8, 9]))
    try {
      const outcome = await run(function* () {
        yield* install(JsonCodec)
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        const subscription = yield* connection.messages

        const text = (yield* subscription.next()).value
        // looks structured, fails to parse → degrades to the raw string
        const broken = (yield* subscription.next()).value
        const binary = (yield* subscription.next()).value
        yield* connection.close()

        return {
          text,
          broken,
          isArrayBuffer: binary instanceof ArrayBuffer,
          bytes: [...new Uint8Array(binary as ArrayBuffer)],
        }
      })

      expect(unwrap(outcome)).toEqual({
        text: 'plain text',
        broken: '{broken json',
        isArrayBuffer: true,
        bytes: [7, 8, 9],
      })
    } finally {
      server.stop(true)
    }
  })
})

describe('codec dependency', () => {
  it('sending a structured value with no codec in scope fails', async () => {
    const server = echoServer()
    try {
      const outcome = await run(function* () {
        yield* install(Ws)

        const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
        const sent = yield* attempt(() => connection.send({ needs: 'codec' }))
        yield* connection.close()

        return isFailure(sent) ? String(sent.error) : 'sent'
      })

      expect(unwrap(outcome)).toBe('missing-action')
    } finally {
      server.stop(true)
    }
  })

  it('receiving structured text with no codec in scope degrades to the raw string', async () => {
    const server = pushServer('{"n":1}')
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* install(Ws)

          const connection = yield* Ws.actions.connect(`ws://localhost:${server.port}`)
          const subscription = yield* connection.messages
          const first = yield* subscription.next()
          yield* connection.close()

          return first.value
        }),
      )

      expect(unwrap(outcome)).toBe('{"n":1}')
    } finally {
      server.stop(true)
    }
  })
})
