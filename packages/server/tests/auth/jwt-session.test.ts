import { CoreErrors } from 'server:core'
import { attempt, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { AuthErrors, JwtSessionAuth } from 'server:plugin/auth'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

import { createMemoryProvider, TEST_SECRET } from './helpers'

describe('auth: jwt-session', () => {
  it('signs in and authorizes the round-trip principal', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider })

      const session = yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const principal = yield* JwtSessionAuth.actions.authorize({
        authorization: `Bearer ${session.token}`,
      })

      return {
        session,
        principal,
        admin: yield* JwtSessionAuth.actions.hasRole(principal, 'admin'),
        root: yield* JwtSessionAuth.actions.hasRole(principal, 'root'),
        read: yield* JwtSessionAuth.actions.hasPermission(principal, 'todos:read'),
        write: yield* JwtSessionAuth.actions.hasPermission(principal, 'todos:write'),
      }
    })

    expect(result.session.token.split('.')).toHaveLength(3)
    expect(result.session.principal.sub).toBe('u1')
    expect(result.principal.sub).toBe('u1')
    expect(result.principal.roles).toEqual(['admin'])
    expect(result.principal.permissions).toEqual(['todos:read'])
    expect(result.principal.claims['plan']).toBe('pro')
    expect(result.admin).toBe(true)
    expect(result.root).toBe(false)
    expect(result.read).toBe(true)
    expect(result.write).toBe(false)
  })

  it('rejects bad credentials with Unauthorized + invalid-credentials cause', async () => {
    const failure = await runResult(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider })
      yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'wrong' })
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Unauthorized)
      expect(failure.causes).toContain(AuthErrors.InvalidCredentials)
    }
  })

  it('rejects tampered tokens with Unauthorized + invalid-token cause', async () => {
    const failure = await runResult(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider })

      const session = yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const tail = session.token.endsWith('A') ? 'B' : 'A'
      const tampered = session.token.slice(0, -1) + tail

      yield* JwtSessionAuth.actions.authorize({ authorization: `Bearer ${tampered}` })
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Unauthorized)
      expect(failure.causes).toContain(AuthErrors.InvalidToken)
    }
  })

  it('rejects expired tokens with the expired cause', async () => {
    const failure = await runResult(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider, sessionTtlMs: 1 })

      const session = yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'pw-1' })

      // JWT exp has second granularity — sleep past the next boundary so expiry is guaranteed
      yield* sleep(1100)
      yield* JwtSessionAuth.actions.authorize({ authorization: `Bearer ${session.token}` })
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Unauthorized)
      expect(failure.causes).toContain(AuthErrors.ExpiredToken)
    }
  })

  it('requireRole/requirePermission pass and fail Forbidden', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider })

      const session = yield* JwtSessionAuth.actions.signIn({ username: 'u1', password: 'pw-1' })
      const principal = yield* JwtSessionAuth.actions.authorize({
        authorization: `Bearer ${session.token}`,
      })

      yield* JwtSessionAuth.actions.requireRole(principal, 'admin')
      yield* JwtSessionAuth.actions.requirePermission(principal, 'todos:read')

      return {
        role: yield* attempt(() => JwtSessionAuth.actions.requireRole(principal, 'root')),
        permission: yield* attempt(() =>
          JwtSessionAuth.actions.requirePermission(principal, 'todos:write'),
        ),
      }
    })

    expect(isFailure(result.role)).toBe(true)
    expect(isFailure(result.permission)).toBe(true)

    if (isFailure(result.role)) {
      expect(result.role.error).toBe(CoreErrors.Forbidden)
    }

    if (isFailure(result.permission)) {
      expect(result.permission.error).toBe(CoreErrors.Forbidden)
    }
  })

  it('authorizes service tokens without a user lookup', async () => {
    const result = await runScoped(function* () {
      yield* bootstrap()

      const { provider } = createMemoryProvider()

      yield* install(JwtSessionAuth, { secret: TEST_SECRET, provider })

      const token = yield* JwtSessionAuth.actions.signServiceToken('metrics')
      const principal = yield* JwtSessionAuth.actions.authorize({
        authorization: `Bearer ${token}`,
      })

      return { principal }
    })

    expect(result.principal.sub).toBe('service:metrics')
    expect(result.principal.roles).toEqual(['service'])
    expect(result.principal.claims['service']).toBe('metrics')
  })
})
