import { column, table } from 'db:core'

/** The shared fixture tables the suites install. */
export const users = table('users', {
  name: column.text(),
  age: column.int().optional(),
  role: column.enumOf('admin', 'member').default('member'),
  active: column.boolean().default(true),
  meta: column.json<{ tags: string[] }>().optional(),
  joined: column.timestamp().optional(),
}).unique('by_name', ['name'])

export const posts = table('posts', {
  title: column.text(),
  author: column.id('users'),
  views: column.int().default(0),
}).index('by_author', ['author'])
