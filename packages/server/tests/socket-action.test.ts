/**
 * `action.socket`: a socket declared INSIDE a service — default `/<service>/<action>` path,
 * mounted by the edge with everything else, listed under the service in the manifest, absent
 * from the callable api.
 */
import { action, createServer, service } from 'server:core'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from './helpers'

const echo = service('echo', {
  ping: action.query({ output: z.object({ pong: z.boolean() }) }, function* () {
    return { pong: true }
  }),
  room: action.socket(
    { protocol: 'chat', description: 'echoes every frame back, uppercased' },
    function* (socket) {
      yield* socket.send({ t: 'hello' })
      const messages = yield* socket.messages

      for (;;) {
        const step = yield* messages.next()

        if (step.done) {
          return
        }

        const text = String((step.value as { text?: unknown })?.text ?? '')
        yield* socket.send({ t: 'echo', text: text.toUpperCase() })
      }
    },
  ),
})

describe('action.socket', () => {
  it('mounts at /<service>/<action>, talks, and stays out of the callable api', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [echo], edge: BunEdge })
        const info = yield* server.listen({ port: 0 })

        // the manifest lists it under the service
        const manifest = yield* server.manifest()
        expect(manifest.actions.map(entry => `${entry.service}.${entry.action}`)).toEqual([
          'echo.ping',
        ])

        // the socket is not a callable action
        expect('room' in (server.api.echo as Record<string, unknown>)).toBe(false)

        // it talks
        const ws = new WebSocket(`${info.url!.replace('http', 'ws')}/echo/room`)
        const frames: string[] = []

        yield* until(
          new Promise<void>((resolve, reject) => {
            ws.addEventListener('message', event => {
              frames.push(String(event.data))

              if (frames.length === 1) {
                ws.send(JSON.stringify({ text: 'selam' }))
              }

              if (frames.length === 2) {
                ws.close()
                resolve()
              }
            })
            ws.addEventListener('error', () => reject(new Error('socket error')))
          }),
        )

        expect(JSON.parse(frames[0]!)).toEqual({ t: 'hello' })
        expect(JSON.parse(frames[1]!)).toEqual({ t: 'echo', text: 'SELAM' })
        yield* server.stop()
      }),
    )
  })
})
