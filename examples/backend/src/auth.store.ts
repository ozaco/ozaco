import { operation } from 'std:effect'

import type { AuthProvider, AuthUser, RefreshRecord } from 'server:auth'

interface DemoUser extends AuthUser {
  id: string
  email: string
  password: string
  roles: string[]
  permissions: string[]
}

const users = new Map<string, DemoUser>([
  [
    'u1',
    {
      id: 'u1',
      email: 'admin@example.com',
      password: 'admin',
      roles: ['admin', 'user'],
      permissions: ['todo:create', 'todo:read', 'todo:delete'],
    },
  ],
  [
    'u2',
    {
      id: 'u2',
      email: 'user@example.com',
      password: 'user',
      roles: ['user'],
      permissions: ['todo:read'],
    },
  ],
])

const usersByEmail = new Map<string, DemoUser>()
for (const user of users.values()) {
  usersByEmail.set(user.email, user)
}

const refreshTokens = new Map<string, RefreshRecord>()

const toPublicUser = (user: DemoUser): AuthUser => ({
  id: user.id,
  email: user.email,
})

export const demoAuthProvider: AuthProvider = {
  // oxlint-disable-next-line require-yield
  authenticate: operation(function* (credentials) {
    const { email, password } = credentials as { email: string; password: string }
    const match = usersByEmail.get(email)
    if (!match || match.password !== password) {
      return null
    }
    return toPublicUser(match)
  }),

  // oxlint-disable-next-line require-yield
  loadUser: operation(function* (id: string) {
    const user = users.get(id)
    return user ? toPublicUser(user) : null
  }),

  // oxlint-disable-next-line require-yield
  saveRefreshToken: operation(function* (record: RefreshRecord) {
    refreshTokens.set(record.jti, record)
  }),

  // oxlint-disable-next-line require-yield
  findRefreshToken: operation(function* (jti: string) {
    return refreshTokens.get(jti) ?? null
  }),

  // oxlint-disable-next-line require-yield
  revokeRefreshToken: operation(function* (jti: string) {
    const record = refreshTokens.get(jti)
    if (record) {
      record.revokedAt = Date.now()
    }
  }),

  // oxlint-disable-next-line require-yield
  getRoles: operation(function* (user) {
    return users.get(user.id)?.roles ?? []
  }),

  // oxlint-disable-next-line require-yield
  getPermissions: operation(function* (user) {
    return users.get(user.id)?.permissions ?? []
  }),
}
