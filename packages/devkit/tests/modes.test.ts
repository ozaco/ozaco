import { describe, expect, it } from 'bun:test'
/**
 * The two import modes devkit sells, guarded from the devkit side:
 *
 *   MODE 1  `types: ["@ozaco/devkit"]` — every alias `ambient.d.ts` declares must be one the
 *           build plugin also resolves, and vice versa. The two registries are edited by hand in
 *           different files, and a miss is silent: the editor types an alias the bundler then
 *           cannot resolve (or the reverse).
 *   MODE 2  no devkit — `@ozaco/*` as published (that direction is `published-types.test.ts`).
 *
 * Plus the shipped lint preset, which is what keeps `@ozaco/*` out of a mode-1 project: it can
 * only do that if it is actually published with the package.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  aiResolve,
  clientResolve,
  cliResolve,
  dbResolve,
  kitResolve,
  serverResolve,
  stdResolve,
  transportResolve,
} from '../src/resolve'

const root = join(import.meta.dirname, '..')

const source = (file: string): string => readFileSync(join(root, file), 'utf8')

const plugins = {
  std: stdResolve,
  server: serverResolve,
  db: dbResolve,
  transport: transportResolve,
  ai: aiResolve,
  cli: cliResolve,
  client: clientResolve,
} as const

type Prefix = keyof typeof plugins

const PREFIXES = Object.keys(plugins) as readonly Prefix[]
const family = new RegExp(String.raw`^(${PREFIXES.join('|')}):`, 'u')

/** `declare module 'db:impl/memory' {` — the aliases the editor gets in mode 1. */
const declared = (): readonly string[] =>
  [...source('ambient.d.ts').matchAll(/^declare module '([^']+)'/gmu)].map(match => match[1]!)

/** `'db:impl/memory': {` — one entry of a module registry, i.e. an alias the plugin resolves. */
const registered = (): readonly string[] =>
  [...source('src/resolve.ts').matchAll(/^ {2}'([^']+)': \{/gmu)].map(match => match[1]!)

const resolved = (alias: string): unknown => {
  const prefix = alias.slice(0, alias.indexOf(':')) as Prefix
  const plugin = plugins[prefix].rolldown()

  return (plugin.resolveId as (id: string) => unknown)(alias)
}

describe('devkit — mode 1: the alias surface', () => {
  it('declares an alias for every module the build plugin resolves', () => {
    expect(registered().filter(alias => !declared().includes(alias))).toEqual([])
  })

  it('resolves every declared alias to its published package', () => {
    const unresolved = declared()
      .filter(alias => family.test(alias))
      .filter(alias => {
        const target = resolved(alias) as { id?: string; external?: boolean } | undefined
        const pkg = `@ozaco/${alias.slice(0, alias.indexOf(':'))}`

        return !(target?.external === true && (target.id ?? '').startsWith(pkg))
      })

    expect(unresolved).toEqual([])
  })

  it('declares nothing outside the alias families', () => {
    expect(declared().filter(alias => !family.test(alias))).toEqual([])
  })
})

describe('devkit — mode 1: the lint preset', () => {
  const preset = JSON.parse(source('oxlintrc.json')) as {
    rules: Record<string, [string, { patterns: readonly { group: readonly string[] }[] }]>
  }

  const manifest = JSON.parse(source('package.json')) as {
    files: readonly string[]
    exports: Record<string, unknown>
  }

  it('turns a `@ozaco/*` import into an error', () => {
    const [severity, options] = preset.rules['eslint/no-restricted-imports']!

    expect(severity).toBe('error')
    expect(options.patterns.flatMap(pattern => pattern.group)).toContain('@ozaco/**')
  })

  it('ships with the package', () => {
    expect(manifest.files).toContain('oxlintrc.json')
    expect(manifest.exports['./oxlintrc.json']).toBe('./oxlintrc.json')
  })
})

describe('devkit — mode 1: kitResolve', () => {
  const kit = kitResolve.rolldown()
  /** Detached, so there is no bundler context to delegate to: the plugin answers the specifier
   * itself, which is exactly what a context-less bundler (webpack, esbuild) receives. */
  const answer = kit.resolveId as (id: string) => Promise<unknown>

  it('answers every declared alias with its package specifier', async () => {
    const answers = await Promise.all(declared().map(async alias => [alias, await answer(alias)]))

    expect(answers.filter(([, id]) => typeof id !== 'string' || !id.startsWith('@ozaco/'))).toEqual(
      [],
    )
  })

  it('covers all seven families in the one plugin', async () => {
    expect(
      await Promise.all(
        [
          'std:shared',
          'transport:core',
          'db:core',
          'server:core',
          'client:core',
          'ai:core',
          'cli:core',
        ].map(answer),
      ),
    ).toEqual([
      '@ozaco/std/shared',
      '@ozaco/transport',
      '@ozaco/db',
      '@ozaco/server',
      '@ozaco/client',
      '@ozaco/ai',
      '@ozaco/cli',
    ])
  })

  it('leaves every other specifier to the bundler', async () => {
    expect(await answer('react')).toBeUndefined()
    expect(await answer('@ozaco/devkit/resolve')).toBeUndefined()
  })
})
