import type { UnpluginInstance } from 'unplugin'
import { createUnplugin } from 'unplugin'

interface ModuleEntry {
  subpath: string
  source: string
}

const STD_MODULES: Record<string, ModuleEntry> = {
  'std:shared': { subpath: 'shared', source: 'shared/index.ts' },
  'std:result': { subpath: 'result', source: 'result/index.ts' },
  'std:effect': { subpath: 'effect', source: 'effect/index.ts' },
  'std:event': { subpath: 'event', source: 'event/index.ts' },
  'std:plugin': { subpath: 'plugin', source: 'plugin/index.ts' },
  'std:io': { subpath: 'io', source: 'io/index.ts' },
  'std:io/impl/bun': { subpath: 'io/impl/bun', source: 'io/impl/bun.ts' },
  'std:io/impl/node': { subpath: 'io/impl/node', source: 'io/impl/node.ts' },
  'std:fetch': { subpath: 'fetch', source: 'fetch/index.ts' },
}

const SERVER_MODULES: Record<string, ModuleEntry> = {
  'server:core': { subpath: 'core', source: 'core/index.ts' },
  'server:plugin/router': { subpath: 'plugin/router', source: 'plugin/router/index.ts' },
  'server:plugin/auth': { subpath: 'plugin/auth', source: 'plugin/auth/index.ts' },
  'server:plugin/cors': { subpath: 'plugin/cors', source: 'plugin/cors/index.ts' },
  'server:plugin/docs': { subpath: 'plugin/docs', source: 'plugin/docs/index.ts' },
  'server:transport/nats': { subpath: 'transport/nats', source: 'transport/nats/index.ts' },
  'server:impl/bun': { subpath: 'impl/bun', source: 'impl/bun/index.ts' },
}

const DB_MODULES: Record<string, ModuleEntry> = {
  'db:core': { subpath: 'core', source: 'core.ts' },
  'db:schema': { subpath: 'schema', source: 'schema/index.ts' },
  'db:query': { subpath: 'query', source: 'query.ts' },
  'db:impl/sqlite': { subpath: 'impl/sqlite', source: 'impl/sqlite.ts' },
  'db:impl/postgres': { subpath: 'impl/postgres', source: 'impl/postgres.ts' },
}

interface ResolveAliasOptions {
  aliases: Record<string, string>
  external?: boolean
}

interface ResolveOptions {
  sourceDir?: string
}

const buildAliases = (
  modules: Record<string, ModuleEntry>,
  pkg: string,
  sourceDir: string | undefined,
): Record<string, string> => {
  const aliases: Record<string, string> = {}
  for (const [specifier, { subpath, source }] of Object.entries(modules)) {
    aliases[specifier] = sourceDir ? `${sourceDir}/${source}` : `${pkg}/${subpath}`
  }
  return aliases
}

const resolveFactory = (name: string) => (aliases: Record<string, string>, external: boolean) => ({
  name,
  resolveId(source: string) {
    const target = aliases[source]
    if (!target) {
      return
    }
    return external ? { id: target, external: true } : target
  },
})

const resolveAlias: UnpluginInstance<ResolveAliasOptions, false> = createUnplugin(
  (options: ResolveAliasOptions) =>
    resolveFactory('@ozaco/unplugin-resolve:alias')(options.aliases, Boolean(options.external)),
)

const stdResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/unplugin-resolve:std')(
      buildAliases(STD_MODULES, '@ozaco/std', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const serverResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/unplugin-resolve:server')(
      buildAliases(SERVER_MODULES, '@ozaco/server', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const dbResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/unplugin-resolve:db')(
      buildAliases(DB_MODULES, '@ozaco/db', options?.sourceDir),
      !options?.sourceDir,
    ),
)

export { dbResolve, resolveAlias, serverResolve, stdResolve }
export type { ResolveAliasOptions, ResolveOptions }
