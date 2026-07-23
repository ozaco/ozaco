import { id, table } from 'db:realtime'

import { z } from 'zod'

/**
 * Tables are declared piece by piece — no central `defineSchema`. Each is a standalone, exportable
 * definition. `_id` (ULID) + `_createdAt` are added by the engine, so you never declare them.
 * `id('projects')` is a typed foreign key; `.unique()` / `.index()` declare the indexes the migration
 * creates on push.
 */
export const projects = table('projects', {
  name: z.string().min(1),
  color: z.string().default('#4f46e5'),
}).unique('projects_by_name', ['name'])

export const tasks = table('tasks', {
  title: z.string().min(1),
  projectId: id('projects'),
  status: z.enum(['todo', 'doing', 'done']).default('todo'),
  priority: z.number().int().min(1).max(5).default(3),
}).index('tasks_by_project', ['projectId'])

export const comments = table('comments', {
  taskId: id('tasks'),
  author: z.string().min(1),
  body: z.string().min(1),
}).index('comments_by_task', ['taskId'])

/** Gather the pieces only where they're used (driver install + `useDatabase`) — this is a plain
 * array, not a `defineSchema` object. */
export const tables = [projects, tasks, comments]
