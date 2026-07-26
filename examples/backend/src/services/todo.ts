import {
  Broker,
  CoreErrors,
  DataType,
  Gateway,
  defineAction,
  defineService,
  useResponse,
} from 'server:core'
import { fail } from 'std:result'

import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'
import { z } from 'zod'

import { createTodo, getTodo, listTodos, removeTodo, updateTodo } from '../utils/store'

import { AiService } from './ai'

/**
 * Todo CRUD, scoped to the signed-in user. Every action authenticates the Bearer access token via
 * `useAuth`, then gates on a permission so the difference between the two seed users is visible:
 *   - `user@example.com`  can read + write its todos
 *   - `admin@example.com` can additionally delete them (`todo:delete`)
 *
 * A missing/expired token surfaces as 401 and a missing permission as 403 (see the status map in
 * `index.ts`). Data lives in the Maps in `../store`.
 */
export const TodoService = defineService({
  name: 'todos',
  version: '0.0.0',

  actions: {
    list: defineAction(
      {
        title: 'List todos',
        description: "List the signed-in user's todos.",
        settings: [Gateway.actions.rest({ method: 'GET', path: '/' })],
      },
      function* () {
        const session = yield* useAuth(AccessRefreshAuth)
        yield* AccessRefreshAuth.actions.requirePermission(session, 'todo:read')

        return listTodos(session.sub)
      },
    ),

    get: defineAction(
      {
        title: 'Get todo',
        description: 'Fetch a single todo by id.',
        input: z.object({ id: z.string() }),
        settings: [Gateway.actions.rest({ method: 'GET', path: '/:id' })],
      },
      function* (body) {
        const session = yield* useAuth(AccessRefreshAuth)
        yield* AccessRefreshAuth.actions.requirePermission(session, 'todo:read')

        const todo = getTodo(session.sub, body.id)
        if (!todo) {
          return yield* fail(CoreErrors.NotFound, `todo "${body.id}" not found`)
        }

        return todo
      },
    ),

    create: defineAction(
      {
        title: 'Create todo',
        description: 'Create a todo owned by the signed-in user.',
        input: z.object({ title: z.string().min(1) }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/' })],
      },
      function* (body) {
        const session = yield* useAuth(AccessRefreshAuth)
        yield* AccessRefreshAuth.actions.requirePermission(session, 'todo:write')

        const extendedTitle = yield* Broker.actions.call(AiService, 'chat', [
          {
            type: DataType.normal,
            value: {
              prompt: body.title,
              system:
                'Convert the given prompt into a broader todo list item (the result should be a single item).',
            },
          },
        ])
        const todo = createTodo(session.sub, extendedTitle.text)

        const res = yield* useResponse()
        res.status = 201
        return todo
      },
    ),

    update: defineAction(
      {
        title: 'Update todo',
        description: "Patch a todo's title and/or done flag.",
        input: z.object({
          id: z.string(),
          title: z.string().min(1).optional(),
          done: z.boolean().optional(),
        }),
        settings: [Gateway.actions.rest({ method: 'PATCH', path: '/:id' })],
      },
      function* (body) {
        const session = yield* useAuth(AccessRefreshAuth)
        yield* AccessRefreshAuth.actions.requirePermission(session, 'todo:write')

        const todo = updateTodo(session.sub, body.id, { title: body.title, done: body.done })
        if (!todo) {
          return yield* fail(CoreErrors.NotFound, `todo "${body.id}" not found`)
        }
        return todo
      },
    ),

    remove: defineAction(
      {
        title: 'Delete todo',
        description: 'Delete a todo (requires the todo:delete permission).',
        input: z.object({ id: z.string() }),
        settings: [Gateway.actions.rest({ method: 'DELETE', path: '/:id' })],
      },
      function* (body) {
        const session = yield* useAuth(AccessRefreshAuth)
        yield* AccessRefreshAuth.actions.requirePermission(session, 'todo:delete')

        if (!removeTodo(session.sub, body.id)) {
          return yield* fail(CoreErrors.NotFound, `todo "${body.id}" not found`)
        }
        return { ok: true } as const
      },
    ),
  },

  *setup() {},
})
