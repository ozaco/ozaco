import { generate, schemaToType } from 'client:codegen'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

// `readonly` / `docs` / `enums` shape the emitted source; the defaults stay exactly as before.

const contactSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Full name' },
    tags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['lead', 'active', 'dnc'] },
    nested: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['a', 'b'] } },
      required: ['kind'],
    },
  },
  required: ['name', 'tags', 'status', 'nested'],
}

const manifest = {
  manifest: 'ozaco/2',
  name: 'codegen-test',
  version: '0.0.0',
  instance: 'i1',
  errors: {},
  services: [
    {
      name: 'contacts',
      version: '0.0.0',
      description: 'Customers',
      actions: [
        {
          id: 'contacts.get',
          service: 'contacts',
          action: 'get',
          kind: 'query',
          description: 'One customer by id',
          route: { method: 'GET', path: '/contacts/:id' },
          input: {
            plane: 'value',
            brand: null,
            contentType: null,
            schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          },
          output: {
            plane: 'value',
            brand: null,
            contentType: 'application/json',
            schema: contactSchema,
          },
          errors: {},
          tags: [],
          options: {},
        },
        {
          id: 'contacts.archive',
          service: 'contacts',
          action: 'archive',
          kind: 'mutation',
          route: { method: 'POST', path: '/contacts/archive' },
          input: {
            plane: 'value',
            brand: null,
            contentType: 'application/json',
            // the same key with OTHER values: kept apart under `status_archive`
            schema: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['archived', 'restored'] } },
            },
          },
          output: { plane: 'none', brand: null, contentType: null },
          errors: {},
          tags: [],
          options: {},
        },
      ],
    },
  ],
}

describe('codegen — options', () => {
  it('readonly emits readonly members and arrays, docs emits JSDoc, both off by default', () => {
    const plain = schemaToType(contactSchema)
    const styled = schemaToType(contactSchema, 0, { readonly: true, docs: true })

    expect(plain).toContain('  name: string')
    expect(plain).toContain('  tags: string[]')
    expect(plain).not.toContain('readonly')
    expect(plain).not.toContain('/**')

    expect(styled).toContain('  /** Full name */')
    expect(styled).toContain('  readonly name: string')
    expect(styled).toContain('  readonly tags: readonly string[]')
    expect(styled).toContain("  readonly status: 'lead' | 'active' | 'dnc'")
    expect(styled).toContain('    readonly kind:')
  })

  it('generate: service and action docs, readonly planes, and the apiEnums table', async () => {
    const source = unwrap(
      await run(() => generate(manifest, { readonly: true, docs: true, enums: true })),
    )

    expect(source).toContain('  /** Customers */')
    expect(source).toContain('    /** One customer by id */')
    expect(source).toContain('readonly tags: readonly string[]')
    expect(source).toContain('export const apiEnums = {')
    expect(source).toContain('  contacts: {')
    expect(source).toContain("    kind: ['a', 'b'],")
    expect(source).toContain("    status: ['lead', 'active', 'dnc'],")
    expect(source).toContain("    status_archive: ['archived', 'restored'],")
    expect(source).toContain('} as const')

    const bare = unwrap(await run(() => generate(manifest)))

    expect(bare).not.toContain('apiEnums')
    expect(bare).not.toContain('readonly tags: readonly')
    expect(bare).not.toContain('/** Customers */')
  })
})

describe('codegen — exactOptional', () => {
  it('widens every optional member with `| undefined`; the default stays a bare `?`', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, note: { type: 'string' } },
      required: ['name'],
    }

    expect(schemaToType(schema, 0, {})).toBe('{\n  name: string\n  note?: string\n}')
    expect(schemaToType(schema, 0, { exactOptional: true, readonly: true })).toBe(
      '{\n  readonly name: string\n  readonly note?: string | undefined\n}',
    )
  })
})
