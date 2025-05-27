import type { PackageJson } from 'type-fest'

import { type BuildEntry, build } from './utils/build'
import { buildTypes } from './utils/build-types'
import { buildTsx } from './utils/build-tsx'

export interface ActionOptions {
  cwd: string
  watch: boolean

  target: 'bun' | 'browser' | 'node'
  env: 'development' | 'production' | 'test'
  packages: string[]

  exports: PackageJson['exports']
  tsxExports: string[]
  external: string[]
}

export const action = async (options: ActionOptions) => {
  const allTargetPaths: string[] = []
  const buildEntries: BuildEntry[] = []
  const tsxBuildEntries: BuildEntry[] = []

  for (const [rawName, definition] of Object.entries(options.exports ?? {})) {
    const name = rawName === '.' ? 'default' : rawName.replace('./', '')

    // if user specified packages, skip all other exports
    if (options.packages.length > 0 && !options.packages.includes(name)) {
      continue
    }

    if (
      !definition ||
      typeof definition !== 'object' ||
      Array.isArray(definition) ||
      typeof definition.source !== 'string'
    ) {
      throw new Error(`Invalid exports definition ${name}`)
    }

    if (allTargetPaths.includes(definition.source)) {
      throw new Error(`Duplicate export path in definition ${name}`)
    }

    if (options.tsxExports.includes(name)) {
      tsxBuildEntries.push({
        name,
        source: definition.source,
        default: definition.default as string,
        types: definition.types as string,
      })

      continue
    }

    buildEntries.push({
      name,
      source: definition.source,
      default: definition.default as string,
      types: definition.types as string,
    })
  }

  if (buildEntries.length > 0) {
    await build({
      env: options.env,
      cwd: options.cwd,
      target: options.target,
      external: options.external,

      entries: buildEntries,
    })
  }

  if (tsxBuildEntries.length > 0) {
    await buildTsx({
      env: options.env,
      cwd: options.cwd,
      target: options.target,
      external: options.external,

      entries: tsxBuildEntries,
    })
  }

  await buildTypes({
    cwd: options.cwd,
    watch: options.watch,

    entries: [...buildEntries, ...tsxBuildEntries],
  })
}
