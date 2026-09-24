/**
 * `Options.path`: a config that targets exactly ONE file — no discovery walk, no variant, config
 * dir or env overlay; the file is the working file.
 */
import { Config } from 'std:config'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-path-'))
const jsonText = (value: unknown) => JSON.stringify(value)

describe('config path (single file)', () => {
  it('loads exactly the named file — neighbours, parents, variants, env are ignored', async () => {
    const root = await makeRoot()
    const inner = join(root, 'inner')
    const previous = process.env.CFGSPEC_FROM_ENV
    try {
      await mkdir(join(inner, '.cfgspec'), { recursive: true })
      // what discovery WOULD merge: a parent base file, a sibling base file, a variant, a dir file
      await writeFile(join(root, '.cfgspec.json'), jsonText({ parent: true }))
      await writeFile(join(inner, '.cfgspec.json'), jsonText({ sibling: true }))
      await writeFile(join(inner, '.prod.cfgspec.json'), jsonText({ variant: true }))
      await writeFile(join(inner, '.cfgspec', 'extra.json'), jsonText({ dir: true }))
      await writeFile(join(inner, 'tool.json'), jsonText({ only: 'me', nested: { a: 1 } }))
      process.env.CFGSPEC_FROM_ENV = 'x'

      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* JsonCodec.use()
        yield* Config.use({
          codec: JsonCodec,
          name: 'cfgspec',
          variant: 'prod',
          path: join(inner, 'tool.json'),
        })
        yield* Config.actions.load(root) // the cwd argument is ignored in path mode

        return {
          merged: yield* Config.actions.get(),
          tree: (yield* Config.actions.tree()).map(source => source.path),
        }
      })

      expect(unwrap(outcome)).toEqual({
        merged: { only: 'me', nested: { a: 1 } },
        tree: [join(inner, 'tool.json')],
      })
    } finally {
      if (previous === undefined) {
        delete process.env.CFGSPEC_FROM_ENV
      } else {
        process.env.CFGSPEC_FROM_ENV = previous
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('open({ path, codec }) edits and saves that file; its own extends still resolve', async () => {
    const root = await makeRoot()
    try {
      const file = join(root, 'settings.json')
      await writeFile(join(root, 'base.json'), jsonText({ inherited: 1 }))
      await writeFile(file, jsonText({ extends: './base.json', own: 1 }))

      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* JsonCodec.use()
        yield* Config.use({ codec: JsonCodec })

        const config = yield* Config.actions.open({ path: file, codec: JsonCodec })
        yield* config.load()
        const before = yield* config.get()

        yield* config.set('added', true)
        yield* config.save()

        return before
      })

      expect(unwrap(outcome)).toEqual({ inherited: 1, own: 1 })
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        extends: './base.json',
        own: 1,
        added: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a missing file loads empty and the first save creates it', async () => {
    const root = await makeRoot()
    try {
      const file = join(root, 'nested', 'fresh.json')

      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* JsonCodec.use()
        yield* Config.use({ codec: JsonCodec })

        const config = yield* Config.actions.open({ path: file, codec: JsonCodec })
        yield* config.load()
        const empty = yield* config.get()
        const tree = yield* config.tree()

        yield* config.set('created', 'yes')
        yield* config.save()
        yield* config.refresh()

        return { empty, treeSize: tree.length, after: yield* config.get('created') }
      })

      expect(unwrap(outcome)).toEqual({ empty: {}, treeSize: 0, after: 'yes' })
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ created: 'yes' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
