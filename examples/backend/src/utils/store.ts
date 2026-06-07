// oxlint-disable import/exports-last
import { operation } from 'std:effect'

import type { AuthDef } from 'server:plugin/auth'

/**
 * The in-memory data layer for the example. Everything lives in module-level Maps — there is no
 * database. It is deliberately tiny so the auth + todo flow is easy to follow end to end.
 *
 * In a real app the `memoryAuthProvider` below would talk to `@ozaco/db`, and passwords would be
 * hashed with argon2/bcrypt — NEVER stored in plaintext like they are here.
 */

export interface UserRecord {
  id: string
  email: string
  name: string
  /** demo only — never persist plaintext passwords in production */
  password: string
  roles: string[]
  permissions: string[]
}

export interface TodoRecord {
  id: string
  ownerId: string
  title: string
  done: boolean
  createdAt: number
  updatedAt: number
}

/** The user shape we hand back to callers — same as `UserRecord` minus the password. */
export interface PublicUser extends AuthDef.User {
  id: string
  email: string
  name: string
}

// --- the "tables" ------------------------------------------------------------

const usersById = new Map<string, UserRecord>()
const usersByEmail = new Map<string, UserRecord>()
const refreshTokens = new Map<string, AuthDef.RefreshRecord>()
const todos = new Map<string, TodoRecord>()

let todoSeq = 0

// --- seed --------------------------------------------------------------------

const seed = (user: UserRecord): void => {
  usersById.set(user.id, user)
  usersByEmail.set(user.email, user)
}

seed({
  id: 'u_admin',
  email: 'admin@example.com',
  name: 'Ada Admin',
  password: 'admin',
  roles: ['admin', 'user'],
  permissions: ['todo:read', 'todo:write', 'todo:delete'],
})

seed({
  id: 'u_user',
  email: 'user@example.com',
  name: 'Uma User',
  password: 'user',
  roles: ['user'],
  // a regular user can read and write their todos, but not delete them
  permissions: ['todo:read', 'todo:write'],
})

const toPublicUser = (row: UserRecord): PublicUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
})

// --- auth provider (in-memory) ----------------------------------------------

/**
 * The contract `AccessRefreshAuth` calls into. Every method is an `Operation` so the strategy can
 * `yield*` it; here each one just reads or writes the Maps above.
 */
export const memoryAuthProvider: AuthDef.Provider = {
  authenticate: operation(function* (credentials: unknown) {
    const { email, password } = (credentials ?? {}) as { email?: string; password?: string }
    if (!email || !password) {
      return null
    }

    const row = usersByEmail.get(email)
    if (!row || row.password !== password) {
      return null
    }

    return toPublicUser(row)
  }),

  loadUser: operation(function* (id: string) {
    const row = usersById.get(id)
    return row ? toPublicUser(row) : null
  }),

  getRoles: operation(function* (user: AuthDef.User) {
    return usersById.get(user.id)?.roles ?? []
  }),

  getPermissions: operation(function* (user: AuthDef.User) {
    return usersById.get(user.id)?.permissions ?? []
  }),

  saveRefreshToken: operation(function* (record: AuthDef.RefreshRecord) {
    refreshTokens.set(record.jti, record)
  }),

  findRefreshToken: operation(function* (jti: string) {
    return refreshTokens.get(jti) ?? null
  }),

  revokeRefreshToken: operation(function* (jti: string) {
    const record = refreshTokens.get(jti)
    if (record) {
      refreshTokens.set(jti, { ...record, revokedAt: Date.now() })
    }
  }),

  // atomic rotation: drop the old jti and persist the new record in one step so a concurrent
  // refresh can never leave the user without a valid refresh token
  rotateRefreshToken: operation(function* (oldJti: string, record: AuthDef.RefreshRecord) {
    refreshTokens.delete(oldJti)
    refreshTokens.set(record.jti, record)
  }),
}

// --- todo data access (plain, synchronous) ----------------------------------

export const listTodos = (ownerId: string): TodoRecord[] =>
  [...todos.values()]
    .filter(todo => todo.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt)

export const getTodo = (ownerId: string, id: string): TodoRecord | null => {
  const todo = todos.get(id)
  return todo && todo.ownerId === ownerId ? todo : null
}

export const createTodo = (ownerId: string, title: string): TodoRecord => {
  const now = Date.now()
  const todo: TodoRecord = {
    id: `todo_${++todoSeq}`,
    ownerId,
    title,
    done: false,
    createdAt: now,
    updatedAt: now,
  }
  todos.set(todo.id, todo)
  return todo
}

export const updateTodo = (
  ownerId: string,
  id: string,
  patch: { title?: string | undefined; done?: boolean | undefined },
): TodoRecord | null => {
  const todo = getTodo(ownerId, id)
  if (!todo) {
    return null
  }

  const next: TodoRecord = {
    ...todo,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.done === undefined ? {} : { done: patch.done }),
    updatedAt: Date.now(),
  }
  todos.set(id, next)
  return next
}

export const removeTodo = (ownerId: string, id: string): boolean => {
  if (!getTodo(ownerId, id)) {
    return false
  }
  return todos.delete(id)
}
