import { exists, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { $, Glob } from 'bun'
import { prettyMs } from '../../../../src'
import type { BuildEntry } from './build'

interface BuildTypesOptions {
  cwd: string
  watch: boolean
  json: boolean

  entries: BuildEntry[]
}

let proc: Bun.Subprocess | null = null

const DECODER = new TextDecoder()

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Redundant
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

  if (options.watch) {
    if (!proc) {
      proc = Bun.spawn({
        cmd: ['bun', 'x', 'tsc', '--project', './tsconfig.json', '--outDir', tempDir, '-w'],
        cwd: options.cwd,
        windowsHide: true,
      })

      // STDOUT
      ;(async () => {
        let lastBuildTime = performance.now()

        if (proc?.stdout instanceof ReadableStream) {
          for await (const data of proc.stdout) {
            const decoded = DECODER.decode(data)
            const currentTime = performance.now()

            if (decoded.includes('error ')) {
              console.error(decoded)
            }

            if (decoded.includes('Watching for file changes.')) {
              console.log(`ts build completed in ${prettyMs(currentTime - lastBuildTime)}`)
            }

            lastBuildTime = currentTime
          }
        }
      })()

      // STDERR
      ;(async () => {
        if (proc?.stderr instanceof ReadableStream) {
          for await (const data of proc.stderr) {
            console.error(DECODER.decode(data))
          }
        }
      })()
    }
  } else {
    await Bun.$`bun x tsc --project ./tsconfig.json --outDir ${tempDir}`.cwd(options.cwd)
  }

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

  if (options.json) {
    const tsconfig = await Bun.file(join(options.cwd, 'tsconfig.json')).json()
    const excludes = ((tsconfig.exclude ?? []) as string[]).map(pattern => new Glob(pattern))

    if (tsconfig.include) {
      for (const include of tsconfig.include) {
        if (!include.includes('json')) {
          continue
        }

        const glob = new Glob(include)

        for await (const file of glob.scan({
          onlyFiles: true,
          cwd: options.cwd,
        })) {
          if (excludes.some(exclude => exclude.match(file)) || file.includes('node_modules/')) {
            continue
          }

          await $`cp ${join(options.cwd, file)} ${join(tempDir, file)}`
        }
      }
    }
  }

  await Promise.all(
    Object.entries(grouped).map(async ([inputDir, entries]) => {
      await Promise.all(
        entries.map(async entry => {
          // biome-ignore lint/style/noNonNullAssertion: Redundant
          const filename = basename(entry.source!)

          await Bun.write(
            // biome-ignore lint/style/noNonNullAssertion: <explanation>
            join(options.cwd, entry.types!),
            `export * from './${join('.types', inputDir, filename)}'`.replaceAll('\\', '/')
          )
        })
      )
    })
  )
}
