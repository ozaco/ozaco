// oxlint-disable import/exports-last
/**
 * The Auth plugin's provider over the `users` table: credentials → user, refresh records in
 * memory (a table would do the same), seeded with two accounts so the demo logs in at once.
 *
 * Nothing is threaded in: every method resolves the TYPED handle itself with `useDb(usersTable)`
 * — the rows come back as `{ email, name, password, roles }`, no casts.
 */
import { useDb } from '@ozaco/db'
import type { AuthDef } from '@ozaco/server/plugins'
import type { Operation } from '@ozaco/std/effect'

import { usersTable } from './tables'

export const SEED_USERS = [
  { email: 'ada@example.com', name: 'Ada', password: 'ada', roles: ['admin'] },
  { email: 'bob@example.com', name: 'Bob', password: 'bob', roles: [] },
] as const

const refreshRecords = new Map<string, AuthDef.RefreshRecord>()

const rolesOf = (roles: unknown): readonly string[] => (Array.isArray(roles) ? roles : [])

export const authProvider = (): AuthDef.Provider => ({
  *authenticate(credentials) {
    const email = String(credentials['email'] ?? '')
    const password = String(credentials['password'] ?? '')
    const db = yield* useDb(usersTable)

    const user = yield* db.query('users').filter({ op: 'eq', field: 'email', value: email }).first()

    if (!user || user.password !== password) {
      return undefined
    }

    return {
      sub: user._id,
      roles: rolesOf(user.roles),
      claims: { email, name: user.name },
    }
  },

  *loadUser(sub) {
    const user = yield* (yield* useDb(usersTable)).get('users', sub)

    return user
      ? {
          sub,
          roles: rolesOf(user.roles),
          claims: { email: user.email, name: user.name },
        }
      : undefined
  },

  *saveRefresh(record) {
    refreshRecords.set(record.jti, record)
  },

  *loadRefresh(jti) {
    return refreshRecords.get(jti)
  },

  *rotateRefresh(expectedJti, next) {
    const current = refreshRecords.get(expectedJti)

    if (!current || current.revoked) {
      return false
    }

    refreshRecords.set(expectedJti, { ...current, revoked: true })
    refreshRecords.set(next.jti, next)

    return true
  },

  *revokeFamily(family) {
    for (const [jti, record] of refreshRecords) {
      if (record.family === family) {
        refreshRecords.set(jti, { ...record, revoked: true })
      }
    }
  },
})

/** Insert the seed users when the table is empty. */
export function* seedUsers(): Operation<void> {
  const db = yield* useDb(usersTable)
  const existing = yield* db.query('users').count()

  if (existing > 0) {
    return
  }

  for (const user of SEED_USERS) {
    yield* db.insert('users', { ...user, roles: [...user.roles] })
  }
}
