import { join } from 'node:path'
import { definePlugin } from 'clerc'

import type { PackageJson } from 'type-fest'

import { action } from './action'

import type { Cli } from '../../../src'

export const plugin = definePlugin({
  setup: (cli: Cli) =>
    cli
      .command('build', 'Builds the project', {
        flags: {
          target: {
            alias: 't',
            type: String,
            default: 'server',
            description: 'Target environment [server, browser]',
          },

          external: {
            alias: 'e',
            type: [String],
            default: null,
            description: 'External dependencies [by default excludes all]',
          },

          env: {
            type: String,
            default: 'development',
            description: 'Environment [development, production, test]',
          },
        },

        parameters: ['[packages...]'],
      })
      .on('build', async ctx => {
        if (ctx.flags.target !== 'browser' && ctx.flags.target !== 'server') {
          throw new Error(`Unknown build target ${ctx.flags.target}`)
        }

        if (
          ctx.flags.env !== 'development' &&
          ctx.flags.env !== 'production' &&
          ctx.flags.env !== 'test'
        ) {
          throw new Error(`Unknown environment ${ctx.flags.env}`)
        }

        const packageJsonPath = join(ctx.flags.cwd, 'package.json')
        const packageJson = (await Bun.file(packageJsonPath).json()) as PackageJson

        if (ctx.flags.external === null) {
          ctx.flags.external = Object.keys(packageJson.dependencies || {})
        }

        ctx.flags.external = [
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

        try {
          await action({
            cwd: ctx.flags.cwd,

            env: ctx.flags.env,
            target: ctx.flags.target,
            packages: ctx.parameters.packages,

            exports: packageJson.exports,
            external: ctx.flags.external,
          })
        } catch (err) {
          console.error(err as string)

          process.exit(1)
        }

        if (!ctx.flags.silent) {
          console.log('Build completed')
        }
      }),
})
