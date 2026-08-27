import { createServer, Edge, ServerErrors } from 'server:core'
import { crud } from 'server:plugins'
import { run, sleep, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage, todosTable } from '../helpers'

const json = function* (path: string, init?: RequestInit) {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`, init))
  const text = yield* until(response.text())
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  }
}

const post = (path: string, body: unknown) =>
  json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('resource schema hooks', () => {
  it('reshapes the derived input and output schemas once at definition time', async () => {
    const inputs: string[] = []
    const outputs: string[] = []

    const todos = crud(todosTable, {
      schema: {
        *input(s, of) {
          inputs.push(of)
          if (of === 'create') {
            // tighten the create input beyond what the column kinds derive
            return s.extend({ title: z.string().min(3) })
          }
          return s
        },
        *output(s, of) {
          outputs.push(of)
          if (of === 'doc') {
            // reshape every read output: titles come back SHOUTED (validation parses through)
            return s.extend({ title: z.string().transform(title => title.toUpperCase()) })
          }
          if (of === 'page') {
            // widen the list ENVELOPE — the `after` hook's return passes this schema, so the
            // extra field survives output validation instead of being stripped
            return s.extend({ total: z.number() })
          }
          return s
        },
      },

      *after({ op, output, ctx }) {
        if (op === 'list') {
          return { ...(output as AnyType), total: yield* ctx.db.query('todos').count() }
        }
      },
    })

    // the hooks ran while `crud()` built the service — once per derived schema, never again
    expect(inputs.toSorted()).toEqual(['create', 'list', 'replace', 'update'])
    expect(outputs).toEqual(['doc', 'page'])

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos.service],
          edge: BunEdge,
        })
        yield* server.listen()

        // the tightened create input rejects what the default schema would accept
        const short = yield* post('/todos', { title: 'ab', done: false })
        expect(short.status).toBe(400)
        expect(short.body.error.error).toBe(ServerErrors.Validation)

        // the reshaped doc flows through every read output
        const created = yield* post('/todos', { title: 'abc', done: false })
        expect(created.status).toBe(200)
        expect(created.body.title).toBe('ABC')

        // the widened page envelope carries what the `after` hook computed
        const page = yield* json('/todos')
        expect(page.body.data.map((row: AnyType) => row.title)).toEqual(['ABC'])
        expect(page.body.total).toBe(1)
        expect((yield* json(`/todos/${created.body._id}`)).body.title).toBe('ABC')
        yield* server.stop()
      }),
    )
  })

  it('the hooks are definition-time only: suspending or failing refuses the crud()', () => {
    let suspended: AnyType
    try {
      crud(todosTable, {
        schema: {
          *input(s) {
            yield* sleep(1)
            return s
          },
        },
      })
    } catch (error) {
      suspended = error
    }
    expect(suspended?.error).toBe(ServerErrors.Configuration)

    let refused: AnyType
    try {
      crud(todosTable, {
        schema: {
          *output(s, of) {
            if (of === 'doc') {
              return yield* fail('todo.bad-schema', 'this table cannot be a resource')
            }
            return s
          },
        },
      })
    } catch (error) {
      refused = error
    }
    expect(refused?.error).toBe('todo.bad-schema')
  })
})
