import type { ConfigDef } from 'std:config'
import { Config } from 'std:config'
import { run } from 'std:effect'
import { IO } from 'std:io'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))
const jsonText = (value: unknown) => JSON.stringify(value)

const bootstrap = function* (options: ConfigDef.Options) {
  yield* BunIO.use()
  yield* JsonCodec.use()
  yield* Config.use({ codec: JsonCodec, name: 'cfgspec', ...options })
  yield* Config.actions.load()
}

describe('config refresh', () => {
  it('re-reads the sources at the current cwd and drops unsaved in-memory edits', async () => {
    const root = await makeRoot()
    try {
      const file = join(root, '.cfgspec.json')
      await writeFile(file, jsonText({ version: 1, keep: 'yes' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        const before = yield* Config.actions.get('version')
        // an unsaved edit lives only in memory…
        yield* Config.actions.set('unsaved', true)
        const editedInMemory = yield* Config.actions.has('unsaved')

        // …then the file changes on disk behind the plugin's back
        yield* IO.actions.write(file, jsonText({ version: 2, keep: 'yes' }))
        const stale = yield* Config.actions.get('version')

        yield* Config.actions.refresh()

        return {
          before,
          editedInMemory,
          stale,
          after: yield* Config.actions.get('version'),
          unsavedSurvives: yield* Config.actions.has('unsaved'),
          keep: yield* Config.actions.get('keep'),
        }
      })

      expect(unwrap(outcome)).toEqual({
        before: 1,
        editedInMemory: true,
        stale: 1,
        after: 2,
        unsavedSurvives: false,
        keep: 'yes',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps cwd where load left it (unlike load(cwd))', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(app)
      await writeFile(join(root, '.cfgspec.json'), jsonText({ level: 'outer' }))
      await writeFile(join(app, '.cfgspec.json'), jsonText({ level: 'inner' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        const atRoot = yield* Config.actions.get('level')
        yield* Config.actions.load(app)
        const atApp = yield* Config.actions.get('level')
        yield* Config.actions.refresh()

        return {
          atRoot,
          atApp,
          afterRefresh: yield* Config.actions.get('level'),
          chain: (yield* Config.actions.tree()).length,
        }
      })

      expect(unwrap(outcome)).toEqual({
        atRoot: 'outer',
        atApp: 'inner',
        afterRefresh: 'inner',
        chain: 2,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('config delete', () => {
  it('removes the working file by default and re-discovers', async () => {
    const root = await makeRoot()
    try {
      const file = join(root, '.cfgspec.json')
      await writeFile(file, jsonText({ gone: true }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        const before = yield* Config.actions.get()
        yield* Config.actions.delete()

        return {
          before,
          after: yield* Config.actions.get(),
          chain: (yield* Config.actions.tree()).length,
          onDisk: existsSync(file),
        }
      })

      expect(unwrap(outcome)).toEqual({
        before: { gone: true },
        after: {},
        chain: 0,
        onDisk: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes an explicit path (an outer level) and the merge drops its keys', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(app)
      const outer = join(root, '.cfgspec.json')
      await writeFile(outer, jsonText({ shared: 'outer', outerOnly: 1 }))
      await writeFile(join(app, '.cfgspec.json'), jsonText({ shared: 'inner' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: app, home: root })

        const before = yield* Config.actions.get()
        yield* Config.actions.delete(outer)

        return {
          before,
          after: yield* Config.actions.get(),
          paths: (yield* Config.actions.tree()).map(source => source.path),
          onDisk: existsSync(outer),
        }
      })

      expect(unwrap(outcome)).toEqual({
        before: { shared: 'inner', outerOnly: 1 },
        after: { shared: 'inner' },
        paths: [join(app, '.cfgspec.json')],
        onDisk: false,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is a no-op on a missing file (force remove) and still re-discovers', async () => {
    const root = await makeRoot()
    try {
      const outcome = await run(function* () {
        // nothing on disk: the working file does not exist yet
        yield* bootstrap({ cwd: root, home: root })
        yield* Config.actions.delete()
        return yield* Config.actions.get()
      })

      expect(unwrap(outcome)).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('config search', () => {
  it('matches dotted keys and stringified values case-insensitively', async () => {
    const root = await makeRoot()
    try {
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({
          server: { host: 'LocalHost', port: 8080 },
          database: { host: 'db.internal', pool: 10 },
          label: 'Port authority',
        }),
      )

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        return {
          byKey: yield* Config.actions.search('HOST'),
          byValue: yield* Config.actions.search('port'),
          numberValue: yield* Config.actions.search('8080'),
          nothing: yield* Config.actions.search('nope'),
        }
      })

      expect(unwrap(outcome)).toEqual({
        byKey: [
          { key: 'server.host', value: 'LocalHost' },
          { key: 'database.host', value: 'db.internal' },
        ],
        // 'server.port' by key, 'label' by value — leaf order follows the merged object
        byValue: [
          { key: 'server.port', value: 8080 },
          { key: 'label', value: 'Port authority' },
        ],
        numberValue: [{ key: 'server.port', value: 8080 }],
        nothing: [],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('searches the merged view, so overlays and in-memory edits are visible', async () => {
    const root = await makeRoot()
    try {
      const app = join(root, 'app')
      await mkdir(app)
      await writeFile(join(root, '.cfgspec.json'), jsonText({ shared: 'outer-value' }))
      await writeFile(join(app, '.cfgspec.json'), jsonText({ shared: 'inner-value' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: app, home: root })
        yield* Config.actions.set('fresh.flag', 'inner-flag')

        return yield* Config.actions.search('inner')
      })

      expect(unwrap(outcome)).toEqual([
        { key: 'shared', value: 'inner-value' },
        { key: 'fresh.flag', value: 'inner-flag' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
