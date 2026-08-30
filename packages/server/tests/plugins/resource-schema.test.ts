import { useDb } from 'db:core'
import { createServer, Edge, ServerErrors } from 'server:core'
import { crud } from 'server:plugins'
import { run, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage, todosTable, testSchema } from '../helpers'

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
        create: s => {
          inputs.push('create')
          // tighten the create input beyond what the column kinds derive
          return s.extend({ title: z.string().min(3) })
        },
        doc: s => {
          outputs.push('doc')
          // reshape every read output: titles come back SHOUTED (validation parses through)
          return s.extend({ title: z.string().transform(title => title.toUpperCase()) })
        },
        page: s => {
          outputs.push('page')
          // widen the list ENVELOPE — the `after` hook's return passes this schema, so the
          // extra field survives output validation instead of being stripped
          return s.extend({ total: z.number() })
        },
      },

      *after({ op, output }) {
        if (op === 'list') {
          return {
            ...(output as AnyType),
            total: yield* (yield* useDb(testSchema)).query('todos').count(),
          }
        }
      },
    })

    // the transforms ran while `crud()` built the service — once per given key, never again
    expect(inputs).toEqual(['create'])
    expect(outputs).toEqual(['doc', 'page'])

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
        })
        yield* server.start()

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

  it('the transforms are definition-time plain functions: a throw refuses the crud()', () => {
    let refused: AnyType
    try {
      crud(todosTable, {
        schema: {
          doc: () => {
            throw fail('todo.bad-schema', 'this table cannot be a resource')
          },
        },
      })
    } catch (error) {
      refused = error
    }
    expect(refused?.error).toBe('todo.bad-schema')
  })
})
