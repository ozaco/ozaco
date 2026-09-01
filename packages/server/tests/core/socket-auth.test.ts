/**
 * A socket handshake must always SETTLE — a refused token can never leave the client sitting on
 * an open socket. Every shape of a failing handshake is bounded here: a wrong token in the first
 * frame closes AT ONCE (4401, far inside the grace), a silent token-less connection closes when
 * the grace expires, a non-auth first frame buys no extra time, and a bad `authorization` header
 * is refused at the upgrade. None of them reaches the handler.
 */
import { action, createServer, ServerErrors, service } from 'server:core'
import type { Operation } from 'std:effect'
import { race, run, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

/** `SOCKET_AUTH_GRACE_MS` (server:core const): how long a deferred handshake waits for its
 * first `{ t: 'auth' }` frame before the missing token settles the verdict. */
const GRACE_MS = 2000

/** Far past every bound below: whatever is still unsettled here is a HANG. */
const HANG_MS = 8000

const GOOD = 'good-token'

interface Settled {
  /** `message` = the handler answered (the session is live), `closed`/`error` = it ended. */
  readonly outcome: 'message' | 'closed' | 'error'
  readonly code: number | null
  readonly ms: number
  readonly frames: readonly unknown[]
}

/** Dial the socket, optionally send an opening frame, and report HOW the session settled and
 * how long that took. It never resolves by itself — silence here is a hang. */
const dial = (
  url: string,
  opening?: unknown,
  headers?: Readonly<Record<string, string>>,
): Promise<Settled> =>
  new Promise(resolve => {
    const startedAt = Date.now()
    const frames: unknown[] = []
    const ws = headers ? new WebSocket(url, { headers } as AnyType) : new WebSocket(url)
    const settle = (outcome: Settled['outcome'], code: number | null) =>
      resolve({ outcome, code, ms: Date.now() - startedAt, frames })

    ws.addEventListener('open', () => {
      if (opening !== undefined) {
        ws.send(JSON.stringify(opening))
      }
    })

    ws.addEventListener('message', event => {
      frames.push(JSON.parse(String(event.data)))
      ws.close()
      settle('message', null)
    })

    // a rejected upgrade surfaces as an error in bun; an in-band rejection as a close code
    ws.addEventListener('error', () => settle('error', null))
    ws.addEventListener('close', event => settle('closed', event.code))
  })

/** The probe, with a hard deadline: `'hung'` is a first-class outcome so a stuck handshake
 * fails with what actually went wrong instead of timing the whole test out. */
const probe = (...args: Parameters<typeof dial>): Operation<Settled | 'hung'> =>
  race([
    (function* (): Operation<Settled | 'hung'> {
      return yield* until(dial(...args))
    })(),
    (function* (): Operation<Settled | 'hung'> {
      yield* sleep(HANG_MS)
      return 'hung'
    })(),
  ])

/** A first-frame-authorized socket plus the counters proving where each handshake stopped. */
const boot = function* () {
  const seen = { tokens: [] as (string | undefined)[], handlers: 0, principals: [] as unknown[] }
  const guarded = service('guarded', {
    feed: action.socket(
      {
        authorizeMode: 'first-frame',
        sends: z.object({ t: z.literal('hello') }),

        // the header path (non-browser clients) and the in-band path share ONE seam
        *authorize(request, token) {
          const bearer =
            token ?? request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? undefined
          seen.tokens.push(bearer)

          if (bearer !== GOOD) {
            return yield* fail(ServerErrors.Unauthorized, 'bad token')
          }

          return { sub: 'u-ada' }
        },
      },
      function* (socket) {
        seen.handlers += 1
        seen.principals.push(socket.ctx.auth)
        yield* socket.send({ t: 'hello' })
        const messages = yield* socket.messages

        for (;;) {
          const step = yield* messages.next()

          if (step.done) {
            return
          }
        }
      },
    ),
  })

  yield* storage()
  const server = yield* createServer({ services: [guarded], edge: BunEdge })
  const info = yield* server.start({ port: 0 })

  return { server, seen, url: `${info.url!.replace('http', 'ws')}/guarded/feed` }
}

describe('socket auth — a failing handshake never hangs', () => {
  it('a wrong token in the first frame closes at once, far inside the grace', async () => {
    unwrap(
      await run(function* () {
        const { server, seen, url } = yield* boot()

        const settled = yield* probe(url, { t: 'auth', token: 'garbage' })

        expect(settled).not.toBe('hung')
        const result = settled as Settled
        // the verdict rides the frame — waiting the grace out would be a 2s stall
        expect(result.ms).toBeLessThan(GRACE_MS / 2)
        expect(result.outcome).toBe('closed')
        expect(result.code).toBe(4401)
        expect(result.frames).toEqual([])
        // rejected before the handler ever started
        expect(seen.handlers).toBe(0)
        expect(seen.tokens).toEqual(['garbage'])

        yield* server.stop()
      }),
    )
  }, 15_000)

  it('a silent token-less connection closes when the grace expires — bounded, not forever', async () => {
    unwrap(
      await run(function* () {
        const { server, seen, url } = yield* boot()

        // connect and say NOTHING: the grace is the only thing that can settle this
        const settled = yield* probe(url)

        expect(settled).not.toBe('hung')
        const result = settled as Settled
        expect(result.outcome).toBe('closed')
        expect(result.code).toBe(4401)
        // it waits for the token it was promised…
        expect(result.ms).toBeGreaterThan(GRACE_MS / 2)
        // …and then gives up well inside the deadline
        expect(result.ms).toBeLessThan(GRACE_MS * 3)
        expect(seen.tokens).toEqual([undefined])
        expect(seen.handlers).toBe(0)

        yield* server.stop()
      }),
    )
  }, 15_000)

  it('a non-auth first frame settles the verdict immediately — no free grace', async () => {
    unwrap(
      await run(function* () {
        const { server, seen, url } = yield* boot()

        // a client that opens with a watch instead of a token is answered right away
        const settled = yield* probe(url, { t: 'watch', id: 'w1' })

        expect(settled).not.toBe('hung')
        const result = settled as Settled
        expect(result.outcome).toBe('closed')
        expect(result.code).toBe(4401)
        expect(result.ms).toBeLessThan(GRACE_MS / 2)
        expect(seen.handlers).toBe(0)

        yield* server.stop()
      }),
    )
  }, 15_000)

  it('a bad authorization header is refused at the upgrade, not left dangling', async () => {
    unwrap(
      await run(function* () {
        const { server, seen, url } = yield* boot()

        // a header-carrying client never gets the deferred path: the upgrade itself is rejected
        const settled = yield* probe(url, undefined, { authorization: 'Bearer garbage' })

        expect(settled).not.toBe('hung')
        const result = settled as Settled
        expect(result.outcome).not.toBe('message')
        expect(result.ms).toBeLessThan(GRACE_MS / 2)
        expect(seen.tokens).toEqual(['garbage'])
        expect(seen.handlers).toBe(0)

        yield* server.stop()
      }),
    )
  }, 15_000)

  it('a valid token opens the session — and the auth frame stays out of the handler', async () => {
    unwrap(
      await run(function* () {
        const { server, seen, url } = yield* boot()

        const settled = yield* probe(url, { t: 'auth', token: GOOD })

        expect(settled).not.toBe('hung')
        const result = settled as Settled
        expect(result.outcome).toBe('message')
        expect(result.ms).toBeLessThan(GRACE_MS / 2)
        expect(result.frames).toEqual([{ t: 'hello' }])
        // the handshake's verdict IS the socket principal
        expect(seen.handlers).toBe(1)
        expect(seen.principals).toEqual([{ sub: 'u-ada' }])

        yield* server.stop()
      }),
    )
  }, 15_000)
})
