/**
 * TYPE tests: the contracts that must hold at COMPILE time. `bun test` proves only the runtime
 * line at the bottom — the real assertions are the `@ts-expect-error` markers and the explicit
 * annotations, which `moon run server:types` (tsc) checks. A marker that stops being an error is
 * itself an error, so a regression in either direction fails the build.
 *
 * Nothing here is called: a function body is type-checked all the same.
 */
import { column, table } from 'db:core'
import type { ServerDef, ServiceDef } from 'server:core'
import { action, createServer, refs, service, serviceErrors, stream } from 'server:core'
import type { ResourceDef } from 'server:plugins'
import { crud } from 'server:plugins'
import type { Operation } from 'std:effect'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean(),
  priority: column.enumOf('low', 'high'),
})

const otherTable = table('others', { label: column.text() })

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

/**
 * v0.5 inference contracts: the table is `crud`'s ONLY inference site (`NoInfer` on the
 * options), an external hook annotates itself with `HooksOf<typeof resource>`, and the
 * `schema` transforms land in the TYPES — the wire, the hooks and `shapes` all follow.
 */
const inference = (): void => {
  const pinned = crud(todosTable, {
    schema: {
      create: s => s.omit({ priority: true }),
      page: s => s.extend({ total: z.number() }),
    },

    *before(call) {
      if (call.op === 'create') {
        // the transform REMOVED `priority` from the create input — the hook sees the reshape
        // @ts-expect-error priority is no longer part of the create input
        void call.input.priority
        const title: string = call.input.title
        void title
      }
    },

    *after(call) {
      if (call.op === 'list') {
        // the widened page envelope flows into the hook's output type
        const total: number = call.output.total
        void total
      }

      if (call.op === 'get') {
        // still the resolved row type — reshapes elsewhere did not widen it
        const priority: 'low' | 'high' = call.output.priority
        void priority
      }
    },
  })

  // `shapes` is typed at the REAL instantiation: the transform's return type, not a bare object
  const created: ReturnType<(typeof pinned)['shapes']['create']['parse']> = {
    title: 'x',
    done: false,
  }
  void created

  // an EXTERNAL hook annotates itself from the built resource — reuse without generics
  const audit: ResourceDef.HooksOf<typeof pinned>['before'] = function* (call) {
    if (call.op === 'create') {
      return { ...call.input, title: call.input.title.trim() }
    }
  }
  void audit

  // a hook shaped for another resource's rows is a compile error, not a silent widening
  const otherCrud = crud(otherTable)
  const foreign: ResourceDef.HooksOf<typeof otherCrud>['after'] = function* (call) {
    if (call.op === 'get') {
      const label: string = call.output.label
      void label
    }
  }

  crud(todosTable, {
    // @ts-expect-error the hook does not speak this resource's rows
    after: foreign,
  })
}

void inference

/** v0.5: `ctx.auth` narrows from the `auth:` option, and socket frames survive `typeof`. */
const authAndSockets = (): void => {
  // any truthy requirement → the handler sees a verified principal, no null check
  action.query({ output: z.string(), auth: 'authenticated' }, function* ({ ctx }) {
    const sub: string = ctx.auth.sub
    return sub
  })

  action.mutation({ output: z.string(), auth: ['admin'] }, function* ({ ctx }) {
    const roles: readonly string[] = ctx.auth.roles
    return roles.join(',')
  })

  action.query({ output: z.string() }, function* ({ ctx }) {
    // @ts-expect-error without an auth requirement the principal may be null
    const sub: string = ctx.auth.sub
    return String(sub)
  })

  action.query({ output: z.string(), auth: false }, function* ({ ctx }) {
    // @ts-expect-error `auth: false` keeps the nullable principal
    const sub: string = ctx.auth.sub
    return String(sub)
  })

  // socket frame declarations live in the TYPE — recoverable from the entry itself
  const sock = action.socket(
    { receives: z.object({ q: z.string() }), sends: z.object({ a: z.number() }) },
    function* (socket) {
      const step = yield* (yield* socket.messages).next()
      if (!step.done) {
        const q: string = step.value.q
        void q
      }
      yield* socket.send({ a: 1 })
    },
  )

  const frame: ServiceDef.ReceivesOf<typeof sock> = { q: 'x' }
  void frame

  // @ts-expect-error an inbound frame is typed by `receives`
  const bad: ServiceDef.ReceivesOf<typeof sock> = { q: 1 }
  void bad

  const out: ServiceDef.SendsOf<typeof sock> = { a: 2 }
  void out
}

void authAndSockets

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
