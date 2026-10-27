import { action, service } from 'server:core'
import { Proxy } from 'server:plugins'
import { TestNode } from 'server:testing'
import { run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { Ws, WsClient } from 'std:ws'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'
import { z } from 'zod'

// `Proxy.use({ prefix, target })`: HTTP under the prefix forwarded as is, sockets bridged.

const things = service('things', {
  list: action.query({ output: z.array(z.string()) }, function* () {
    return ['a', 'b']
  }),
  create: action.mutation(
    { input: z.object({ title: z.string() }), output: z.object({ id: z.string() }) },
    function* ({ input }) {
      return { id: `t-${input.title}` }
    },
  ),
  seen: action.query(
    { output: z.object({ host: z.string(), extra: z.string() }) },
    function* ({ ctx }) {
      return { host: ctx.headers['x-forwarded-host'] ?? '', extra: ctx.headers['x-extra'] ?? '' }
    },
  ),
  echo: action.socket({}, function* (socket) {
    const feed = yield* socket.messages

    for (;;) {
      const step = yield* feed.next()

      if (step.done) {
        return
      }

      yield* socket.send({ echoed: step.value })
    }
  }),
})

describe('proxy plugin', () => {
  it('forwards every method under the prefix with the query, the body and the forwarding headers', async () => {
    unwrap(
      await run(function* () {
        const upstream = yield* TestNode.use({ services: [things], name: 'upstream' })
        const front = yield* TestNode.use({
          services: [],
          name: 'front',
          plugins: [
            Proxy.use({ prefix: '/api/', target: upstream.url, headers: { 'x-extra': 'yes' } }),
          ],
        })

        const listed = yield* front.json('/api/things/list')

        expect(listed.status).toBe(200)
        expect(listed.body).toEqual(['a', 'b'])

        const created = yield* front.json('/api/things/create', { body: { title: 'one' } })

        expect(created.status).toBe(200)
        expect(created.body).toEqual({ id: 't-one' })

        const seen = yield* front.json('/api/things/seen')

        expect(seen.body).toEqual({ host: new URL(front.url).host, extra: 'yes' })

        // the upstream's own answer for an unknown route passes through
        const missing = yield* front.json('/api/nothing/here')

        expect(missing.status).toBe(404)

        // outside the prefix the front answers itself
        const own = yield* front.json('/things/list')

        expect(own.status).toBe(404)

        yield* front.stop()
        yield* upstream.stop()
      }),
    )
  })

  it('bridges a socket under the prefix frame by frame', async () => {
    unwrap(
      await run(function* () {
        const upstream = yield* TestNode.use({ services: [things], name: 'upstream' })
        const front = yield* TestNode.use({
          services: [],
          name: 'front',
          plugins: [Proxy.use({ prefix: '/api', target: upstream.url })],
        })

        // the test's own dial: a codec and a ws client in the TEST scope (each node has its own)
        yield* JsonCodec.use()

        if (!(yield* Ws.context.get())) {
          yield* WsClient.use()
        }

        const socket = yield* Ws.actions.connect(
          `${front.url.replace(/^http/u, 'ws')}/api/things/echo`,
        )
        const feed = yield* socket.messages

        yield* socket.send({ hello: 1 })

        const first = yield* feed.next()

        expect((first as AnyType).value).toEqual({ echoed: { hello: 1 } })

        yield* socket.close()
        yield* front.stop()
        yield* upstream.stop()
      }),
    )
  })

  it('an upstream that does not answer is 503 server.unavailable', async () => {
    unwrap(
      await run(function* () {
        const front = yield* TestNode.use({
          services: [],
          plugins: [Proxy.use({ prefix: '/api', target: 'http://127.0.0.1:1', ws: false })],
        })

        const reply = yield* front.json('/api/things/list')

        expect(reply.status).toBe(503)
        expect((reply.body as AnyType).error.error).toBe('server.unavailable')

        yield* front.stop()
      }),
    )
  })
})
