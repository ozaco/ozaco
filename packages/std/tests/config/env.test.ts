import type { ConfigDef } from 'std:config'
import { Config } from 'std:config'
import { run } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))
const jsonText = (value: unknown) => JSON.stringify(value)

const bootstrap = function* (options: ConfigDef.Options) {
  yield* install(BunIO)
  yield* install(JsonCodec)
  yield* install(Config, { codec: JsonCodec, name: 'cfgspec', ...options })
  yield* Config.actions.load()
}

const restoreEnv = (key: string, previous: string | undefined) => {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, key)
  } else {
    process.env[key] = previous
  }
}

describe('config provenance + env overlay', () => {
  it('explain lists every definer highest to lowest; origin is the first of them', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(app)
      await writeFile(join(root, '.cfgspec.json'), jsonText({ mode: 'outer' }))
      await writeFile(
        join(app, '.cfgspec.json'),
        jsonText({ extends: './preset.json', mode: 'inner' }),
      )
      await writeFile(join(app, 'preset.json'), jsonText({ mode: 'preset' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: app, home: root })

        return {
          explained: yield* Config.actions.explain('mode'),
          origin: yield* Config.actions.origin('mode'),
          unknownExplained: yield* Config.actions.explain('nope'),
          unknownOrigin: yield* Config.actions.origin('nope'),
        }
      })

      expect(unwrap(outcome)).toEqual({
        explained: [
          { path: join(app, '.cfgspec.json'), value: 'inner' },
          { path: join(app, 'preset.json'), value: 'preset' },
          { path: join(root, '.cfgspec.json'), value: 'outer' },
        ],
        origin: join(app, '.cfgspec.json'),
        unknownExplained: [],
        unknownOrigin: undefined,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('CFGSPEC_* env vars overlay the merge with coerced values and explain as <env>', async () => {
    const root = await makeRoot()
    const previousPort = process.env.CFGSPEC_SERVER_PORT
    const previousVerbose = process.env.CFGSPEC_FLAGS_VERBOSE
    const previousLabel = process.env.CFGSPEC_LABEL
    process.env.CFGSPEC_SERVER_PORT = '8080'
    process.env.CFGSPEC_FLAGS_VERBOSE = 'true'
    process.env.CFGSPEC_LABEL = 'plain'
    try {
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({ server: { port: 3000 }, label: 'file' }),
      )

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        return {
          port: yield* Config.actions.get('server.port'),
          verbose: yield* Config.actions.get('flags.verbose'),
          label: yield* Config.actions.get('label'),
          explained: yield* Config.actions.explain('server.port'),
        }
      })

      expect(unwrap(outcome)).toEqual({
        port: 8080,
        verbose: true,
        label: 'plain',
        explained: [
          { path: '<env>', value: 8080 },
          { path: join(root, '.cfgspec.json'), value: 3000 },
        ],
      })
    } finally {
      restoreEnv('CFGSPEC_SERVER_PORT', previousPort)
      restoreEnv('CFGSPEC_FLAGS_VERBOSE', previousVerbose)
      restoreEnv('CFGSPEC_LABEL', previousLabel)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('STD_CONFIG selects the active variant when no variant option is given', async () => {
    const root = await makeRoot()
    const previous = process.env.STD_CONFIG
    process.env.STD_CONFIG = 'prod'
    try {
      await writeFile(join(root, '.cfgspec.json'), jsonText({ mode: 'base', keep: true }))
      await writeFile(join(root, '.prod.cfgspec.json'), jsonText({ mode: 'prod' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })
        return yield* Config.actions.get()
      })

      expect(unwrap(outcome)).toEqual({ mode: 'prod', keep: true })
    } finally {
      restoreEnv('STD_CONFIG', previous)
      await rm(root, { recursive: true, force: true })
    }
  })
})
