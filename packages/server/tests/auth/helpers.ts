import type { AccessRefreshProvider, Auth } from 'server:plugin/auth'

interface MemoryUser {
  readonly password: string
  readonly roles: readonly string[]
  readonly permissions: readonly string[]
}

export interface MemoryProvider {
  readonly provider: AccessRefreshProvider
  readonly records: Map<string, Auth.RefreshRecord>
}

/** The HMAC secret shared by the auth suites. */
export const TEST_SECRET = 'test-secret-0123456789abcdef'

/**
 * A Map-backed provider fixture: two fixed users, refresh records with tombstoning rotation
 * (consumed records stay, marked revoked) so replay detection and family revocation are testable.
 */
export const createMemoryProvider = (): MemoryProvider => {
  const users = new Map<string, MemoryUser>([
    ['u1', { password: 'pw-1', roles: ['admin'], permissions: ['todos:read'] }],
    ['u2', { password: 'pw-2', roles: [], permissions: [] }],
  ])
  const records = new Map<string, Auth.RefreshRecord>()

  const provider: AccessRefreshProvider = {
    *authenticate(credentials) {
      const username = credentials['username']

      if (typeof username !== 'string') {
        return undefined
      }

      const user = users.get(username)

      return user && user.password === credentials['password']
        ? { sub: username, claims: { plan: 'pro' } }
        : undefined
    },

    *loadUser(sub) {
      return users.has(sub) ? { sub, claims: { plan: 'pro' } } : undefined
    },

    *getRoles(user) {
      return users.get(user.sub)?.roles ?? []
    },

    *getPermissions(user) {
      return users.get(user.sub)?.permissions ?? []
    },

    *saveRefreshToken(record) {
      records.set(record.jti, record)
    },

    *loadRefreshToken(jti) {
      return records.get(jti)
    },

    *rotateRefreshToken(expectedJti, next) {
      const current = records.get(expectedJti)

      if (!current || current.revoked) {
        return false
      }

      records.set(expectedJti, { ...current, revoked: true })
      records.set(next.jti, next)

      return true
    },

    *revokeRefreshFamily(familyId) {
      for (const [jti, record] of records) {
        if (record.familyId === familyId) {
          records.set(jti, { ...record, revoked: true })
        }
      }
    },
  }

  return { provider, records }
}
