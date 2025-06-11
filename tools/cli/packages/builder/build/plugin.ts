import { watch } from 'node:fs'
import { join } from 'node:path'
import { definePlugin } from 'clerc'

import type { PackageJson } from 'type-fest'

import { type ActionOptions, action } from './action'

import { type Cli, prettyMs, throttle } from '../../../src'

export const plugin = definePlugin({
  setup: (cli: Cli) =>
    cli
      .command('build', 'Builds the project', {
        flags: {
          target: {
            alias: 't',
            type: String,
            default: 'bun',
            description: 'Target environment [bun, browser, node]',
          },

          external: {
            alias: 'e',
            type: [String],
            default: null,
            description: 'External dependencies [by default excludes all]',
          },

          env: {
            alias: 'm',
            type: String,
            default: 'development',
            description: 'Environment [development(dev), production(prod), test]',
          },

          watch: {
            alias: 'w',
            type: Boolean,
            default: false,
            description: 'Watch for changes',
          },

          noJson: {
            type: Boolean,
            default: false,
            description: 'Disable JSON support',
          },

          format: {
            alias: 'f',
            type: String,
            default: 'esm',
            description: 'Output format [cjs, esm]',
          },

          noReferences: {
            type: Boolean,
            default: false,
            description: 'Enable references',
          },
        },

        parameters: ['[packages...]'],
      })
      .on('build', async ctx => {
        if (
          ctx.flags.target !== 'browser' &&
          ctx.flags.target !== 'bun' &&
          ctx.flags.target !== 'node'
        ) {
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

        if (
          ctx.flags.env !== 'development' &&
          ctx.flags.env !== 'production' &&
          ctx.flags.env !== 'test'
        ) {
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
          } else if (
            typeof packageJson.bundleDependencies === 'boolean' &&
            packageJson.bundleDependencies
          ) {
            ctx.flags.external = []
          }

          return {
            name: packageJson.name,

            cwd: ctx.flags.cwd,
            watch: ctx.flags.watch,
            json: !ctx.flags.noJson,
            references: !ctx.flags.noReferences,
            format: ctx.flags.format,
            silent: ctx.flags.silent,

            env: ctx.flags.env,
            target: ctx.flags.target,
            packages: ctx.parameters.packages,

            exports: packageJson.exports,
            // tsx-exports is renamed to splitBuilds, but we keep it for backwards compatibility
            splitBuilds: packageJson.splitBuilds ?? packageJson['tsx-exports'] ?? [],
            external: ctx.flags.external ?? [],
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
            }
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
