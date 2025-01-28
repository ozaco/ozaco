import { exists, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { BuildEntry } from './build'

interface BuildTypesOptions {
  cwd: string

  entries: BuildEntry[]
}

export const buildTypes = async (options: BuildTypesOptions) => {
  if (options.entries.every(entry => !entry.types)) {
    return true
  }

  const tempDir = join(options.cwd, 'dist', '.types')

  if (!(await exists(tempDir))) {
    await mkdir(tempDir, {
      recursive: true,
    })
  }

  await Bun.$`bun x tsc --project ./tsconfig.json --outDir ${tempDir}`.cwd(options.cwd)

  const grouped = options.entries.reduce(
    (acc, curr) => {
      if (!curr.types) {
        return acc
      }

      const inputDir = dirname(curr.source)

      if (acc[inputDir]) {
        acc[inputDir].push(curr)
      } else {
        acc[inputDir] = [curr]
      }

      return acc
    },
    {} as Record<string, BuildEntry[]>
  )

  await Promise.all(
    Object.entries(grouped).map(async ([inputDir, entries]) => {
      await Promise.all(
        entries.map(async entry => {
          // biome-ignore lint/style/noNonNullAssertion: Redundant
          const filename = basename(entry.source!)

          await Bun.write(
            // biome-ignore lint/style/noNonNullAssertion: <explanation>
            join(options.cwd, entry.types!),
            `export * from './${join('.types', inputDir, filename)}'`
          )
        })
      )
    })
  )
}
