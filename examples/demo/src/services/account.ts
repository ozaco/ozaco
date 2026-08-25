/**
 * Accounts: login / refresh / whoami on top of the Auth plugin (access + refresh rotation),
 * role-gated actions (`auth: 'user'`, `auth: ['admin']`) and a public one (`auth: false`).
 */
import { action, service } from '@ozaco/server'
import type { AuthDef } from '@ozaco/server/plugins'
import { Auth } from '@ozaco/server/plugins'
import { fail } from '@ozaco/std/result'
import { z } from 'zod'

const Tokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
})

export const account = service(
  'account',
  {
    login: action.mutation(
      {
        input: z.object({ email: z.string().email(), password: z.string().min(1) }),
        output: Tokens,
        auth: false,
        rateLimit: { limit: 20, windowMs: 60_000, key: 'ip' },
        description: 'Exchange credentials for an access + refresh token pair',
      },
      function* ({ input }) {
        return yield* Auth.actions.login(input)
      },
    ),
    refresh: action.mutation(
      {
        input: z.object({ refreshToken: z.string() }),
        output: Tokens,
        auth: false,
        description: 'Rotate a refresh token (a replayed one revokes its family)',
      },
      function* ({ input }) {
        return yield* Auth.actions.refresh(input.refreshToken)
      },
    ),
    whoami: action.query(
      {
        output: z.object({
          sub: z.string(),
          roles: z.array(z.string()),
          type: z.string(),
        }),
        auth: 'user',
        description: 'The caller behind the bearer token',
      },
      function* ({ ctx }) {
        const principal = ctx.auth as AuthDef.Principal
        return { sub: principal.sub, roles: [...principal.roles], type: principal.type }
      },
    ),
    promote: action.mutation(
      {
        input: z.object({ email: z.string() }),
        output: z.object({ ok: z.boolean() }),
        auth: ['admin'],
        description: 'Admins only: grant the admin role',
      },
      function* ({ input, ctx }) {
        const user = yield* ctx.db
          .query('users')
          .filter({ op: 'eq', field: 'email', value: input.email })
          .first()
        if (!user) {
          return yield* fail('account.unknown-user', `no user ${input.email}`)
        }
        const roles = new Set([...((user.roles as string[]) ?? []), 'admin'])
        yield* ctx.db.patch('users', String(user._id), { roles: [...roles] })
        return { ok: true }
      },
    ),
  },
  { version: '1.0.0', description: 'Sign in, tokens, roles' },
)
