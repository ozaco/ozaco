import { defineAction, defineService, Gateway } from 'server:core'

import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'
import { z } from 'zod'

/**
 * Authentication endpoints. Every action just forwards to the `AccessRefreshAuth` strategy, which
 * is wired to the in-memory provider in `../store`. Tokens are real, signed JWTs (HS256).
 */
export const AuthService = defineService({
  name: 'auth',
  version: '0.0.0',

  actions: {
    signIn: defineAction(
      {
        title: 'Sign in',
        description: 'Exchange email + password for an access/refresh token pair.',
        input: z.object({
          email: z.string().min(1),
          password: z.string().min(1),
        }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/sign-in' })],
      },
      function* (body) {
        return yield* AccessRefreshAuth.actions.signIn(body)
      },
    ),

    refresh: defineAction(
      {
        title: 'Refresh tokens',
        description: 'Rotate a refresh token into a fresh access/refresh pair.',
        input: z.object({ refreshToken: z.string().min(1) }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/refresh' })],
      },
      function* (body) {
        return yield* AccessRefreshAuth.actions.refresh(body.refreshToken)
      },
    ),

    signOut: defineAction(
      {
        title: 'Sign out',
        description: 'Revoke the given refresh token.',
        input: z.object({ refreshToken: z.string().min(1) }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/sign-out' })],
      },
      function* (body) {
        yield* AccessRefreshAuth.actions.signOut(body.refreshToken)
        return { ok: true } as const
      },
    ),

    me: defineAction(
      {
        title: 'Current session',
        description: 'Return the authenticated principal (requires a Bearer access token).',
        settings: [Gateway.actions.rest({ method: 'GET', path: '/me' })],
      },
      function* () {
        const session = yield* useAuth(AccessRefreshAuth)
        return {
          user: session.user,
          roles: session.roles,
          permissions: session.permissions,
        }
      },
    ),
  },

  *setup() {},
})
