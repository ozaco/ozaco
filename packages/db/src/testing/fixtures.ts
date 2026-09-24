import { column, defineSchema, table } from 'db:core'

/** The fixture tables the conformance suite installs (dropped and re-migrated per test). */
export const users = table('users', {
  name: column.text(),
  age: column.int().optional(),
  role: column.enumOf('admin', 'member').default('member'),
  active: column.boolean().default(true),
  meta: column.json<{ tags: string[] }>().optional(),
  joined: column.timestamp().optional(),
  seen: column.timestamp({ as: 'ms' }).optional(),
  avatar: column.blob().optional(),
}).unique('by_name', ['name'])

export const posts = table('posts', {
  title: column.text(),
  author: column.id('users'),
  views: column.int().default(0),
}).index('by_author', ['author'])

/** The ONE schema declaration of the fixtures. */
export const schema = defineSchema({ users, posts })
