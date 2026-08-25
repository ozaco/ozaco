// oxlint-disable import/exports-last
/**
 * The Auth plugin's provider over the `users` table: credentials → user, refresh records in
 * memory (a table would do the same), seeded with two accounts so the demo logs in at once.
 */
import type { ServerDef } from '@ozaco/server'
import type { AuthDef } from '@ozaco/server/plugins'
import type { Operation } from '@ozaco/std/effect'

export const SEED_USERS = [
  { email: 'ada@example.com', name: 'Ada', password: 'ada', roles: ['admin'] },
  { email: 'bob@example.com', name: 'Bob', password: 'bob', roles: [] },
] as const

const refreshRecords = new Map<string, AuthDef.RefreshRecord>()

/** The db handle as actions see it (`ctx.db`). */
export type Db = ServerDef.Ctx['db']

export const authProvider = (db: () => Db): AuthDef.Provider => ({
  *authenticate(credentials) {
    const email = String(credentials['email'] ?? '')
    const password = String(credentials['password'] ?? '')
    const user = yield* db()
      .query('users')
      .filter({ op: 'eq', field: 'email', value: email })
      .first()
    if (!user || user.password !== password) {
      return undefined
    }
    return {
      sub: String(user._id),
      roles: (user.roles as string[]) ?? [],
      claims: { email, name: String(user.name) },
    }
  },
  *loadUser(sub) {
    const user = yield* db().get('users', sub)
    return user
      ? {
          sub,
          roles: (user.roles as string[]) ?? [],
          claims: { email: String(user.email), name: String(user.name) },
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
export function* seedUsers(db: Db): Operation<void> {
  const existing = yield* db.query('users').count()

  if (existing > 0) {
    return
  }

  for (const user of SEED_USERS) {
    yield* db.insert('users', { ...user, roles: [...user.roles] })
  }
}
