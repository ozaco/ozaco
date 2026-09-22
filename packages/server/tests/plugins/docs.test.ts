import { createServer, Edge, ServerErrors } from 'server:core'
import { Auth, Docs, manifestSchema, ObservePlugin, Resilience, StaticAuth } from 'server:plugins'
import { attempt, run, until } from 'std:effect'
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

  it('`auth` gates every docs route through Auth; the manifest documents the install default', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [
            StaticAuth.use({ tokens: { 'tok-docs': { sub: 'docs' } } }),
            Auth.use({ default: 'authenticated' }),
            Docs.use({ auth: 'authenticated' }),
          ],
        })
        yield* server.start()
        for (const path of ['/docs', '/docs/manifest', '/docs/openapi.json']) {
          const denied = yield* Edge.actions.handle(new Request(`http://edge${path}`))
          expect(denied.status).toBe(401)
          const allowed = yield* Edge.actions.handle(
            new Request(`http://edge${path}`, { headers: { authorization: 'Bearer tok-docs' } }),
          )
          expect(allowed.status).toBe(200)
        }
        const response = yield* Edge.actions.handle(
          new Request('http://edge/docs/manifest', {
            headers: { authorization: 'Bearer tok-docs' },
          }),
        )
        const manifest = (yield* until(response.json())) as AnyType
        expect(manifestSchema.safeParse(manifest).success).toBe(true)
        // `todos.list` sets no `auth` of its own: documented as what the install default makes it
        const todosDoc = manifest.services.find((entry: { name: string }) => entry.name === 'todos')
        const list = todosDoc.actions.find((entry: { action: string }) => entry.action === 'list')
        expect(list.auth).toEqual({ kind: 'authenticated' })
        yield* server.stop()
      }),
    )

    // gating without the Auth plugin is a configuration failure at start (a fresh scope: the
    // Auth context above is scope-bound and would otherwise still be visible here)
    unwrap(
      await run(function* () {
        yield* storage()
        const bare = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [Docs.use({ auth: 'authenticated' })],
        })
        const started = yield* attempt(bare.start())
        expect((started as AnyType).error).toBe(ServerErrors.Configuration)
      }),
    )
  })
})
