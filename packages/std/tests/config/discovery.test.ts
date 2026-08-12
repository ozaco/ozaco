import type { ConfigDef } from 'std:config'
import { Config, Features } from 'std:config'
import { run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { TomlCodec } from 'std:codec/impl/toml'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))
const jsonText = (value: unknown) => JSON.stringify(value)

/** Install the io + codec impls and a JSON-backed config named `cfgspec`, then discover. */
const bootstrap = function* (options: ConfigDef.Options) {
  yield* install(BunIO)
  yield* install(JsonCodec)
  yield* install(Config, { codec: JsonCodec, name: 'cfgspec', ...options })
  yield* Config.actions.load()
}

describe('config discovery', () => {
  it('discovers the cwd base file and serves dotted reads', async () => {
    const root = await makeRoot()
    try {
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({ app: 'demo', server: { port: 3000 } }),
      )

      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ cwd: root, home: root })

          return {
            whole: yield* Config.actions.get(),
            port: yield* Config.actions.get('server.port'),
            has: yield* Config.actions.has('server.port'),
            missing: yield* Config.actions.has('server.tls'),
            keys: yield* Config.actions.keys(),
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        whole: { app: 'demo', server: { port: 3000 } },
        port: 3000,
        has: true,
        missing: false,
        keys: ['app', 'server.port'],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('merges parent levels under the cwd level; tree lists innermost first', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(app)
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({ level: 'outer', shared: 'outer', db: { host: 'localhost', port: 1 } }),
      )
      await writeFile(
        join(app, '.cfgspec.json'),
        jsonText({ level: 'inner', inner: { only: 1 }, db: { port: 2 } }),
      )

      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ cwd: app, home: root })

          return {
            merged: yield* Config.actions.get(),
            paths: (yield* Config.actions.tree()).map(source => source.path),
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        merged: {
          level: 'inner',
          shared: 'outer',
          inner: { only: 1 },
          db: { host: 'localhost', port: 2 },
        },
        paths: [join(app, '.cfgspec.json'), join(root, '.cfgspec.json')],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies per-level precedence: variant over config-dir files over the base file', async () => {
    const root = await makeRoot()
    try {
      await mkdir(join(root, '.cfgspec', 'nested'), { recursive: true })
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({ source: 'base', baseOnly: 'b', dup: 'base' }),
      )
      await writeFile(join(root, '.cfgspec', 'a.json'), jsonText({ dup: 'a', fromA: 1 }))
      await writeFile(join(root, '.cfgspec', 'z.json'), jsonText({ dup: 'z', fromZ: 1 }))
      await writeFile(join(root, '.cfgspec', 'nested', 'deep.json'), jsonText({ deepOnly: true }))
      await writeFile(join(root, '.dev.cfgspec.json'), jsonText({ source: 'variant' }))

      const outcome = await run(function* () {
        yield* install(BunIO)
        yield* install(JsonCodec)

        const withVariant = yield* scoped(function* () {
          yield* install(Config, {
            codec: JsonCodec,
            name: 'cfgspec',
            cwd: root,
            home: root,
            variant: 'dev',
          })
          yield* Config.actions.load()
          return {
            merged: yield* Config.actions.get(),
            origin: yield* Config.actions.origin('source'),
          }
        })

        const withoutVariant = yield* scoped(function* () {
          yield* install(Config, {
            codec: JsonCodec,
            name: 'cfgspec',
            cwd: root,
            home: root,
            features: Features.FILE | Features.CHAIN | Features.VARIANT | Features.DIR,
          })
          yield* Config.actions.load()
          return {
            source: yield* Config.actions.get('source'),
            dup: yield* Config.actions.get('dup'),
          }
        })

        return { withVariant, withoutVariant }
      })

      expect(unwrap(outcome)).toEqual({
        withVariant: {
          // variant wins the shared key; dir files (later name wins) and the base still contribute
          merged: {
            source: 'variant',
            baseOnly: 'b',
            dup: 'z',
            fromA: 1,
            fromZ: 1,
            deepOnly: true,
          },
          origin: join(root, '.dev.cfgspec.json'),
        },
        // no variant: the shared key falls back to the base file; dir files still beat it
        withoutVariant: { source: 'base', dup: 'z' },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('feature flags disable discovery layers independently', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(join(app, '.cfgspec'), { recursive: true })
      await writeFile(join(root, '.cfgspec.json'), jsonText({ level: 'outer' }))
      await writeFile(join(app, '.cfgspec.json'), jsonText({ source: 'base' }))
      await writeFile(join(app, '.cfgspec', 'extra.json'), jsonText({ fromDir: 1 }))
      await writeFile(join(app, '.dev.cfgspec.json'), jsonText({ source: 'variant' }))

      const outcome = await run(() =>
        scoped(function* () {
          // FILE only: no chain walk, no variant overlay, no config dir, no env overlay
          yield* bootstrap({ cwd: app, home: root, variant: 'dev', features: Features.FILE })

          return {
            merged: yield* Config.actions.get(),
            chainLength: (yield* Config.actions.tree()).length,
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({ merged: { source: 'base' }, chainLength: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('derives the default file extension from the codec (toml)', async () => {
    const root = await makeRoot()
    try {
      await writeFile(join(root, '.cfgspec.toml'), 'port = 8080\n\n[server]\nhost = "local"\n')

      const outcome = await run(() =>
        scoped(function* () {
          yield* install(BunIO)
          yield* install(TomlCodec)
          // no codec option: the default TomlCodec applies and `ext` derives to `toml`
          yield* install(Config, { name: 'cfgspec', cwd: root, home: root })
          yield* Config.actions.load()

          return {
            port: yield* Config.actions.get('port'),
            host: yield* Config.actions.get('server.host'),
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({ port: 8080, host: 'local' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
