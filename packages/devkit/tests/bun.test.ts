import { describe, expect, it } from 'bun:test'

import { ozacoSpecifiers } from '../src/internal/specifiers'
import type { PluginBuild } from '../src/internal/specifiers'
import { kitSpecifiers } from '../src/resolve'

// `@ozaco/devkit/bun`: the family aliases resolve at runtime through one Bun plugin.

describe('devkit — bun preload', () => {
  it('maps every family alias to its published specifier', () => {
    const specifiers = kitSpecifiers()

    expect(specifiers.get('std:effect')).toBe('@ozaco/std/effect')
    expect(specifiers.get('db:core')).toBe('@ozaco/db')
    expect(specifiers.get('server:core')).toBe('@ozaco/server')
    expect(specifiers.get('server:impl/edge/bun')).toBe('@ozaco/server/edge/bun')
    expect(specifiers.get('client:codegen')).toBe('@ozaco/client/codegen')
  })

  it('registers one resolver per family and answers a real path from the importer', () => {
    const registered: {
      readonly namespace: string | undefined
      readonly callback: Parameters<PluginBuild['onResolve']>[1]
    }[] = []

    ozacoSpecifiers.setup({
      onResolve: (constraints, callback) => {
        registered.push({ namespace: constraints.namespace, callback })
      },
    })

    expect(registered.map(entry => entry.namespace)).toEqual([
      'std',
      'transport',
      'db',
      'server',
      'client',
      'ai',
      'cli',
    ])

    const std = registered.find(entry => entry.namespace === 'std')!
    const answered = std.callback({ path: 'effect', importer: import.meta.path, namespace: 'std' })

    expect(answered?.path).toContain('/std/')
    expect(
      std.callback({ path: 'no-such-module', importer: import.meta.path, namespace: 'std' }),
    ).toBeUndefined()
  })
})
