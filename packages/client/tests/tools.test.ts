import type { ManifestDef } from 'client:core'
import {
  coerceField,
  exampleOf,
  fieldsOf,
  findEntry,
  groupsOf,
  matches,
  orphanSockets,
  pathParams,
} from 'client:core'

import { describe, expect, it } from 'bun:test'

type Manifest = ManifestDef.Manifest

const manifest: Manifest = {
  manifest: 'ozaco/1',
  name: 'demo',
  version: '1.0.0',
  instance: 'x',
  errors: {},
  sockets: [
    { path: '/todos/_realtime', service: 'todos', protocol: 'resource', description: null },
    { path: '/live/chat', service: null, protocol: 'chat', description: 'chat' },
  ],
  services: [
    {
      name: 'todos',
      version: '1.0.0',
      actions: [
        {
          id: 'todos.get',
          service: 'todos',
          action: 'get',
          kind: 'query',
          route: { method: 'GET', path: '/todos/:id' },
          input: {
            plane: 'value',
            brand: null,
            contentType: 'application/json',
            schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          },
          output: { plane: 'value', brand: null, contentType: 'application/json', schema: null },
          errors: {},
          tags: ['crud'],
          options: {},
        },
      ],
      sockets: [
        { path: '/todos/_realtime', service: 'todos', protocol: 'resource', description: null },
      ],
    },
  ],
}

describe('panel lib', () => {
  it('indexes the manifest into groups, sockets and searchable entries', () => {
    const groups = groupsOf(manifest)
    expect(groups[0]!.entries.map(entry => entry.id)).toEqual(['todos.get', 'ws:/todos/_realtime'])
    expect(orphanSockets(manifest).map(socket => socket.path)).toEqual(['/live/chat'])
    expect(findEntry(manifest, 'ws:/live/chat')?.kind).toBe('socket')
    expect(findEntry(manifest, 'todos.get')?.kind).toBe('action')
    expect(pathParams('/todos/:id/items/:item')).toEqual(['id', 'item'])
    const entry = groups[0]!.entries[0]!
    expect(matches(entry, 'GET')).toBe(true)
    expect(matches(entry, 'crud')).toBe(true)
    expect(matches(entry, 'nope')).toBe(false)
  })

  it('derives examples, fields and coercions from JSON Schema', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        n: { type: 'integer', default: 5 },
        flag: { type: 'boolean' },
        kind: { enum: ['a', 'b'] },
        nested: { type: 'object', properties: { deep: { type: 'number' } }, required: ['deep'] },
      },
      required: ['title'],
    }
    expect(exampleOf(schema)).toEqual({
      title: '',
      n: 5,
      flag: false,
      kind: 'a',
      nested: { deep: 0 },
    })
    const fields = fieldsOf(schema)
    expect(fields.map(field => `${field.name}:${field.type}${field.required ? '!' : ''}`)).toEqual([
      'title:string!',
      'n:integer',
      'flag:boolean',
      'kind:enum',
      'nested:object',
    ])
    expect(fields[3]!.options).toEqual(['a', 'b'])
    expect(coerceField('3', 'integer')).toBe(3)
    expect(coerceField('true', 'boolean')).toBe(true)
    expect(coerceField('{"a":1}', 'object')).toEqual({ a: 1 })
    expect(coerceField('', 'string')).toBeUndefined()
    expect(exampleOf({ declared: true })).toBeNull()
  })
})
