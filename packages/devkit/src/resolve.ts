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
  'std:io/impl/web': { subpath: 'io/impl/web', source: 'io/impl/web.ts' },
  'std:fetch': { subpath: 'fetch', source: 'fetch/index.ts' },
  'std:ws': { subpath: 'ws', source: 'ws/index.ts' },
  'std:codec': { subpath: 'codec', source: 'codec/index.ts' },
  'std:codec/impl/json': { subpath: 'codec/impl/json', source: 'codec/impl/json.ts' },
  'std:codec/impl/toml': { subpath: 'codec/impl/toml', source: 'codec/impl/toml.ts' },
  'std:codec/impl/yaml': { subpath: 'codec/impl/yaml', source: 'codec/impl/yaml.ts' },
  'std:logger': { subpath: 'logger', source: 'logger/index.ts' },
  'std:logger/transport/console': {
    subpath: 'logger/transport/console',
    source: 'logger/transport/console/index.ts',
  },
  'std:logger/transport/file': {
    subpath: 'logger/transport/file',
    source: 'logger/transport/file/index.ts',
  },
  'std:config': { subpath: 'config', source: 'config/index.ts' },
}

const SERVER_MODULES: Record<string, ModuleEntry> = {
  'server:core': { subpath: 'core', source: 'core/index.ts' },
  'server:transport/nats': {
    subpath: 'transport/nats',
    source: 'transport/nats/index.ts',
  },
  'server:transport/worker': {
    subpath: 'transport/worker',
    source: 'transport/worker/index.ts',
  },
  'server:policy/bucket': {
    subpath: 'policy/bucket',
    source: 'policy/bucket/index.ts',
  },
  'server:policy/retry': {
    subpath: 'policy/retry',
    source: 'policy/retry/index.ts',
  },
  'server:policy/cache': {
    subpath: 'policy/cache',
    source: 'policy/cache/index.ts',
  },
  'server:policy/circuit-breaker': {
    subpath: 'policy/circuit-breaker',
    source: 'policy/circuit-breaker/index.ts',
  },
  'server:policy/bulk': {
    subpath: 'policy/bulk',
    source: 'policy/bulk/index.ts',
  },
  'server:policy/timeout': {
    subpath: 'policy/timeout',
    source: 'policy/timeout/index.ts',
  },
  'server:policy/fallback': {
    subpath: 'policy/fallback',
    source: 'policy/fallback/index.ts',
  },
  'server:policy/metrics': {
    subpath: 'policy/metrics',
    source: 'policy/metrics/index.ts',
  },
  'server:gateway/bun': {
    subpath: 'gateway/bun',
    source: 'gateway/bun/index.ts',
  },
  'server:gateway/node': {
    subpath: 'gateway/node',
    source: 'gateway/node/index.ts',
  },
  'server:plugin/cors': {
    subpath: 'plugin/cors',
    source: 'plugin/cors/index.ts',
  },
  'server:plugin/docs': {
    subpath: 'plugin/docs',
    source: 'plugin/docs/index.ts',
  },
  'server:plugin/auth': {
    subpath: 'plugin/auth',
    source: 'plugin/auth/index.ts',
  },
  'server:daemon': {
    subpath: 'daemon',
    source: 'daemon/index.ts',
  },
  'server:wizard': {
    subpath: 'wizard',
    source: 'wizard/index.ts',
  },
  'server:metrics': {
    subpath: 'metrics',
    source: 'metrics/index.ts',
  },
}

const DB_MODULES: Record<string, ModuleEntry> = {
  'db:core': { subpath: '', source: 'core/index.ts' },
  'db:impl/memory': { subpath: 'impl/memory', source: 'impl/memory/index.ts' },
  'db:impl/sqlite': { subpath: 'impl/sqlite', source: 'impl/sqlite/index.ts' },
  'db:impl/pg': { subpath: 'impl/pg', source: 'impl/pg/index.ts' },
  'db:impl/bun-sql': { subpath: 'impl/bun-sql', source: 'impl/bun-sql/index.ts' },
}

const AI_MODULES: Record<string, ModuleEntry> = {
  'ai:core': { subpath: 'core', source: 'index.ts' },
  'ai:impl/openai': { subpath: 'impl/openai', source: 'impl/openai.ts' },
}

const CLI_MODULES: Record<string, ModuleEntry> = {
  'cli:core': { subpath: 'core', source: 'core/index.ts' },
  'cli:palette': { subpath: 'palette', source: 'palette/definition.ts' },
  'cli:prompt': { subpath: 'prompt', source: 'prompt/definition.ts' },
  'cli:spinner': { subpath: 'spinner', source: 'spinner/definition.ts' },
  'cli:command': { subpath: 'command', source: 'command/definition.ts' },
  'cli:table': { subpath: 'table', source: 'table/definition.ts' },
  'cli:terminal/bun': { subpath: 'terminal/bun', source: 'terminal/bun.ts' },
}

const CLIENT_MODULES: Record<string, ModuleEntry> = {
  'client:core': { subpath: 'core', source: 'index.ts' },
  'client:codegen': { subpath: 'codegen', source: 'codegen/definition.ts' },
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
    aliases[specifier] = sourceDir ? `${sourceDir}/${source}` : subpath ? `${pkg}/${subpath}` : pkg
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
    resolveFactory('@ozaco/devkit:resolve:alias')(options.aliases, Boolean(options.external)),
)

const stdResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:std')(
      buildAliases(STD_MODULES, '@ozaco/std', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const serverResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:server')(
      buildAliases(SERVER_MODULES, '@ozaco/server', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const dbResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:db')(
      buildAliases(DB_MODULES, '@ozaco/db', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const aiResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:ai')(
      buildAliases(AI_MODULES, '@ozaco/ai', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const cliResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:cli')(
      buildAliases(CLI_MODULES, '@ozaco/cli', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const clientResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:client')(
      buildAliases(CLIENT_MODULES, '@ozaco/client', options?.sourceDir),
      !options?.sourceDir,
    ),
)

export { aiResolve, clientResolve, cliResolve, dbResolve, resolveAlias, serverResolve, stdResolve }
export type { ResolveAliasOptions, ResolveOptions }
