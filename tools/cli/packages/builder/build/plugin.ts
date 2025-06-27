import { watch } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { definePlugin } from 'clerc'
import type { PackageJson } from 'type-fest'
import { type Cli, prettyMs, throttle } from '../../../src'
import { type ActionOptions, action } from './action'

export const plugin = definePlugin({
  // biome-ignore lint/nursery/noExcessiveLinesPerFunction: Redundant
  setup: (cli: Cli) =>
    cli
      .command('build', 'Builds the project', {
        flags: {
          env: {
            alias: 'm',
            default: 'development',
            description: 'Environment [development(dev), production(prod), test]',
            type: String,
          },

          external: {
            alias: 'e',
            default: null,
            description: 'External dependencies [by default excludes all]',
            type: [String],
          },

          format: {
            alias: 'f',
            default: 'esm',
            description: 'Output format [cjs, esm]',
            type: String,
          },

          noJson: {
            default: false,
            description: 'Disable JSON support',
            type: Boolean,
          },

          noReferences: {
            default: false,
            description: 'Enable references',
            type: Boolean,
          },
          target: {
            alias: 't',
            default: 'bun',
            description: 'Target environment [bun, browser, node]',
            type: String,
          },

          watch: {
            alias: 'w',
            default: false,
            description: 'Watch for changes',
            type: Boolean,
          },
        },

        parameters: ['[packages...]'],
      })
      .on('build', async ctx => {
        if (ctx.flags.target !== 'browser' && ctx.flags.target !== 'bun' && ctx.flags.target !== 'node') {
          throw new Error(`Unknown build target ${ctx.flags.target}`)
        }

        if (ctx.flags.env === 'dev') {
          ctx.flags.env = 'development'
        } else if (ctx.flags.env === 'prod') {
          ctx.flags.env = 'production'
        }

        if (ctx.flags.watch) {
          ctx.flags.env = 'development'
        }

        if (ctx.flags.env !== 'development' && ctx.flags.env !== 'production' && ctx.flags.env !== 'test') {
          throw new Error(`Unknown environment ${ctx.flags.env}`)
        }

        const handleOptions = async () => {
          const packageJsonPath = join(ctx.flags.cwd, 'package.json')
          const packageJson = (await Bun.file(packageJsonPath).json()) as PackageJson

          if (ctx.flags.external === null) {
            ctx.flags.external = Object.keys(packageJson.dependencies || {})
          }

          ctx.flags.external = [
            ...(ctx.flags.external ?? []),
            ...Object.keys(packageJson.devDependencies || {}),
            ...Object.keys(packageJson.optionalDependencies || {}),
            ...Object.keys(packageJson.peerDependencies || {}),
          ]

          ctx.flags.external = new Set(ctx.flags.external).values().toArray()

          if (Array.isArray(packageJson.bundleDependencies)) {
            const bundledDependencies = new Set(packageJson.bundleDependencies).values().toArray()

            ctx.flags.external = ctx.flags.external.filter(x => !bundledDependencies.includes(x))
          } else if (typeof packageJson.bundleDependencies === 'boolean' && packageJson.bundleDependencies) {
            ctx.flags.external = []
          }

          return {
            cwd: ctx.flags.cwd,

            env: ctx.flags.env,

            exports: packageJson.exports,
            external: ctx.flags.external ?? [],
            format: ctx.flags.format,
            json: !ctx.flags.noJson,
            name: packageJson.name,
            packages: ctx.parameters.packages,
            references: !ctx.flags.noReferences,
            silent: ctx.flags.silent,
            // tsx-exports is renamed to splitBuilds, but we keep it for backwards compatibility
            splitBuilds: packageJson.splitBuilds ?? packageJson['tsx-exports'] ?? [],
            target: ctx.flags.target,
            watch: ctx.flags.watch,
          } as ActionOptions
        }

        if (ctx.flags.watch) {
          ctx.flags.silent = false

          const throttledAction = throttle(async () => {
            const timeStart = performance.now()

            await action(await handleOptions())

            const timeEnd = performance.now()

            console.log(`js build completed in ${prettyMs(timeEnd - timeStart)}`)
          }, 100)

          throttledAction()

          watch(
            ctx.flags.cwd,
            {
              recursive: true,
            },
            (_event, filename) => {
              if (filename?.startsWith('dist/')) {
                return
              }

              throttledAction()
            },
          )

          return
        }

        try {
          await action(await handleOptions())
        } catch (err) {
          console.error(err as string)

          process.exit(1)
        }

        if (!ctx.flags.silent) {
          console.log('Build completed')
        }
      }),
})
