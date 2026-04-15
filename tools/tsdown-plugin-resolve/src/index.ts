import type { Plugin } from 'rolldown'

const STD_MODULES: Record<string, { subpath: string; source: string }> = {
  'std:shared': { subpath: 'shared', source: 'shared/index.ts' },
  'std:result': { subpath: 'result', source: 'result/index.ts' },
  'std:effect': { subpath: 'effect', source: 'effect/index.ts' },
  'std:event': { subpath: 'event', source: 'event/index.ts' },
  'std:plugin': { subpath: 'plugin', source: 'plugin/index.ts' },
  'std:io': { subpath: 'io', source: 'io/index.ts' },
  'std:io/bun': { subpath: 'io/bun', source: 'io/impl/bun.ts' },
  'std:io/node': { subpath: 'io/node', source: 'io/impl/node.ts' },
}

export interface StdResolveOptions {
  sourceDir?: string
}

export interface ResolveAliasOptions {
  aliases: Record<string, string>
  external?: boolean
}

export const resolveAlias = (options: ResolveAliasOptions): Plugin => ({
  name: 'resolve-alias',
  resolveId(source) {
    const target = options.aliases[source]
    if (target) {
      return options.external ? { id: target, external: true } : target
    }
  },
})

export const stdResolve = (options?: StdResolveOptions): Plugin => {
  const aliases: Record<string, string> = {}

  for (const [specifier, { subpath, source }] of Object.entries(STD_MODULES)) {
    aliases[specifier] = options?.sourceDir
      ? `${options.sourceDir}/${source}`
      : `@ozaco/std/${subpath}`
  }

  return resolveAlias({ aliases, external: !options?.sourceDir })
}
