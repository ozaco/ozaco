import { column, table } from '@ozaco/db'

/** The demo's tables: a crud resource (todos), users for auth, a log of uploads. */
export const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
  priority: column.enumOf('low', 'normal', 'high').default(() => 'normal'),
})

export const usersTable = table('users', {
  email: column.text(),
  name: column.text(),
  password: column.text(),
  roles: column.json(),
})

export const uploadsTable = table('uploads', {
  name: column.text(),
  size: column.int(),
  mime: column.text(),
})

export const tables = [todosTable, usersTable, uploadsTable]
