import { generate, pull, schemaToType } from 'client:codegen'
import type { Operation } from 'std:effect'
import { run, scoped } from 'std:effect'
import { FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import type { Result } from 'std:result'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { bootServer } from './helpers'

/** A hand-written OZACO MANIFEST v1 fixture covering every schema shape codegen must handle. */
const manifestFixture = {
  ozaco: '1.0',
  app: { title: 'Fixture', version: '1.0.0' },
  errors: { 'server:core.not-found': { status: 404 } },
  services: {
    tasks: {
      version: '0.1.0',
      prefix: '/tasks',
      functions: {
        list: {
          kind: 'query',
          route: { method: 'GET', path: '/tasks' },
          args: {
            type: 'object',
            properties: {
              limit: { type: 'number' },
              state: { enum: ['open', 'closed'] },
              filter: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['limit'],
          },
          returns: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { _id: { type: 'string' }, title: { type: 'string' } },
                  required: ['_id', 'title'],
                },
              },
              cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              version: { type: 'integer' },
            },
            required: ['data', 'cursor', 'version'],
          },
          channels: { input: ['value'], output: ['value'] },
        },
        create: {
          kind: 'mutation',
          route: { method: 'POST', path: '/tasks' },
          args: { declared: true },
          channels: { input: ['value'], output: ['value'] },
        },
        mode: {
          kind: 'query',
          args: { const: 'strict' },
          returns: { type: ['string', 'null'] },
          channels: { input: ['value'], output: ['value'] },
        },
      },
      realtime: {
        path: '/tasks/_realtime',
        client: { watch: {}, unwatch: {} },
        server: { sync: {}, delta: {}, reset: {}, error: {} },
      },
    },
  },
}

/** `generate` emits key literals through the codec, so it needs `JsonCodec` in scope. */
const codegen = <T>(body: () => Operation<T>): Promise<Result<T>> =>
  run(() =>
    scoped(function* () {
      yield* install(JsonCodec)

      return yield* body()
    }),
  )

const emit = async (manifest: unknown, options?: { banner: string }): Promise<string> =>
  unwrap(await codegen(() => generate(manifest, options))) as string

describe('client codegen', () => {
  it('emits the Api interface with real types derived from the JSON Schemas', async () => {
    const source = await emit(manifestFixture)

    expect(source).toContain('export interface Api {')
    expect(source).toContain('readonly tasks: {')
    expect(source).toContain("readonly kind: 'query'")

    // object properties with required/optional split
    expect(source).toContain('limit: number')
    expect(source).toContain("state?: 'open' | 'closed'")

    // additionalProperties index signature, arrays, unions, integer → number
    expect(source).toContain('[key: string]: string')
    expect(source).toContain('}[]')
    expect(source).toContain('cursor: string | null')
    expect(source).toContain('version: number')

    // `{ declared: true }` and absent schemas degrade to unknown
    expect(source).toContain('readonly args: unknown')

    // const literals and type arrays
    expect(source).toContain("'strict'")
    expect(source).toContain('string | null')
  })

  it('emits apiMeta with routes and realtime paths', async () => {
    const source = await emit(manifestFixture, { banner: '// custom banner' })

    expect(source.startsWith('// custom banner')).toBe(true)
    expect(source).toContain('export const apiMeta = {')
    expect(source).toContain("prefix: '/tasks'")
    expect(source).toContain("realtime: '/tasks/_realtime'")
    expect(source).toContain("list: { kind: 'query', route: { method: 'GET', path: '/tasks' } }")
    expect(source).toContain("mode: { kind: 'query', route: null }")
    expect(source).toContain('} as const')
  })

  it('emits syntactically valid TypeScript (Bun.Transpiler accepts it)', async () => {
    const source = await emit(manifestFixture)
    const transpiler = new Bun.Transpiler({ loader: 'ts' })

    expect(() => transpiler.transformSync(source)).not.toThrow()
    expect(transpiler.transformSync(source)).toContain('apiMeta')
  })

  it('rejects non-manifest input with client.manifest', async () => {
    const outcome = await codegen(() => generate({ not: 'a manifest' }))

    expect((outcome as { error?: string }).error).toBe('client.manifest')
  })

  it('covers schema corner cases', () => {
    expect(schemaToType({ declared: true })).toBe('unknown')
    expect(schemaToType(undefined)).toBe('unknown')
    expect(schemaToType({ type: 'array' })).toBe('unknown[]')
    expect(schemaToType({ type: 'object' })).toBe('Record<string, unknown>')
    expect(schemaToType({ type: 'object', additionalProperties: false })).toBe(
      'Record<string, never>',
    )
    expect(schemaToType({ anyOf: [{ const: 1 }, { const: 2 }] })).toBe('1 | 2')
    expect(schemaToType({ allOf: [{ type: 'string' }, { const: 'a' }] })).toBe("string & 'a'")
    expect(
      schemaToType({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }),
    ).toBe('(string | number)[]')
    expect(
      schemaToType({ type: 'object', properties: { 'kebab-key': { type: 'boolean' } } }),
    ).toContain("'kebab-key'?: boolean")
  })

  it('pulls the live manifest from a real server and generates from it', async () => {
    const source = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* install(FetchClient)

        return yield* pull(info.url)
      }),
    )

    expect(source).toContain('export interface Api {')
    expect(source).toContain('readonly tasks: {')
    expect(source).toContain('readonly list:')
    expect(source).toContain("prefix: '/tasks'")

    const transpiler = new Bun.Transpiler({ loader: 'ts' })

    expect(() => transpiler.transformSync(source)).not.toThrow()
  })
})
