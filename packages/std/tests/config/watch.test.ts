import type { ConfigDef } from 'std:config'
import { Config } from 'std:config'
import { run, sleep, withResolvers } from 'std:effect'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { TomlCodec } from 'std:codec/impl/toml'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))
const jsonText = (value: unknown) => JSON.stringify(value)

describe('config watch', () => {
  it('a TOML-backed config watches with JsonCodec installed as the required baseline', async () => {
    const root = await makeRoot()
    const previousWatchman = process.env.STD_WATCHMAN
    process.env.STD_WATCHMAN = 'off'
    try {
      const base = join(root, '.cfgspec.toml')
      await writeFile(base, 'count = 1\n')

      const outcome = await run(function* () {
        yield* install(BunIO)
        // JsonCodec is config's baseline dependency (watch change-detection pins it);
        // TomlCodec is the codec the config FILES are parsed with
        yield* install(JsonCodec)
        yield* install(TomlCodec)
        yield* install(Config, { codec: TomlCodec, name: 'cfgspec', cwd: root, home: root })
        yield* Config.actions.load()

        const changed = withResolvers<ConfigDef.Object>()
        const task = yield* Config.actions.watch(merged => changed.resolve(merged), {
          debounce: 25,
        })

        yield* sleep(150)
        yield* IO.actions.write(base, 'count = 2\n')

        const merged = yield* changed.operation
        yield* task.halt()

        return merged
      })

      expect(unwrap(outcome)).toEqual({ count: 2 })
    } finally {
      if (previousWatchman === undefined) {
        delete process.env.STD_WATCHMAN
      } else {
        process.env.STD_WATCHMAN = previousWatchman
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invokes the listener with the re-merged view after a source file changes', async () => {
    const root = await makeRoot()
    // force the fs.watch fallback: hermetic, no Watchman daemon involved
    const previousWatchman = process.env.STD_WATCHMAN
    process.env.STD_WATCHMAN = 'off'
    try {
      const base = join(root, '.cfgspec.json')
      await writeFile(base, jsonText({ count: 1 }))

      const outcome = await run(function* () {
        yield* install(BunIO)
        yield* install(JsonCodec)
        yield* install(Config, { codec: JsonCodec, name: 'cfgspec', cwd: root, home: root })
        yield* Config.actions.load()

        const initial = yield* Config.actions.get('count')

        const changed = withResolvers<ConfigDef.Object>()
        const task = yield* Config.actions.watch(merged => changed.resolve(merged), {
          debounce: 25,
        })

        // give the fs watcher a beat to arm before touching the file
        yield* sleep(150)
        yield* IO.actions.write(base, jsonText({ count: 2 }))

        const merged = yield* changed.operation
        const live = yield* Config.actions.get('count')
        yield* task.halt()

        return { initial, merged, live }
      })

      expect(unwrap(outcome)).toEqual({ initial: 1, merged: { count: 2 }, live: 2 })
    } finally {
      if (previousWatchman === undefined) {
        delete process.env.STD_WATCHMAN
      } else {
        process.env.STD_WATCHMAN = previousWatchman
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
