import { col, defineSchema, defineTable } from 'db:schema'

const users = defineTable('users', {
  id: col.text().primary(),
  email: col.text().unique(),
  password: col.text(),
  roles: col.json<string[]>(),
  permissions: col.json<string[]>(),
})

const refreshTokens = defineTable('refresh_tokens', {
  jti: col.text().primary(),
  userId: col.text(),
  issuedAt: col.int(),
  expiresAt: col.int(),
  revokedAt: col.int().optional(),
})

const todos = defineTable('todos', {
  id: col.text().primary(),
  userId: col.text(),
  title: col.text(),
  completed: col.boolean().default(false),
  createdAt: col.timestamp().defaultNow(),
})

const schema = defineSchema({ users, refresh_tokens: refreshTokens, todos })

export { refreshTokens, schema, todos, users }
