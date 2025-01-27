import type { PackageJson } from 'type-fest'

import { type BuildEntry, build } from './utils/build'
import { buildTypes } from './utils/build-types'

export interface ActionOptions {
  cwd: string

  target: 'server' | 'browser'
  env: 'development' | 'production' | 'test'
  packages: string[]

  exports: PackageJson['exports']
  external: string[]
}

export const action = async (options: ActionOptions) => {
  const allTargetPaths: string[] = []
  const buildEntries: BuildEntry[] = []

  for (const [rawName, definition] of Object.entries(options.exports ?? {})) {
    const name = rawName === '.' ? 'index' : rawName.replace('./', '')

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

    buildEntries.push({
      name,
      source: definition.source,
      default: definition.default as string,
      types: definition.types as string,
    })
  }

  await build({
    env: options.env,
    cwd: options.cwd,
    target: options.target,
    external: options.external,

    entries: buildEntries,
  })

  await buildTypes({
    cwd: options.cwd,
    entries: buildEntries,
  })
}
