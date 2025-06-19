import { exists, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { $, Glob } from 'bun'
import { prettyMs } from '../../../../src'
import type { BuildEntry } from './build'

interface BuildTypesOptions {
  name: string

  cwd: string
  watch: boolean
  json: boolean
  references: boolean

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

      await (async () => {
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

      await (async () => {
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
    {} as Record<string, BuildEntry[]>,
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
          cwd: options.cwd,
          onlyFiles: true,
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
          const fileDirname = dirname(entry.source)

          const originalFile = await Bun.file(join(options.cwd, entry.source)).text()
          const splitted = originalFile.split('\n')

          const referenceTargets: string[] = []

          for (const line of splitted) {
            if (line.includes('/// <reference path="')) {
              const targetPath = line.slice('/// <reference path="'.length, line.lastIndexOf('"'))
              referenceTargets.push(join(options.cwd, fileDirname, targetPath))
            }
          }

          let references = ''

          if (referenceTargets.length > 0) {
            const foundTargets = referenceTargets
              .map(referenceTarget => {
                return options.entries.find(rawEntry => join(options.cwd, rawEntry.source) === referenceTarget)
              })
              .filter(x => !!x && x.name !== 'default') as BuildEntry[]

            references = `${foundTargets.map(targetEntry => `/// <reference types="${options.name}/${targetEntry.name}" preserve="true" />`).join('\n')}\n\n`
          }

          await Bun.write(
            // biome-ignore lint/style/noNonNullAssertion: Redundant
            join(options.cwd, entry.types!),
            `${references}export * from './${join('.types', inputDir, filename)}'`.replaceAll('\\', '/'),
          )
        }),
      )
    }),
  )
}
