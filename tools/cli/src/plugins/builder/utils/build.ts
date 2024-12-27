import { exists, mkdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { BuildConfig } from 'bun'
import { moduleLexerAsync } from 'oxc-parser'

import type { Entry } from '../plugin'

export interface BuildOptions {
  cwd: string
  minify: boolean
  sourcemap: 'external' | 'inline' | 'none'

  externals: string[]
  target: BuildConfig['target']

  entries: Entry[]
}

export const build = async (options: BuildOptions) => {
  try {
    const tempDir = join(options.cwd, 'dist', '.build')

    if (!(await exists(tempDir))) {
      await mkdir(tempDir, {
        recursive: true,
      })
    }

    const chunkFiles = [...new Bun.Glob(join(tempDir, './**/chunk-*')).scanSync()]

    await Promise.all(chunkFiles.map(file => unlink(file)))

    const builder = await Bun.build({
      entrypoints: options.entries.map(entry => entry.source),
      splitting: true,
      outdir: tempDir,

      // biome-ignore lint/style/noNonNullAssertion: Redundant
      target: options.target!,
      external: options.externals,
      minify: options.minify
        ? {
            identifiers: false,
            syntax: true,
            whitespace: true,
          }
        : false,
      root: options.cwd,
      sourcemap: options.sourcemap,
    })

    if (!builder.success) {
      // biome-ignore lint/suspicious/noConsole: <explanation>
      console.error(...builder.logs)
    }

    const outputs: string[] = []

    await Promise.all(
      options.entries.map(async entry => {
        // biome-ignore lint/style/noNonNullAssertion: Redundant
        const filename = basename(entry.source!).replace('.ts', '.js')
        const inputDir = dirname(entry.source)
        const targetPath = join('.build', inputDir, filename)

        outputs.push(join('./', dirname(entry.default), targetPath))

        await Bun.write(
          // biome-ignore lint/style/noNonNullAssertion: <explanation>
          join(options.cwd, entry.default!),
          `export * from './${targetPath}'`
        )
      })
    )

    for (const output of outputs) {
      let fileAsText = await Bun.file(output).text()
      const file = await moduleLexerAsync(fileAsText)

      file.exports.sort((a, b) => a.s - b.s)

      const founds: string[] = []

      let slicedLength = 0

      for (const statement of file.exports) {
        if (!founds.includes(statement.n)) {
          founds.push(statement.n)
          continue
        }

        const hasComma = fileAsText[statement.s + statement.n.length - slicedLength] === ',' ? 1 : 0

        const startPos = statement.s - slicedLength
        const endPos = statement.s + statement.n.length - slicedLength + hasComma

        slicedLength = slicedLength + statement.n.length + hasComma

        fileAsText = `${fileAsText.slice(0, startPos)}${fileAsText.slice(endPos)}`
      }

      await Bun.write(output, fileAsText)
    }

    return true
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: <explanation>
    console.error(err)
    process.exit(1)
  }
}
