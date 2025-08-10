import { exists, mkdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { ActionOptions } from '../action'
import type { BuildEntry, BuildOptions } from './build'
import { findExports } from './find-exports'
import { fixDirectives } from './fix-directives'
import { fixExports } from './fix-exports'

export interface BuildFilesOptions extends Pick<ActionOptions, 'env' | 'cwd' | 'target' | 'external' | 'format'> {
  entries: string[]
}

export const buildFiles = async (
  type: 'barrel' | 'component',
  outputGenerated: string,
  options: BuildFilesOptions | BuildOptions,
) => {
  const buildOutput = await Bun.build({
    define: {
      'process.env.NODE_ENV': JSON.stringify(options.env),
    },
    emitDCEAnnotations: true,
    entrypoints:
      type === 'barrel' ? options.entries.map(entry => (entry as BuildEntry).source) : (options.entries as string[]),

    external: ['*'],
    format: options.format,
    minify:
      options.env === 'production'
        ? {
            identifiers: false,
            syntax: true,
            whitespace: true,
          }
        : false,

    plugins: [],
    root: options.cwd,
    sourcemap: 'linked',
    splitting: false,
    target: options.target,
    throw: false,
  })

  for (const output of buildOutput.outputs) {
    const filePath = join(outputGenerated, output.path)
    let code = await output.text()

    if ((filePath.endsWith('.js') || filePath.endsWith('.jsx')) && !filePath.includes('chunk-')) {
      code = fixExports(code)

      const targetEntry = (options.entries as string[]).find(
        entry =>
          entry === output.path.replace('.js', '.tsx') ||
          entry === output.path.replace('.js', '.jsx') ||
          entry === output.path.replace('.js', '.ts') ||
          entry === output.path,
      )

      if (targetEntry) {
        const sourcecode = await Bun.file(join(options.cwd, targetEntry)).text()
        code = fixDirectives(sourcecode, code)
      }
    }

    await Bun.write(filePath, code)
  }

  if (type === 'barrel') {
    await Promise.all(
      (options.entries as BuildEntry[]).map(async entry => {
        const filename = basename(entry.source).replace('.ts', '.js')
        const inputDir = dirname(entry.source)

        let targetPath = join('.generated-splits', inputDir, filename)

        if (!targetPath.startsWith('../')) {
          targetPath = `./${targetPath}`
        }

        await Bun.write(
          // biome-ignore lint/style/noNonNullAssertion: Redundant
          join(options.cwd, entry.default!),
          options.format === 'cjs'
            ? `// @bun @bun-cjs\nmodule.exports = require('${targetPath.replaceAll('\\', '/')}')`
            : `// @bun\nexport * from '${targetPath.replaceAll('\\', '/')}'`,
        )
      }),
    )
  }
}

export const splitBuild = async (options: BuildOptions) => {
  const outputDir = join(options.cwd, 'dist')
  const outputGenerated = join(outputDir, '.generated-splits')

  if (!(await exists(outputGenerated))) {
    await mkdir(outputGenerated, {
      recursive: true,
    })
  }

  const chunkFiles = [...new Bun.Glob(join(outputGenerated, './**/chunk-*')).scanSync()]

  await Promise.all(chunkFiles.map(file => unlink(file)))

  await buildFiles('barrel', outputGenerated, options)

  const glob = new Bun.Glob('**/*.{ts,js,tsx,jsx}')

  for (const entry of options.entries) {
    const filePath = join(options.cwd, entry.source)
    const fileDir = dirname(entry.source)
    const absoluteFileDir = join(options.cwd, fileDir)

    const rawExports = await findExports(filePath)
    const exports: string[] = []

    for await (const rawScannedFile of glob.scan(absoluteFileDir)) {
      const scannedFile = `./${rawScannedFile.replaceAll('\\', '/')}`

      for (const rawExport of rawExports) {
        if (
          scannedFile === `${rawExport}.tsx` ||
          scannedFile === `${rawExport}.jsx` ||
          scannedFile === `${rawExport}.ts` ||
          scannedFile === `${rawExport}.js`
        ) {
          exports.push(scannedFile)
        }
      }
    }

    if (rawExports.length !== exports.length) {
      throw new Error(`files not found (${entry.source})`)
    }

    const subEntries: string[] = []

    for (const exportFile of exports) {
      subEntries.push(join(fileDir, exportFile))
    }

    if (subEntries.length === 0) {
      console.warn('No exports found, skipping...')

      continue
    }

    await buildFiles('component', outputGenerated, {
      ...options,
      entries: subEntries,
    })
  }
}
