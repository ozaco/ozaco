/**
 * TYPE tests: the contracts that must hold at COMPILE time. `bun test` proves only the runtime
 * line at the bottom — the real assertions are the `@ts-expect-error` markers and the explicit
 * annotations, which `moon run server:types` (tsc) checks. A marker that stops being an error is
 * itself an error, so a regression in either direction fails the build.
 *
 * Nothing here is called: a function body is type-checked all the same.
 */
import { column, table } from 'db:core'
import type { ServerDef } from 'server:core'
import { action, createServer, refs, service, serviceErrors, stream } from 'server:core'
import { crud } from 'server:plugins'
import type { Operation } from 'std:effect'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean(),
  priority: column.enumOf('low', 'high'),
})

const errors = serviceErrors('todo', { 'not-found': 404, 'in-use': 409 })

const todos = crud(todosTable, {
  auth: { read: 'authenticated', write: 'user' },

  extend: {
    stats: action.query({ output: z.object({ open: z.number() }) }, function* () {
      return { open: 0 }
    }),
  },
})

const other = service('other', {
  ping: action.query({ input: z.object({ n: z.number() }), output: z.string() }, function* () {
    return 'pong'
  }),
})

/** Statements that must (or must not) COMPILE. */
const accepts = (): void => {
  // --- action options are typed fields, not an open bag ---------------------------------------

  action.query({ output: z.string(), cache: { ttlMs: 10 }, auth: ['admin'] }, function* () {
    return 'x'
  })

  // @ts-expect-error a role requirement is an ARRAY of roles
  action.query({ output: z.string(), auth: 'admin' }, function* () {
    return 'x'
  })

  // @ts-expect-error `cahce` is nobody's option
  action.query({ output: z.string(), cahce: { ttlMs: 10 } }, function* () {
    return 'x'
  })

  // @ts-expect-error a cache entry needs a ttl
  action.query({ output: z.string(), cache: { tags: ['todos'] } }, function* () {
    return 'x'
  })

  // --- createServer options --------------------------------------------------------------------

  createServer({ services: [other], role: 'gateway' })

  // @ts-expect-error 'worker' is not a role
  createServer({ services: [other], role: 'worker' })
}

void accepts

/** What the definitions INFER, asserted by annotation. */
function* probe(ctx: ServerDef.Ctx): Operation<void> {
  // a ref built from a TYPE-ONLY import keeps the input and output typed
  const api = refs<typeof other>('other')
  const pong: string = yield* ctx.call(api.ping, { n: 1 })
  void pong

  // @ts-expect-error `n` must be a number
  yield* ctx.call(api.ping, { n: 'one' })

  // the definition form is typed the same way
  const also: string = yield* ctx.call(other, 'ping', { n: 1 })
  void also

  // ctx.auth is the principal, not `unknown`
  const who: string | undefined = ctx.auth?.sub
  void who
}

void probe

/** crud hooks narrow by `op`. */
const hooks = (): void => {
  crud(todosTable, {
    *before(call) {
      if (call.op === 'create') {
        const title: string = call.input.title
        void title
      }

      if (call.op === 'remove') {
        const id: string = call.input.id
        void id
      }

      if (call.op === 'list') {
        // @ts-expect-error `list` takes the list input — it has no `title`
        void call.input.title
      }
    },

    *after(call) {
      if (call.op === 'list') {
        const rows: readonly { title: string }[] = call.output.data
        void rows
      }

      if (call.op === 'get') {
        const priority: 'low' | 'high' = call.output.priority
        void priority
      }

      if (call.op === 'watch' && call.output.t === 'delta') {
        const added: readonly { done: boolean }[] = call.output.added
        void added
      }
    },

    *error(call) {
      return errors.notFound(`gone: ${call.op}`)
    },
  })
}

void hooks

/** Sockets are typed by their declared frames. */
const sockets = (): void => {
  action.socket(
    {
      receives: z.object({ text: z.string() }),
      sends: z.object({ ok: z.boolean() }),
    },
    function* (socket) {
      const messages = yield* socket.messages
      const step = yield* messages.next()

      if (!step.done) {
        const text: string = step.value.text
        void text
      }

      yield* socket.send({ ok: true })

      // @ts-expect-error the socket sends `{ ok: boolean }`
      yield* socket.send({ nope: 1 })
    },
  )
}

void sockets

/** A stream action may answer four ways. */
const streams = (): void => {
  action.stream({ output: stream.ndjson(z.number()) }, function* () {
    return [1, 2, 3]
  })

  // @ts-expect-error a plain value is not a stream
  action.stream({ output: stream.ndjson(z.number()) }, function* () {
    return 7
  })
}

void streams

describe('server — types', () => {
  it('serviceErrors carries the tag, the status map and the failer together', () => {
    expect(errors.notFound.tag).toBe('todo.not-found')
    expect(errors.inUse.tag).toBe('todo.in-use')
    expect(errors.statuses).toEqual({ 'todo.not-found': 404, 'todo.in-use': 409 })
    expect(todos.name).toBe('todos')
  })
})
