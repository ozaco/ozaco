import { createServer, Edge } from 'server:core'
import { Docs, manifestSchema, ObservePlugin, Resilience } from 'server:plugins'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'

import { storage, todos } from '../helpers'

describe('docs', () => {
  it('serves the manifest (schemas, planes, brands, options) and a CDN-free panel', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          name: 'demo',
          version: '2.0.0',
          plugins: [
            ObservePlugin.use({ console: true }),
            Resilience,
            Docs.use({ path: '/docs', title: 'demo api' }),
          ],
        })
        yield* server.start()
        const response = yield* Edge.actions.handle(new Request('http://edge/docs/manifest'))
        expect(response.status).toBe(200)
        const manifest = (yield* until(response.json())) as AnyType
        expect(manifestSchema.safeParse(manifest).success).toBe(true)
        expect(manifest.name).toBe('demo')
        expect(manifest.observe.console).toBe('/_observe')
        expect(manifest.docs).toEqual({ path: '/docs', openapi: '/docs/openapi.json' })
        const todosDoc = manifest.services.find((entry: { name: string }) => entry.name === 'todos')
        const create = todosDoc.actions.find(
          (entry: { action: string }) => entry.action === 'create',
        )
        expect(create.kind).toBe('mutation')
        expect(create.route).toEqual({ method: 'POST', path: '/todos/create' })
        expect(create.input.schema.properties.title.type).toBe('string')
        expect(create.input.schema.properties.title.minLength).toBe(1)
        expect(create.output.schema.required).toEqual(['id', 'title', 'done'])
        expect(JSON.stringify(manifest)).not.toContain('$schema')
        const count = todosDoc.actions.find((entry: { action: string }) => entry.action === 'count')
        expect(count.output).toMatchObject({
          plane: 'stream',
          brand: 'ndjson',
          contentType: 'application/x-ndjson',
        })
        expect(count.output.schema.type).toBe('number')
        const slow = todosDoc.actions.find((entry: { action: string }) => entry.action === 'slow')
        expect(slow.options).toEqual({})
        expect(manifest.errors['server.not-found']).toBe(404)

        const openapi = yield* Edge.actions.handle(new Request('http://edge/docs/openapi.json'))
        expect(openapi.status).toBe(200)
        const oas = (yield* until(openapi.json())) as AnyType
        expect(oas.openapi).toBe('3.1.0')
        expect(oas.info).toEqual({ title: 'demo', version: '2.0.0' })
        const createOp = oas.paths['/todos/create'].post
        expect(createOp.operationId).toBe('todos.create')
        expect(createOp.summary).toBe('todos.create')
        expect(createOp.requestBody.content['application/json'].schema.properties.title.type).toBe(
          'string',
        )
        expect(createOp.responses['200'].content['application/json'].schema.required).toEqual([
          'id',
          'title',
          'done',
        ])

        const panel = yield* Edge.actions.handle(new Request('http://edge/docs'))
        expect(panel.headers.get('content-type')).toContain('text/html')
        const html = yield* until(panel.text())
        expect(html).toContain('demo api')
        expect(html).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/u)
        // the observe console is mounted too
        const console = yield* Edge.actions.handle(new Request('http://edge/_observe'))
        expect(console.status).toBe(200)
        const live = yield* Edge.actions.handle(new Request('http://edge/_observe/api/requests'))
        expect(live.status).toBe(200)
        yield* server.stop()
      }),
    )
  })
})
