/**
 * The realtime handshake is GUARDED: the resource's `read` requirement gates the session, and a
 * presented bearer — the FIRST `{ t: 'auth' }` frame included (tokens never travel in the
 * URL) — is ALWAYS verified: an EXPIRED or malformed token closes the socket even on an open
 * resource. Regression for "expired tokens could still connect to realtime".
 */
import { column, DbClient, table } from 'db:core'
import { createServer } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, crud } from 'server:plugins'
import { run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { MemoryAdapter } from 'db:impl/memory'
import { MemoryKv } from 'db:impl/memory-kv'
import { BunEdge } from 'server:impl/edge/bun'
import { BunIO } from 'std:io/impl/bun'

import { todosTable } from '../helpers'

const provider = (): AuthDef.Provider => ({
  *authenticate(credentials) {
    return credentials['user'] === 'ada' ? { sub: 'u-ada', roles: ['admin'] } : undefined
  },

  *loadUser(sub) {
    return sub === 'u-ada' ? { sub, roles: ['admin'] } : undefined
  },
})

const openTable = table('open_items', { title: column.text() })

/** Resolves 'open' when the socket answers a watch, 'rejected' when auth closes the session.
 * A browser cannot set WS headers: the token (when given) goes in-band as the FIRST frame. */
const probe = (url: string, token?: string): Promise<'open' | 'rejected'> =>
  new Promise(resolve => {
    const ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      if (token !== undefined) {
        ws.send(JSON.stringify({ t: 'auth', token }))
      }

      ws.send(JSON.stringify({ t: 'watch', id: 'p' }))
    })

    ws.addEventListener('message', () => {
      ws.close()
      resolve('open')
    })

    ws.addEventListener('error', () => resolve('rejected'))

    ws.addEventListener('close', event => {
      resolve(event.code === 1000 ? 'open' : 'rejected')
    })
  })

function* boot(sessionTtlMs: number) {
  yield* MemoryAdapter.use()
  yield* BunIO.use()
  yield* DbClient.use({ tables: [todosTable, openTable] })
  yield* MemoryKv.use()
  const subs: (string | null)[] = []
  const guarded = crud(todosTable, {
    auth: { read: 'user', write: 'user' },

    // the handshake's verified principal lands as the socket ctx's `auth` — hooks see WHO
    // subscribed without a second verification
    *before({ op, ctx }) {
      if (op === 'watch') {
        subs.push((ctx.auth as AuthDef.Principal | undefined)?.sub ?? null)
      }
    },
  })
  const open = crud(openTable)
  const server = yield* createServer({
    services: [guarded, open],
    edge: BunEdge,
    plugins: [Auth.use({ provider: provider(), secret: 'test-secret', sessionTtlMs })],
  })
  const info = yield* server.start({ port: 0 })
  return { server, ws: info.url!.replace('http', 'ws'), subs }
}

describe('resource — realtime handshake auth', () => {
  it('`read` gates the upgrade; garbage tokens never pass, valid ones do', async () => {
    unwrap(
      await run(function* () {
        const { server, ws, subs } = yield* boot(60_000)
        const tokens = yield* Auth.actions.login({ user: 'ada' })

        // guarded: no token / garbage → the session closes; a valid token → open
        expect(yield* until(probe(`${ws}/todos/_realtime`))).toBe('rejected')
        expect(yield* until(probe(`${ws}/todos/_realtime`, 'garbage'))).toBe('rejected')
        expect(yield* until(probe(`${ws}/todos/_realtime`, tokens.accessToken))).toBe('open')

        // the watch hook saw the in-band auth frame's principal on the socket ctx
        expect(subs).toContain('u-ada')

        // open resource: anonymous is fine — but PRESENTED credentials must be valid
        expect(yield* until(probe(`${ws}/open_items/_realtime`))).toBe('open')
        expect(yield* until(probe(`${ws}/open_items/_realtime`, 'garbage'))).toBe('rejected')

        yield* server.stop()
      }),
    )
  }, 15_000)

  it('an EXPIRED token is rejected — guarded and open resources alike', async () => {
    unwrap(
      await run(function* () {
        const { server, ws } = yield* boot(1)
        const tokens = yield* Auth.actions.login({ user: 'ada' })

        // jwt `exp` has second granularity: outlive it
        yield* sleep(1100)

        expect(yield* until(probe(`${ws}/todos/_realtime`, tokens.accessToken))).toBe('rejected')
        expect(yield* until(probe(`${ws}/open_items/_realtime`, tokens.accessToken))).toBe(
          'rejected',
        )

        yield* server.stop()
      }),
    )
  }, 15_000)
})
