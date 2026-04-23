import { operation, useContext } from 'std:effect'

import { DB } from '@ozaco/db'
import type { AuthProvider, AuthUser, RefreshRecord } from 'server:plugin/auth'

import { refreshTokens as refreshTokensTable, users as usersTable } from './db.schema'

interface SeedUser {
  id: string
  email: string
  password: string
  roles: string[]
  permissions: string[]
}

const seedUsers: SeedUser[] = [
  {
    id: 'u1',
    email: 'admin@example.com',
    password: 'admin',
    roles: ['admin', 'user'],
    permissions: ['todo:create', 'todo:read', 'todo:delete'],
  },
  {
    id: 'u2',
    email: 'user@example.com',
    password: 'user',
    roles: ['user'],
    permissions: ['todo:read'],
  },
]

const toPublicUser = (row: {
  id: string
  email: string
  roles: string[]
  permissions: string[]
}): AuthUser => ({
  id: row.id,
  email: row.email,
})

const seedIfEmpty = operation(function* () {
  const db = yield* useContext(DB)
  const existing = yield* db.from(usersTable).limit(1).all()
  if (existing.length > 0) {
    return
  }
  for (const user of seedUsers) {
    yield* db.insert(usersTable).values(user).execute()
  }
})

const demoAuthProvider: AuthProvider = {
  authenticate: operation(function* (credentials) {
    const { email, password } = credentials as { email: string; password: string }
    const db = yield* useContext(DB)
    const row = yield* db.from(usersTable).where({ email }).first()
    if (!row || row.password !== password) {
      return null
    }
    return toPublicUser(row)
  }),

  loadUser: operation(function* (id: string) {
    const db = yield* useContext(DB)
    const row = yield* db.from(usersTable).where({ id }).first()
    return row ? toPublicUser(row) : null
  }),

  saveRefreshToken: operation(function* (record: RefreshRecord) {
    const db = yield* useContext(DB)
    yield* db
      .insert(refreshTokensTable)
      .values({
        jti: record.jti,
        userId: record.userId,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        revokedAt: record.revokedAt,
      })
      .execute()
  }),

  findRefreshToken: operation(function* (jti: string) {
    const db = yield* useContext(DB)
    const row = yield* db.from(refreshTokensTable).where({ jti }).first()
    if (!row) {
      return null
    }
    return {
      jti: row.jti,
      userId: row.userId,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    }
  }),

  revokeRefreshToken: operation(function* (jti: string) {
    const db = yield* useContext(DB)
    yield* db.update(refreshTokensTable).set({ revokedAt: Date.now() }).where({ jti }).execute()
  }),

  getRoles: operation(function* (user) {
    const db = yield* useContext(DB)
    const row = yield* db.from(usersTable).where({ id: user.id }).first()
    return row?.roles ?? []
  }),

  getPermissions: operation(function* (user) {
    const db = yield* useContext(DB)
    const row = yield* db.from(usersTable).where({ id: user.id }).first()
    return row?.permissions ?? []
  }),
}

export { demoAuthProvider, seedIfEmpty }
