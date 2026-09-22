/**
 * The HTTP shape of a SUCCESSFUL reply: an action's static `status`/`headers`, the handler's
 * per-call `ctx.reply`, the defaults (200 / 204) and what the manifest publishes about them.
 */
import { action, createServer, Edge, service } from 'server:core'
import { Docs } from 'server:plugins'
import { run, until } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

const jobs = service('jobs', {
  create: action.mutation(
    {
      input: z.object({ name: z.string() }),
      output: z.object({ id: z.string() }),
      status: 201,
      headers: { 'cache-control': 'no-store', 'x-static': 'yes' },
    },
    function* ({ input, ctx }) {
      ctx.reply({ headers: { location: `/jobs/${input.name}`, 'x-static': 'overridden' } })
      return { id: input.name }
    },
  ),
  enqueue: action.mutation({ input: z.object({ name: z.string() }) }, function* ({ ctx }) {
    // a handler that answers NOTHING but wants 202 instead of the default 204
    ctx.reply({ status: 202, headers: { 'x-session': 's-1' } })
  }),
  ping: action.query({ output: z.string() }, function* () {
    return 'pong'
  }),
  rpc: action.mutation(
    {
      input: z.object({ method: z.string() }),
      output: z.object({ result: z.string() }),
      // rpc-style: a domain failure travels as a 200 with the error envelope
      errors: { 'rpc.method-not-found': 200, 'rpc.too-big': 413 },
    },
    function* ({ input }) {
      return input.method === 'ping'
        ? { result: 'pong' }
        : yield* fail('rpc.method-not-found', `no method ${input.method}`)
    },
  ),
  drop: action.mutation({}, function* () {}),
})

describe('edge — reply shape', () => {
  it('static status/headers, ctx.reply overrides, and the 200/204 defaults', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [jobs],
          edge: BunEdge,
          plugins: [Docs.use()],
        })
        yield* server.start()
        const post = (path: string, body?: unknown) =>
          Edge.actions.handle(
            new Request(`http://edge${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: body === undefined ? null : JSON.stringify(body),
            }),
          )

        // static 201 + static headers, one of them overridden per call, one added per call
        const created = yield* post('/jobs/create', { name: 'j1' })
        expect(created.status).toBe(201)
        expect(yield* until(created.json())).toEqual({ id: 'j1' })
        expect(created.headers.get('cache-control')).toBe('no-store')
        expect(created.headers.get('x-static')).toBe('overridden')
        expect(created.headers.get('location')).toBe('/jobs/j1')
        expect(created.headers.get('content-type')).toContain('application/json')

        // ctx.reply alone: a void reply under 202 (no body, still no content)
        const accepted = yield* post('/jobs/enqueue', { name: 'j2' })
        expect(accepted.status).toBe(202)
        expect(accepted.headers.get('x-session')).toBe('s-1')
        expect(yield* until(accepted.text())).toBe('')

        // the defaults are untouched
        const pong = yield* Edge.actions.handle(new Request('http://edge/jobs/ping'))
        expect(pong.status).toBe(200)
        expect(yield* until(pong.json())).toBe('pong')
        const dropped = yield* post('/jobs/drop')
        expect(dropped.status).toBe(204)

        // off the edge `ctx.reply` is a no-op — the value still comes back
        expect(yield* server.call(jobs, 'create', { name: 'j3' })).toEqual({ id: 'j3' })

        // a failure mapped to 200: the status says ok, the envelope and the header say failure
        const soft = yield* post('/jobs/rpc', { method: 'nope' })
        expect(soft.status).toBe(200)
        expect(soft.headers.get('oz-error')).toBe('rpc.method-not-found')
        const envelope = (yield* until(soft.json())) as AnyType
        expect(envelope.error.error).toBe('rpc.method-not-found')
        expect(envelope.error.message).toBe('no method nope')
        expect(envelope.error.status).toBe(200)
        const hard = yield* post('/jobs/rpc', { method: 'ping' })
        expect(hard.status).toBe(200)
        expect(hard.headers.get('oz-error')).toBeNull()
        expect(yield* until(hard.json())).toEqual({ result: 'pong' })

        // the manifest and OpenAPI publish the success status and the static headers
        const manifest = (yield* until(
          (yield* Edge.actions.handle(new Request('http://edge/docs/manifest'))).json(),
        )) as AnyType
        const doc = manifest.services[0].actions
        const byName = (name: string) => doc.find((entry: AnyType) => entry.action === name)
        expect(byName('create').status).toBe(201)
        expect(byName('create').headers).toEqual({ 'cache-control': 'no-store', 'x-static': 'yes' })
        expect(byName('enqueue').status).toBe(204)
        expect(byName('ping').status).toBe(200)
        const openapi = (yield* until(
          (yield* Edge.actions.handle(new Request('http://edge/docs/openapi.json'))).json(),
        )) as AnyType
        expect(Object.keys(openapi.paths['/jobs/create'].post.responses)).toContain('201')
        expect(Object.keys(openapi.paths['/jobs/drop'].post.responses)).toContain('204')
        // the 200-mapped failure shares the success entry as a oneOf; the 413 stays its own
        const rpc = openapi.paths['/jobs/rpc'].post.responses
        expect(Object.keys(rpc).toSorted()).toEqual(['200', '413'])
        expect(rpc['200'].content['application/json'].schema.oneOf).toHaveLength(2)
        expect(rpc['200'].description).toContain('rpc.method-not-found')
        yield* server.stop()
      }),
    )
  })
})
