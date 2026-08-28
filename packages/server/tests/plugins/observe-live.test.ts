/**
 * The console's live feed under realtime-socket churn: connecting and disconnecting
 * `/todos/_realtime` — cleanly or ABRUPTLY, mid-handshake — must never end the observe SSE
 * stream or the store behind it. Regression test for the panel's "live → offline" drops.
 */
import { createServer, Observe } from 'server:core'
import { crud, ObservePlugin } from 'server:plugins'
import { fork, run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todosTable } from '../helpers'

// fast keepalives for the suite: the mechanism is the same, the wait is not
process.env['OZACO_SSE_KEEPALIVE_MS'] = '2000'

const CYCLES = 4

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('socket failed to open')))
  })

const nextMessage = (ws: WebSocket): Promise<string> =>
  new Promise(resolve => {
    const listener = (event: MessageEvent) => {
      ws.removeEventListener('message', listener)
      resolve(String(event.data))
    }

    ws.addEventListener('message', listener)
  })

describe('observe — the live feed under socket churn', () => {
  it('survives realtime connect/disconnect cycles, clean and abrupt', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const todos = crud(todosTable)
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [ObservePlugin.use({ console: true, batch: { ms: 10 } })],
        })
        const info = yield* server.start({ port: 0 })
        const base = info.url!
        const wsBase = base.replace('http', 'ws')

        // subscribe the live feed exactly like the console does
        const live = yield* until(fetch(`${base}/_observe/api/live`))
        expect(live.status).toBe(200)
        const reader = live.body!.getReader()
        const decoder = new TextDecoder()
        const seen: AnyType[] = []
        let keepalives = 0
        let liveEnded = false
        let buffer = ''

        yield* fork(function* () {
          for (;;) {
            const step = yield* until(reader.read().catch(() => ({ done: true, value: undefined })))

            if (step.done) {
              liveEnded = true
              return
            }

            buffer += decoder.decode(step.value as Uint8Array, { stream: true })
            let at = buffer.indexOf('\n')

            while (at !== -1) {
              const line = buffer.slice(0, at)
              buffer = buffer.slice(at + 1)

              if (line.startsWith('data: ')) {
                seen.push(...(JSON.parse(line.slice(6)) as AnyType[]))
              } else if (line.startsWith(':')) {
                keepalives += 1
              }

              at = buffer.indexOf('\n')
            }
          }
        })

        const canaries = (): number =>
          seen.filter(row => row.method === 'GET' && row.path === '/todos').length

        for (let cycle = 0; cycle < CYCLES; cycle += 1) {
          // clean cycle: watch → sync → close
          const clean = yield* until(openSocket(`${wsBase}/todos/_realtime`))
          clean.send(JSON.stringify({ t: 'watch', id: `clean-${cycle}` }))
          const sync = yield* until(nextMessage(clean))
          expect(JSON.parse(sync).t).toBe('sync')
          clean.close()

          // abrupt cycle: watch and slam the socket shut before the sync can land
          const abrupt = yield* until(openSocket(`${wsBase}/todos/_realtime`))
          abrupt.send(JSON.stringify({ t: 'watch', id: `abrupt-${cycle}` }))
          abrupt.close()

          // a write while the watcher may be mid-teardown (delta against a closing socket)
          yield* until(
            fetch(`${base}/todos`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: `t${cycle}`, done: false }),
            }),
          )

          yield* sleep(60)

          // the canary: this cycle's list request must still arrive on the live feed
          yield* until(fetch(`${base}/todos?limit=1`))
          const target = cycle + 1
          const deadline = Date.now() + 3000

          // oxlint-disable-next-line no-unmodified-loop-condition -- the pump task flips it
          while (canaries() < target && Date.now() < deadline && !liveEnded) {
            yield* sleep(25)
          }

          expect({ cycle, liveEnded }).toEqual({ cycle, liveEnded: false })
          expect({ cycle, canaries: canaries() >= target }).toEqual({ cycle, canaries: true })
        }

        // a QUIET stretch longer than Bun's default idle timeout (10s): the keepalive
        // comments must keep the connection open — this is exactly the panel scenario
        // (connect a realtime socket, go quiet, watch the console flip offline)
        const idleSocket = yield* until(openSocket(`${wsBase}/todos/_realtime`))
        idleSocket.send(JSON.stringify({ t: 'watch', id: 'idle' }))
        yield* until(nextMessage(idleSocket))
        const keepalivesBefore = keepalives
        yield* sleep(12_000)
        idleSocket.close()
        expect(liveEnded).toBe(false)
        expect(keepalives).toBeGreaterThan(keepalivesBefore)

        // and rows still arrive after the quiet
        const before = canaries()
        yield* until(fetch(`${base}/todos?limit=1`))
        const deadline = Date.now() + 3000

        // oxlint-disable-next-line no-unmodified-loop-condition -- the pump task flips it
        while (canaries() <= before && Date.now() < deadline && !liveEnded) {
          yield* sleep(25)
        }

        expect(liveEnded).toBe(false)
        expect(canaries()).toBeGreaterThan(before)

        // the store itself must still answer too
        const page = yield* Observe.actions.query({})
        expect(page.requests.length).toBeGreaterThan(0)

        yield* until(reader.cancel().catch(() => {}))
        yield* server.stop()
      }),
    )
  }, 40_000)
})
