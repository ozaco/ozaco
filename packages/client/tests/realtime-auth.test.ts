/**
 * A watch the server REFUSES must come back as a FAILURE — never as silence. Two paths reach
 * that refusal: a non-browser client presents its bearer as a header and the upgrade itself is
 * rejected; a browser (and any token-less client) is accepted and then closed with 4401 once the
 * first-frame grace passes. Both have to settle the flow: reconnecting into a handshake that
 * will always be refused hangs the caller forever.
 */
import { ClientErrors, createClient } from 'client:core'
import { column, DbClient, table } from 'db:core'
import { createServer } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, crud, Docs } from 'server:plugins'
import type { Operation } from 'std:effect'
import { attempt, race, run, scoped, sleep } from 'std:effect'
import type { Result } from 'std:result'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'

/** Well past the first-frame grace (2s) plus any redial the client may reasonably attempt. */
const HANG_MS = 10_000

const notesTable = table('notes', { title: column.text() })

const provider = (): AuthDef.Provider => ({
  *authenticate(credentials) {
    return credentials['user'] === 'ada' ? { sub: 'u-ada', roles: ['admin'] } : undefined
  },

  *loadUser(sub) {
    return sub === 'u-ada' ? { sub, roles: ['admin'] } : undefined
  },
})

/** A server whose notes resource is readable by authenticated users only. */
function* boot(): Operation<string> {
  yield* MemoryAdapter.use()
  yield* BunIO.use()
  yield* DbClient.use({ tables: [notesTable] })
  yield* MemoryKv.use()
  const server = yield* createServer({
    services: [crud(notesTable, { auth: { read: 'user', write: 'user' } })],
    edge: BunEdge,
    plugins: [Auth.use({ provider: provider(), secret: 'test-secret' }), Docs],
  })
  const info = yield* server.start({ port: 0 })

  return info.url!
}

/** Open a watch with the given token and report how the FIRST frame settled — `'hung'` when
 * nothing settled at all, so a stuck watch fails as itself instead of timing the test out. */
const firstFrame = (
  token: string | undefined,
): Operation<{ outcome: Result<unknown> | 'hung'; ms: number }> =>
  scoped(function* () {
    const url = yield* boot()
    const startedAt = Date.now()

    const outcome = yield* race([
      (function* (): Operation<Result<unknown> | 'hung'> {
        return yield* attempt(() =>
          scoped(function* () {
            const client = yield* createClient({ url, ...(token === undefined ? {} : { token }) })
            const frames = yield* client.$watch('notes')

            return yield* frames.next()
          }),
        )
      })(),
      (function* (): Operation<Result<unknown> | 'hung'> {
        yield* sleep(HANG_MS)

        return 'hung'
      })(),
    ])

    return { outcome, ms: Date.now() - startedAt }
  })

describe('realtime — a refused watch fails, it never hangs', () => {
  it('a bad bearer is refused at the upgrade and raises on the flow', async () => {
    unwrap(
      await run(function* () {
        const { outcome, ms } = yield* firstFrame('garbage')

        expect(outcome).not.toBe('hung')
        expect(isFailure(outcome as Result<unknown>)).toBe(true)
        // the handshake never even completes — this must be immediate
        expect(ms).toBeLessThan(HANG_MS / 2)
      }),
    )
  }, 30_000)

  it('a token-less watch on a guarded resource settles instead of reconnecting forever', async () => {
    unwrap(
      await run(function* () {
        // no bearer at all: the upgrade is accepted, the first-frame grace passes with no
        // `{ t: 'auth' }` frame, and the server closes with 4401 — the flow must end there
        const { outcome, ms } = yield* firstFrame(undefined)

        expect(outcome).not.toBe('hung')
        const failure = outcome as Result.Failure<unknown>
        expect(isFailure(failure)).toBe(true)
        // the refusal itself, not a generic close — the caller can tell auth from a bad line
        expect(String(failure.error)).toBe(ClientErrors.Refused)
        expect(failure.causes).toContain('ws:4401')
        expect(ms).toBeLessThan(HANG_MS)
      }),
    )
  }, 30_000)
})
