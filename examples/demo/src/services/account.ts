/**
 * Accounts: login / refresh / whoami on top of the Auth plugin (access + refresh rotation),
 * role-gated actions (`auth: 'user'`, `auth: ['admin']`) and a public one (`auth: false`).
 */
import { useDb } from '@ozaco/db'
import { action, service, serviceErrors } from '@ozaco/server'
import type { AuthDef } from '@ozaco/server/plugins'
import { Auth } from '@ozaco/server/plugins'
import { z } from 'zod'

import { usersTable } from '../tables'

/** the tag, its status and the failer in one place — `errors: accountErrors.statuses` on the
 * action publishes it, `accountErrors.unknownUser(...)` raises it (this used to be a bare
 * `fail('account.unknown-user')` with no `errors` entry: a 404 condition answering 500) */
const accountErrors = serviceErrors('account', { 'unknown-user': 404 })

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
        errors: accountErrors.statuses,
        description: 'Admins only: grant the admin role',
      },
      function* ({ input }) {
        const db = yield* useDb(usersTable)

        const user = yield* db
          .query('users')
          .filter({ op: 'eq', field: 'email', value: input.email })
          .first()

        if (!user) {
          return yield* accountErrors.unknownUser(`no user ${input.email}`)
        }

        const roles = new Set([...(Array.isArray(user.roles) ? user.roles : []), 'admin'])
        yield* db.patch('users', user._id, { roles: [...roles] })

        return { ok: true }
      },
    ),
  },
  { version: '1.0.0', description: 'Sign in, tokens, roles' },
)
