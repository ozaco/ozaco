import { exists, mkdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { ActionOptions } from '../action'
import { fixDirectives } from './fix-directives'
import { fixExports } from './fix-exports'

export interface BuildEntry {
  name: string
  source: string
  default: string
  types?: string
}

export interface BuildOptions
  extends Pick<ActionOptions, 'env' | 'cwd' | 'target' | 'external' | 'format' | 'silent'> {
  entries: BuildEntry[]
}

export const build = async (options: BuildOptions) => {
  const outputDir = join(options.cwd, 'dist')
  const outputGenerated = join(outputDir, '.generated')

  if (!(await exists(outputGenerated))) {
    await mkdir(outputGenerated, {
      recursive: true,
    })
  }

  const chunkFiles = [...new Bun.Glob(join(outputGenerated, './**/chunk-*')).scanSync()]

  await Promise.all(chunkFiles.map(file => unlink(file)))

  const buildOutput = await Bun.build({
    root: options.cwd,
    entrypoints: options.entries.map(entry => entry.source),
    throw: false,

    external: options.external,
    target: options.target,
    format: options.format,
    minify:
      options.env === 'production'
        ? {
            identifiers: false,
            syntax: true,
            whitespace: true,
          }
        : false,
    sourcemap: 'linked',
    splitting: true,
    emitDCEAnnotations: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(options.env),
    },

    plugins: [],
  })

  if (!(buildOutput.success || options.silent)) {
    console.error(...buildOutput.logs)
  }

  for (const output of buildOutput.outputs) {
    const filePath = join(outputGenerated, output.path)
    let code = await output.text()

    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
      if (!filePath.includes('chunk-')) {
        code = fixExports(code)
      }

      const targetEntry = options.entries.find(
        entry =>
          entry.source === output.path.replace('.js', '.tsx') ||
          entry.source === output.path.replace('.js', '.jsx')
      )

      if (targetEntry) {
        const sourcecode = await Bun.file(join(options.cwd, targetEntry.source)).text()
        code = fixDirectives(sourcecode, code)
      } else if (filePath.includes('chunk-')) {
        code = fixDirectives(code, code, true)
      }
    }

    await Bun.write(filePath, code)
  }

  await Promise.all(
    options.entries.map(async entry => {
      const filename = basename(entry.source).replace('.ts', '.js')
      const inputDir = dirname(entry.source)

      let targetPath = join('.generated', inputDir, filename)

      if (!targetPath.startsWith('../')) {
        targetPath = `./${targetPath}`
      }

      await Bun.write(
        // biome-ignore lint/style/noNonNullAssertion: Redundant
        join(options.cwd, entry.default!),
        options.format === 'cjs'
          ? `// @bun @bun-cjs\nmodule.exports = require('${targetPath.replaceAll('\\', '/')}')`
          : `// @bun\nexport * from '${targetPath.replaceAll('\\', '/')}'`
      )
    })
  )
}
