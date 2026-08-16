import { CoreErrors } from 'server:core'
import { attempt } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { AccessRefreshAuth, AuthErrors } from 'server:plugin/auth'
import type { AuthProvider } from 'server:plugin/auth'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

import { createMemoryProvider, TEST_SECRET } from './helpers'

describe('auth: access-refresh', () => {
  it('signs in with a pair and authorizes ONLY the access token', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()

      const { provider, records } = createMemoryProvider()

      yield* install(AccessRefreshAuth, { secret: TEST_SECRET, provider })

      const pair = yield* AccessRefreshAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const principal = yield* AccessRefreshAuth.actions.authorize({
        authorization: `Bearer ${pair.accessToken}`,
      })
      const refreshRejected = yield* attempt(() =>
        AccessRefreshAuth.actions.authorize({ authorization: `Bearer ${pair.refreshToken}` }),
      )

      return { pair, principal, refreshRejected, persisted: records.size }
    })

    expect(result.pair.accessToken).not.toBe(result.pair.refreshToken)
    expect(result.pair.principal.sub).toBe('u1')
    expect(result.principal.sub).toBe('u1')
    expect(result.principal.roles).toEqual(['admin'])
    expect(result.principal.permissions).toEqual(['todos:read'])
    expect(result.persisted).toBe(1)
    expect(isFailure(result.refreshRejected)).toBe(true)

    if (isFailure(result.refreshRejected)) {
      expect(result.refreshRejected.error).toBe(CoreErrors.Unauthorized)
      expect(result.refreshRejected.causes).toContain(AuthErrors.InvalidToken)
    }
  })

  it('rotates on refresh; replaying the old token revokes the whole family', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(AccessRefreshAuth, { secret: TEST_SECRET, provider })

      const first = yield* AccessRefreshAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const second = yield* AccessRefreshAuth.actions.refresh(first.refreshToken)

      // the rotated access token works
      const principal = yield* AccessRefreshAuth.actions.authorize({
        authorization: `Bearer ${second.accessToken}`,
      })

      // SECOND use of the old refresh token → replay → family revoked
      const replayed = yield* attempt(() => AccessRefreshAuth.actions.refresh(first.refreshToken))

      // ... so even the freshly rotated token is dead now
      const afterRevocation = yield* attempt(() =>
        AccessRefreshAuth.actions.refresh(second.refreshToken),
      )

      return { second, principal, replayed, afterRevocation }
    })

    expect(result.second.refreshToken).toBeString()
    expect(result.principal.sub).toBe('u1')
    expect(isFailure(result.replayed)).toBe(true)
    expect(isFailure(result.afterRevocation)).toBe(true)

    if (isFailure(result.replayed)) {
      expect(result.replayed.error).toBe(CoreErrors.Unauthorized)
      expect(result.replayed.causes).toContain(AuthErrors.ReusedToken)
    }

    if (isFailure(result.afterRevocation)) {
      expect(result.afterRevocation.error).toBe(CoreErrors.Unauthorized)
      expect(result.afterRevocation.causes).toContain(AuthErrors.ReusedToken)
    }
  })

  it('signOut revokes the refresh family', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(AccessRefreshAuth, { secret: TEST_SECRET, provider })

      const pair = yield* AccessRefreshAuth.actions.signIn({ username: 'u1', password: 'pw-1' })

      yield* AccessRefreshAuth.actions.signOut(pair.refreshToken)

      return { revoked: yield* attempt(() => AccessRefreshAuth.actions.refresh(pair.refreshToken)) }
    })

    expect(isFailure(result.revoked)).toBe(true)

    if (isFailure(result.revoked)) {
      expect(result.revoked.error).toBe(CoreErrors.Unauthorized)
      expect(result.revoked.causes).toContain(AuthErrors.ReusedToken)
    }
  })

  it('fails setup with not-configured when the provider lacks the rotation CAS', async () => {
    const failure = await runResult(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()
      const { authenticate, loadUser, saveRefreshToken, loadRefreshToken, revokeRefreshFamily } =
        provider
      const partial: AuthProvider = {
        authenticate,
        loadUser,
        saveRefreshToken,
        loadRefreshToken,
        revokeRefreshFamily,
      }

      yield* install(AccessRefreshAuth, { secret: TEST_SECRET, provider: partial })
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(AuthErrors.NotConfigured)
      expect(failure.message).toContain('rotateRefreshToken')
    }
  })
})
