import { action, ServerErrors, service } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Auth, JwtAuth } from 'server:plugins'
import { eventually, TestNode } from 'server:testing'
import { attempt, run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

// `@ozaco/server/testing`: `node.login` + `json({ token })` and `eventually`.

const app = service('app', {
  me: action.query({ output: z.string(), auth: 'user' }, function* ({ ctx }) {
    return ctx.auth.sub
  }),
})

const provider: AuthDef.Provider = {
  *authenticate(credentials) {
    return credentials.user === 'ada' && credentials.pass === 'pw'
      ? { sub: 'u-ada', roles: [], permissions: [], claims: {} }
      : undefined
  },
  *loadUser(sub) {
    return sub === 'u-ada' ? { sub, roles: [], permissions: [], claims: {} } : undefined
  },
}

describe('server — testing', () => {
  it('login mints the pair through the node; token rides json; eventually polls with a deadline', async () => {
    unwrap(
      await run(function* () {
        const node = yield* TestNode.use({
          services: [app],
          plugins: [JwtAuth.use({ provider, secret: 'test-secret' }), Auth],
        })
        const tokens = yield* node.login({ user: 'ada', pass: 'pw' })
        const me = yield* node.json('/app/me', { token: tokens.accessToken })

        expect(me.status).toBe(200)
        expect(me.body).toBe('u-ada')

        const anonymous = yield* node.json('/app/me')

        expect(anonymous.status).toBe(401)

        const refused = yield* attempt(node.login({ user: 'ada', pass: 'nope' }))

        expect((refused as AnyType).error).toBe(ServerErrors.Unauthorized)

        let ticks = 0
        const seen = yield* eventually(
          () => {
            ticks += 1

            return ticks >= 3 ? ticks : undefined
          },
          { everyMs: 1 },
        )

        expect(seen).toBe(3)

        const never = yield* attempt(eventually(() => undefined, { timeoutMs: 30, everyMs: 5 }))

        expect((never as AnyType).error).toBe(ServerErrors.TimeoutUnreached)
        yield* node.stop()
      }),
    )
  })
})
