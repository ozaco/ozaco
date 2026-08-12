import type { ConfigDef } from 'std:config'
import { Config } from 'std:config'
import { run, scoped } from 'std:effect'
import { install } from 'std:plugin'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))
const jsonText = (value: unknown) => JSON.stringify(value)
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

const bootstrap = function* (options: ConfigDef.Options) {
  yield* install(BunIO)
  yield* install(JsonCodec)
  yield* install(Config, { codec: JsonCodec, name: 'cfgspec', ...options })
  yield* Config.actions.load()
}

describe('config editing', () => {
  it('set lands new keys in the working file; save creates it on disk', async () => {
    const root = await makeRoot()
    try {
      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ cwd: root, home: root })

          const before = (yield* Config.actions.tree()).length
          yield* Config.actions.set('fresh.key', 1)
          const merged = yield* Config.actions.get()

          yield* Config.actions.save()
          yield* Config.actions.load()
          const after = (yield* Config.actions.tree()).length

          return { before, merged, after }
        }),
      )

      // absent from the tree until written, present after save + reload
      expect(unwrap(outcome)).toEqual({ before: 0, merged: { fresh: { key: 1 } }, after: 1 })
      expect(await readJson(join(root, '.cfgspec.json'))).toEqual({ fresh: { key: 1 } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('set routes an existing key to the file that owns it, not the cwd file', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(app)
      await writeFile(join(root, '.cfgspec.json'), jsonText({ db: { host: 'localhost' } }))

      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ cwd: app, home: root })

          yield* Config.actions.set('db.port', 5432)
          yield* Config.actions.save()

          return yield* Config.actions.get('db')
        }),
      )

      expect(unwrap(outcome)).toEqual({ host: 'localhost', port: 5432 })
      // `db` lives in the root file — the edit was persisted there, no cwd file was invented
      expect(await readJson(join(root, '.cfgspec.json'))).toEqual({
        db: { host: 'localhost', port: 5432 },
      })
      expect(existsSync(join(app, '.cfgspec.json'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('remove and clear edit the merged view in memory; save persists them', async () => {
    const root = await makeRoot()
    try {
      await writeFile(join(root, '.cfgspec.json'), jsonText({ a: 1, b: { c: 2 } }))

      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ cwd: root, home: root })

          yield* Config.actions.remove('b.c')
          const afterRemove = {
            merged: yield* Config.actions.get(),
            hasRemoved: yield* Config.actions.has('b.c'),
          }

          yield* Config.actions.clear()
          const afterClear = yield* Config.actions.get()

          yield* Config.actions.save()

          return { afterRemove, afterClear }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        afterRemove: { merged: { a: 1, b: {} }, hasRemoved: false },
        afterClear: {},
      })
      expect(await readJson(join(root, '.cfgspec.json'))).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('save(path) exports the working payload with its extends spec intact', async () => {
    const root = await makeRoot()
    try {
      await writeFile(join(root, '.cfgspec.json'), jsonText({ extends: './preset.json', over: 1 }))
      await writeFile(join(root, 'preset.json'), jsonText({ under: 2 }))
      const exported = join(root, 'out', 'exported.json')

      const outcome = await run(() =>
        scoped(function* () {
          yield* bootstrap({ cwd: root, home: root })

          const merged = yield* Config.actions.get()
          yield* Config.actions.save(exported)
          return merged
        }),
      )

      expect(unwrap(outcome)).toEqual({ over: 1, under: 2 })
      // the export is the working file's own data + spec, not the merged view
      expect(await readJson(exported)).toEqual({ extends: './preset.json', over: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
