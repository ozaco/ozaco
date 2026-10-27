import { dirname } from 'node:path'

import { kitSpecifiers } from '../resolve'

/** The families an alias belongs to — the NAMESPACE Bun's resolver hands a plugin for
 * `std:effect` (namespace `std`, path `effect`). */
const FAMILIES = ['std', 'transport', 'db', 'server', 'client', 'ai', 'cli'] as const

interface ResolveArgs {
  readonly path: string
  readonly importer: string
  readonly namespace: string
}

/** The slice of Bun's `PluginBuilder` the plugin uses (no `bun-types` needed at the call site). */
export interface PluginBuild {
  onResolve(
    constraints: { readonly filter: RegExp; readonly namespace?: string },
    callback: (args: ResolveArgs) => { readonly path: string } | undefined,
  ): void
}

/**
 * The Bun plugin behind `@ozaco/devkit/bun`: every `<family>:<key>` import — `std:effect`,
 * `db:core`, `server:impl/edge/bun` — resolves to the published package it stands for, from the
 * importer's directory (the cwd when there is none). Register it yourself with
 * `Bun.plugin(ozacoSpecifiers)`, or let the preload entry do it.
 */
export const ozacoSpecifiers = {
  name: 'ozaco-specifiers',

  setup(build: PluginBuild): void {
    const specifiers = kitSpecifiers()

    for (const family of FAMILIES) {
      build.onResolve({ filter: /.*/u, namespace: family }, args => {
        const target = specifiers.get(`${family}:${args.path}`)

        if (!target) {
          return undefined
        }

        return {
          path: Bun.resolveSync(target, args.importer ? dirname(args.importer) : process.cwd()),
        }
      })
    }
  },
}
