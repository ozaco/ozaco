/**
 * The config plugin's contract on the details a consumer trips over: where discovery starts
 * without a `cwd`, how a watched file is matched to a watched directory on every platform, where
 * the file extension comes from, what `set` and `save(path)` do to the merged view and the dirty set.
 */
import type { ConfigDef } from 'std:config'
import { Config, ConfigErrors } from 'std:config'
import { attempt, run, useContext } from 'std:effect'
import { IO } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

import { withinDir } from '../../src/config/internal/utils'
import { fakeCodec } from '../helpers/fake-codec'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))
const jsonText = (value: unknown) => JSON.stringify(value)

const bootstrap = function* (options: ConfigDef.Options) {
  yield* BunIO.use()
  yield* JsonCodec.use()
  yield* Config.use({ codec: JsonCodec, name: 'cfgspec', ...options })
  yield* Config.actions.load()
}

describe('config — contract', () => {
  it('without a cwd option discovery starts at IO.actions.cwd() and stops at IO.actions.homeDir()', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()
      yield* JsonCodec.use()
      const ctx = yield* Config.use({ codec: JsonCodec, name: 'e' })
      return {
        cwd: ctx.cwd,
        home: ctx.home,
        ioCwd: yield* IO.actions.cwd(),
        ioHome: yield* IO.actions.homeDir(),
      }
    })
    const seen = unwrap(outcome)
    expect(seen.cwd).toBe(seen.ioCwd)
    expect(seen.home).toBe(seen.ioHome)
    expect(seen.cwd).toBe(process.cwd())
  })

  it('withinDir matches with the platform separator and never on a sibling prefix', () => {
    expect(withinDir('/x/.ozaco/a.json', '/x/.ozaco', '/')).toBe(true)
    expect(withinDir('/x/.ozaco-other/a.json', '/x/.ozaco', '/')).toBe(false)
    expect(withinDir(String.raw`C:\x\.ozaco\a.json`, String.raw`C:\x\.ozaco`, '\\')).toBe(true)
    expect(withinDir(String.raw`C:\x\.ozaco\a.json`, String.raw`C:\x\.ozaco`, '/')).toBe(false)
    expect(withinDir('/x/.ozaco/a.json', '/x/.ozaco/', '/')).toBe(true)
  })

  it('the extension comes from the installed codec — its default, or what it was installed with', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()
      yield* JsonCodec.use()
      const json = (yield* Config.use({ codec: JsonCodec, name: 'a' })).ext

      const Yml = fakeCodec('test/yml-codec')
      yield* Yml.use({ ext: 'yml' })
      const yml = (yield* Config.use({ codec: Yml, name: 'b' })).ext
      const explicit = (yield* Config.use({ codec: JsonCodec, name: 'c', ext: 'cfg' })).ext

      return { json, yml, explicit }
    })

    expect(unwrap(outcome)).toEqual({ json: 'json', yml: 'yml', explicit: 'cfg' })
  })

  it('a codec that is not installed is a configuration failure, not a silent `.toml`', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()
      const failed = yield* attempt(() => Config.use({ codec: JsonCodec, name: 'd' }))
      return isFailure(failed) ? failed.error : 'built'
    })

    expect(unwrap(outcome)).toBe(ConfigErrors.Configuration)
  })

  it('set is reflected at once even when the env overlay defines the key; refresh restores env', async () => {
    const root = await makeRoot()
    process.env['CFGSPEC_PORT'] = '9999'
    try {
      await writeFile(join(root, '.cfgspec.json'), jsonText({ port: 3000 }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })
        const fromEnv = yield* Config.actions.get('port')
        yield* Config.actions.set('port', 4000)
        const afterSet = yield* Config.actions.get('port')
        const origin = yield* Config.actions.origin('port')
        yield* Config.actions.refresh()
        const afterRefresh = yield* Config.actions.get('port')
        return { fromEnv, afterSet, origin, afterRefresh }
      })

      expect(unwrap(outcome)).toEqual({
        fromEnv: 9999,
        afterSet: 4000,
        origin: join(root, '.cfgspec.json'),
        afterRefresh: 9999,
      })
    } finally {
      delete process.env['CFGSPEC_PORT']
      await rm(root, { recursive: true, force: true })
    }
  })

  it('save(path) exports and keeps the sources dirty; the working path persists them', async () => {
    const root = await makeRoot()
    try {
      await writeFile(join(root, '.cfgspec.json'), jsonText({ name: 'file' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })
        const ctx = yield* useContext(Config)
        yield* Config.actions.set('name', 'edited')
        const dirtyAfterSet = ctx.dirty.size

        yield* Config.actions.save(join(root, 'export.json'))
        const dirtyAfterExport = ctx.dirty.size

        yield* Config.actions.save(ctx.working.path)
        const dirtyAfterOwnPath = ctx.dirty.size

        return { dirtyAfterSet, dirtyAfterExport, dirtyAfterOwnPath }
      })

      expect(unwrap(outcome)).toEqual({
        dirtyAfterSet: 1,
        dirtyAfterExport: 1,
        dirtyAfterOwnPath: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
