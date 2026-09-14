import type { ConfigDef } from 'std:config'
import { Config, Features } from 'std:config'
import { run } from 'std:effect'
import { unwrap } from 'std:result'
import { hasFlag } from 'std:shared'

import { describe, expect, it } from 'bun:test'
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

const withEnv = async <T>(vars: Record<string, string>, body: () => Promise<T>) => {
  const previous = new Map(Object.keys(vars).map(key => [key, process.env[key]] as const))
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }
}

/**
 * Lay out every discovery layer at once: an outer level (CHAIN), a cwd base file (FILE), a config
 * dir (DIR) and a variant overlay (VARIANT). The caller sets `CFGSPEC_*` / `STD_CONFIG` for ENV.
 */
const layoutAllLayers = async (root: string) => {
  const app = join(root, 'app')
  await mkdir(join(app, '.cfgspec'), { recursive: true })
  await writeFile(join(root, '.cfgspec.json'), jsonText({ fromChain: 1, source: 'chain' }))
  await writeFile(join(app, '.cfgspec.json'), jsonText({ fromFile: 1, source: 'file' }))
  await writeFile(join(app, '.cfgspec', 'extra.json'), jsonText({ fromDir: 1, source: 'dir' }))
  await writeFile(join(app, '.dev.cfgspec.json'), jsonText({ fromVariant: 1, source: 'variant' }))
  return app
}

describe('Features bitflags', () => {
  it('allocates one bit per layer starting at bit 0; ALL is their union', () => {
    expect(Features.NONE).toBe(0)
    expect(Features.FILE).toBe(1)
    expect(Features.CHAIN).toBe(2)
    expect(Features.VARIANT).toBe(4)
    expect(Features.ENV).toBe(8)
    expect(Features.DIR).toBe(16)
    expect(Features.ALL).toBe(31)
    expect(Features.ALL).toBe(
      Features.FILE | Features.CHAIN | Features.VARIANT | Features.ENV | Features.DIR,
    )
  })

  it('hasFlag tests each layer independently', () => {
    const layers = [Features.FILE, Features.CHAIN, Features.VARIANT, Features.ENV, Features.DIR]

    for (const layer of layers) {
      expect(hasFlag(Features.ALL, layer)).toBe(true)
      expect(hasFlag(layer, layer)).toBe(true)
      expect(hasFlag(Features.NONE, layer)).toBe(false)
      // every OTHER layer is off when only `layer` is set
      for (const other of layers) {
        if (other !== layer) {
          expect(hasFlag(layer, other)).toBe(false)
        }
      }
    }

    const some = Features.FILE | Features.DIR
    expect(hasFlag(some, Features.FILE)).toBe(true)
    expect(hasFlag(some, Features.DIR)).toBe(true)
    expect(hasFlag(some, Features.CHAIN)).toBe(false)
    expect(hasFlag(some, Features.VARIANT)).toBe(false)
    expect(hasFlag(some, Features.ENV)).toBe(false)
  })

  it('Features.NONE disables every layer: load finds nothing', async () => {
    const root = await makeRoot()
    try {
      const app = await layoutAllLayers(root)

      const outcome = await withEnv({ CFGSPEC_FROM_ENV: '1', STD_CONFIG: 'dev' }, () =>
        run(function* () {
          yield* bootstrap({ cwd: app, home: root, features: Features.NONE })

          return {
            merged: yield* Config.actions.get(),
            chain: (yield* Config.actions.tree()).length,
            keys: yield* Config.actions.keys(),
            envOrigin: yield* Config.actions.origin('from.env'),
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({ merged: {}, chain: 0, keys: [], envOrigin: undefined })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Features.FILE alone discovers only the cwd base file', async () => {
    const root = await makeRoot()
    try {
      const app = await layoutAllLayers(root)

      const outcome = await withEnv({ CFGSPEC_FROM_ENV: '1', STD_CONFIG: 'dev' }, () =>
        run(function* () {
          // explicit `variant` too: with VARIANT off it must still be ignored
          yield* bootstrap({ cwd: app, home: root, variant: 'dev', features: Features.FILE })

          return {
            merged: yield* Config.actions.get(),
            paths: (yield* Config.actions.tree()).map(source => source.path),
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        merged: { fromFile: 1, source: 'file' },
        paths: [join(app, '.cfgspec.json')],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('Features.ALL (the default) enables every layer', async () => {
    const root = await makeRoot()
    try {
      const app = await layoutAllLayers(root)

      const outcome = await withEnv({ CFGSPEC_FROM_ENV: '1', STD_CONFIG: 'dev' }, () =>
        run(function* () {
          yield* bootstrap({ cwd: app, home: root })

          return {
            merged: yield* Config.actions.get(),
            chain: (yield* Config.actions.tree()).length,
          }
        }),
      )

      expect(unwrap(outcome)).toEqual({
        merged: {
          fromChain: 1,
          fromFile: 1,
          fromDir: 1,
          fromVariant: 1,
          from: { env: 1 },
          // variant → dir → file within the cwd level, all above the outer chain level
          source: 'variant',
        },
        // outer base + cwd base + cwd dir file + cwd variant
        chain: 4,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
