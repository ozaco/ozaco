import type { ConfigDef } from 'std:config'
import { Config } from 'std:config'
import { run } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

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

describe('config extends resolution', () => {
  it('resolves a relative extends target; own keys win over inherited ones', async () => {
    const root = await makeRoot()
    try {
      await mkdir(join(root, 'presets'))
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({ extends: './presets/base.json', mode: 'own', own: true }),
      )
      await writeFile(
        join(root, 'presets', 'base.json'),
        jsonText({ mode: 'preset', presetOnly: 42 }),
      )

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        const tree = yield* Config.actions.tree()
        return {
          merged: yield* Config.actions.get(),
          extendsPath: tree[0]?.extends[0]?.path,
          extendsSpec: tree[0]?.extendsSpec,
        }
      })

      expect(unwrap(outcome)).toEqual({
        // the `extends` key itself never appears in the merged view
        merged: { mode: 'own', own: true, presetOnly: 42 },
        extendsPath: join(root, 'presets', 'base.json'),
        extendsSpec: './presets/base.json',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves extends lists transitively; later entries win; cycles are skipped', async () => {
    const root = await makeRoot()
    try {
      await writeFile(
        join(root, '.cfgspec.json'),
        jsonText({ extends: ['./a.json', './b.json'], top: true }),
      )
      await writeFile(join(root, 'a.json'), jsonText({ from: 'a', a: 1 }))
      await writeFile(join(root, 'b.json'), jsonText({ extends: './c.json', from: 'b', b: 2 }))
      // c closes a cycle back to the base file — already seen, so it is skipped, not re-read
      await writeFile(
        join(root, 'c.json'),
        jsonText({ extends: './.cfgspec.json', from: 'c', c: 3 }),
      )

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })

        const tree = yield* Config.actions.tree()
        const b = tree[0]?.extends.find(source => source.path === join(root, 'b.json'))
        const c = b?.extends[0]

        return {
          merged: yield* Config.actions.get(),
          cycleExtends: c?.extends.length,
        }
      })

      expect(unwrap(outcome)).toEqual({
        merged: { top: true, from: 'b', a: 1, b: 2, c: 3 },
        cycleExtends: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails the load when an extends target is missing', async () => {
    const root = await makeRoot()
    try {
      await writeFile(join(root, '.cfgspec.json'), jsonText({ extends: './nope.json' }))

      const outcome = await run(function* () {
        yield* bootstrap({ cwd: root, home: root })
        return 'unreachable'
      })

      expect(isFailure(outcome)).toBe(true)
      if (isFailure(outcome)) {
        expect(String(outcome.error)).toContain('extends a missing file')
        expect(String(outcome.error)).toContain('nope.json')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
