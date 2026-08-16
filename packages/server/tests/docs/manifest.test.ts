import { column, table } from 'db:core'
import { clientFrame, defineAction, defineService, serverFrame } from 'server:core'
import { crud, resource } from 'server:wizard'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { Docs, DocsErrors, manifestSchema } from 'server:plugin/docs'
import type { Manifest } from 'server:plugin/docs'
import { z } from 'zod'

import { runResult, runScoped } from '../helpers'

import { fixtureService, NoteErrors } from './helpers'

const APP = { title: 'Fixture API', version: '3.0.0', description: 'fixture app', auth: true }

const compileFixture = (): Promise<Manifest> =>
  runScoped(function* () {
    yield* install(Docs, APP)
    yield* Docs.actions.from({ prefix: '/notes', service: fixtureService() })

    return yield* Docs.actions.manifest()
  })

const strip = (schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> => {
  const raw = z.toJSONSchema(schema, { io }) as Record<string, unknown>

  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== '$schema'))
}

describe('docs manifest', () => {
  it('compiles a document the exported manifestSchema validates', async () => {
    const manifest = await compileFixture()

    expect(() => manifestSchema.parse(manifest)).not.toThrow()
    expect(manifest.ozaco).toBe('1.0')
    expect(manifest.app).toEqual({
      title: 'Fixture API',
      version: '3.0.0',
      description: 'fixture app',
    })
    expect(manifest.auth).toEqual({ bearer: true })

    const notes = manifest.services['notes']!

    expect(notes.prefix).toBe('/notes')
    expect(notes.version).toBe('2.1.0')
    expect(notes.description).toBe('notes fixture')
    expect(Object.keys(notes.functions).toSorted()).toEqual([
      'create',
      'get',
      'ingest',
      'tail',
      'upload',
      'watch',
    ])
  })

  it('infers kinds (GET → query, else mutation) and keeps explicit kinds', async () => {
    const manifest = await compileFixture()
    const functions = manifest.services['notes']!.functions

    expect(functions['get']!.kind).toBe('query')
    expect(functions['create']!.kind).toBe('mutation')
    expect(functions['tail']!.kind).toBe('stream')
    expect(functions['watch']!.kind).toBe('action')
  })

  it('joins routes onto the real mount prefix', async () => {
    const manifest = await compileFixture()
    const functions = manifest.services['notes']!.functions

    expect(functions['get']!.route).toEqual({ method: 'GET', path: '/notes/:id' })
    expect(functions['create']!.route).toEqual({ method: 'POST', path: '/notes' })
    expect(functions['tail']!.route).toEqual({ method: 'GET', path: '/notes/feed', sse: true })
    expect(functions['watch']!.route).toBeUndefined()
  })

  it('emits JSON Schema for zod declarations and { declared: true } for foreign schemas', async () => {
    const manifest = await compileFixture()
    const functions = manifest.services['notes']!.functions
    const get = functions['get']!

    expect(get.args?.['type']).toBe('object')
    expect(get.args?.['properties']).toMatchObject({ id: { type: 'string' } })
    expect(get.args?.['required']).toEqual(['id'])
    expect(get.returns?.['properties']).toMatchObject({
      id: { type: 'string' },
      title: { type: 'string' },
    })
    expect(get.returns?.['required']).toEqual(['id', 'title'])
    expect(JSON.stringify(get.args)).not.toContain('$schema')

    expect(functions['ingest']!.args).toEqual({ declared: true })

    const events = manifest.services['notes']!.events

    expect(events?.['created']).toMatchObject({ type: 'object' })
    expect(events?.['imported']).toEqual({ declared: true })
  })

  it('documents wire channels and per-function metadata', async () => {
    const manifest = await compileFixture()
    const functions = manifest.services['notes']!.functions

    expect(functions['upload']!.channels).toEqual({ input: ['value', 'parts'], output: ['value'] })
    expect(functions['tail']!.channels.output).toEqual(['stream'])
    expect(functions['watch']!.channels.input).toEqual(['socket'])
    expect(functions['get']!.title).toBe('Get note')
    expect(functions['get']!.tags).toEqual(['notes'])
    expect(functions['get']!.errors).toEqual({ [NoteErrors.NotFound]: { status: 404 } })
  })

  it('unions core error tags with every action error map', async () => {
    const manifest = await compileFixture()

    expect(manifest.errors[NoteErrors.NotFound]).toEqual({ status: 404 })
    expect(manifest.errors['server:core.not-found']).toEqual({ status: 404 })
    expect(manifest.errors['server:core.validation']).toEqual({ status: 400 })
    expect(manifest.errors['server:core.rate-limited']).toEqual({ status: 429 })
  })

  it('documents the realtime channel from the core frame vocabulary', async () => {
    const manifest = await compileFixture()
    const realtime = manifest.services['notes']!.realtime

    expect(realtime?.path).toBe('/notes/_realtime')
    expect(realtime?.client.watch).toEqual(strip(clientFrame.options[0]!, 'input'))
    expect(realtime?.client.unwatch).toEqual(strip(clientFrame.options[1]!, 'input'))
    expect(realtime?.server.sync).toEqual(strip(serverFrame.options[0]!, 'output'))
    expect(realtime?.server.delta).toEqual(strip(serverFrame.options[1]!, 'output'))
    expect(realtime?.server.reset).toEqual(strip(serverFrame.options[2]!, 'output'))
    expect(realtime?.server.error).toEqual(strip(serverFrame.options[3]!, 'output'))
  })

  it('honors an explicit realtimePath and plain-service prefix defaults', async () => {
    const manifest = await runScoped(function* () {
      yield* install(Docs)
      yield* Docs.actions.from({
        prefix: '/v2/notes',
        service: fixtureService(),
        realtimePath: '/live/notes',
      })

      return yield* Docs.actions.manifest()
    })

    expect(manifest.services['notes']!.prefix).toBe('/v2/notes')
    expect(manifest.services['notes']!.realtime?.path).toBe('/live/notes')

    const defaulted = await runScoped(function* () {
      yield* install(Docs)
      yield* Docs.actions.from(fixtureService())

      return yield* Docs.actions.manifest()
    })

    expect(defaulted.services['notes']!.prefix).toBe('/notes')
    expect(defaulted.services['notes']!.realtime?.path).toBe('/notes/_realtime')
  })

  it('auto-emits the realtime block (+ sse flag) for wizard-compiled resources', async () => {
    const tasks = table('tasks', { title: column.text(), done: column.boolean().default(false) })
    const api = resource(tasks, { ...crud(tasks) })

    const manifest = await runScoped(function* () {
      yield* install(Docs)
      // ZERO manual realtime config: no socket-wire action, no realtimePath on the entry
      yield* Docs.actions.from({ prefix: '/tasks', service: api.$wizard.service })

      return yield* Docs.actions.manifest()
    })

    expect(() => manifestSchema.parse(manifest)).not.toThrow()

    const realtime = manifest.services['tasks']!.realtime

    expect(realtime?.path).toBe('/tasks/_realtime')
    expect(realtime?.sse).toBe(true)
    expect(realtime?.client.watch).toEqual(strip(clientFrame.options[0]!, 'input'))
    expect(realtime?.server.sync).toEqual(strip(serverFrame.options[0]!, 'output'))

    // the SSE flavor itself is also documented as the reserved `realtime` fn on the real mount
    expect(manifest.services['tasks']!.functions['realtime']!.route).toEqual({
      method: 'GET',
      path: '/tasks/_realtime/sse',
      sse: true,
    })
  })

  it('emits the realtime block for a realtimePath-only entry (no socket action)', async () => {
    const socketless = () =>
      defineService({
        name: 'plain',
        actions: {
          get: defineAction({ route: { method: 'GET', path: '/' } }, function* () {
            return { ok: true }
          }),
        },
      })

    const manifest = await runScoped(function* () {
      yield* install(Docs)
      yield* Docs.actions.from({
        prefix: '/plain',
        service: socketless(),
        realtimePath: '/live/plain',
      })

      return yield* Docs.actions.manifest()
    })

    expect(() => manifestSchema.parse(manifest)).not.toThrow()

    const realtime = manifest.services['plain']!.realtime

    expect(realtime?.path).toBe('/live/plain')
    expect(realtime?.sse).toBeUndefined()
    expect(realtime?.client.unwatch).toEqual(strip(clientFrame.options[1]!, 'input'))

    // no realtimePath + no socket wire + no sse flavor still means NO block
    const bare = await runScoped(function* () {
      yield* install(Docs)
      yield* Docs.actions.from({ prefix: '/plain', service: socketless() })

      return yield* Docs.actions.manifest()
    })

    expect(bare.services['plain']!.realtime).toBeUndefined()
  })

  it('replaces entries by service name on later from() calls', async () => {
    const manifest = await runScoped(function* () {
      yield* install(Docs)
      yield* Docs.actions.from({ prefix: '/notes', service: fixtureService() })
      yield* Docs.actions.from({ prefix: '/v9/notes', service: fixtureService() })

      return yield* Docs.actions.manifest()
    })

    expect(Object.keys(manifest.services)).toEqual(['notes'])
    expect(manifest.services['notes']!.prefix).toBe('/v9/notes')
    expect(manifest.services['notes']!.functions['get']!.route?.path).toBe('/v9/notes/:id')
  })

  it('compiles an empty (but valid) manifest before any from() call', async () => {
    const manifest = await runScoped(function* () {
      yield* install(Docs)

      return yield* Docs.actions.manifest()
    })

    expect(() => manifestSchema.parse(manifest)).not.toThrow()
    expect(manifest.services).toEqual({})
    expect(manifest.app.title).toBe('Ozaco API')
  })

  it('fails server:docs.invalid-manifest when the document breaks the standard', async () => {
    const outcome = await runResult(function* () {
      yield* install(Docs)

      const broken = defineService({
        name: 'broken',
        actions: {
          boom: defineAction(
            { route: { method: 'GET', path: '/' }, errors: { 'broken.bad': Number.NaN } },
            function* () {
              return 1
            },
          ),
        },
      })

      return yield* Docs.actions.from(broken)
    })

    expect(isFailure(outcome)).toBe(true)

    if (isFailure(outcome)) {
      expect(String(outcome.error)).toBe(DocsErrors.InvalidManifest)
      expect(String(outcome.error)).toBe('server:docs.invalid-manifest')
      expect(outcome.message).toContain('manifestSchema')
    }
  })
})
