import { acceptsFiles, findEntry, indexManifest, realtimeServices, ssePathOf } from 'client:core'
import type { ManifestDoc } from 'client:core'

import { describe, expect, test } from 'bun:test'

const realtime = {
  path: '/todos/_realtime',
  client: { watch: {}, unwatch: {} },
  server: { sync: {}, delta: {}, reset: {}, error: {} },
}

const manifest: ManifestDoc = {
  ozaco: '1.0',
  app: { title: 'Demo', version: '1.0.0' },
  auth: { bearer: true },
  errors: { 'server:core.bad-request': { status: 400 } },
  services: {
    todos: {
      version: '1.0.0',
      prefix: '/todos',
      functions: {
        list: {
          kind: 'query',
          route: { method: 'GET', path: '/todos' },
          args: { type: 'object' },
          channels: { input: ['value'], output: ['value'] },
          tags: ['crud'],
        },
        create: {
          kind: 'mutation',
          title: 'Create todo',
          route: { method: 'POST', path: '/todos' },
          channels: { input: ['value'], output: ['value'] },
          errors: { 'server:core.bad-request': { status: 400 } },
        },
      },
      realtime,
    },
    files: {
      version: '1.0.0',
      prefix: '/files',
      functions: {
        upload: {
          kind: 'action',
          route: { method: 'POST', path: '/files' },
          channels: { input: ['value', 'parts'], output: ['value'] },
        },
      },
    },
  },
}

describe('indexManifest', () => {
  test('flattens every function preserving manifest order', () => {
    const entries = indexManifest(manifest)

    expect(entries.map(entry => entry.id)).toEqual(['todos.list', 'todos.create', 'files.upload'])
    expect(entries[0]).toMatchObject({
      service: 'todos',
      key: 'list',
      kind: 'query',
      prefix: '/todos',
      tags: ['crud'],
      errors: {},
    })
    expect(entries[0]?.realtime).toEqual(realtime)
    expect(entries[2]?.realtime).toBeUndefined()
    expect(entries[1]?.errors).toEqual({ 'server:core.bad-request': { status: 400 } })
  })

  test('findFn resolves by id', () => {
    const entries = indexManifest(manifest)

    expect(findEntry(entries, 'todos.create')?.title).toBe('Create todo')
    expect(findEntry(entries, 'nope.nope')).toBeUndefined()
  })
})

describe('realtime helpers', () => {
  test('realtimeServices lists only realtime-capable services', () => {
    const services = realtimeServices(manifest)

    expect(services).toHaveLength(1)
    expect(services[0]).toMatchObject({
      service: 'todos',
      prefix: '/todos',
      functions: ['list', 'create'],
    })
  })

  test('ssePathOf appends /sse to the realtime path', () => {
    expect(ssePathOf(realtime)).toBe('/todos/_realtime/sse')
  })
})

describe('acceptsFiles', () => {
  test('true only for parts-wired inputs', () => {
    const entries = indexManifest(manifest)

    expect(acceptsFiles(findEntry(entries, 'files.upload')!)).toBe(true)
    expect(acceptsFiles(findEntry(entries, 'todos.list')!)).toBe(false)
  })
})
