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
  'std:webrtc': { subpath: 'webrtc', source: 'webrtc/index.ts' },
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
  'server:core': { subpath: '', source: 'core/index.ts' },
  'server:impl/edge/bun': { subpath: 'edge/bun', source: 'impl/edge/bun/index.ts' },
  'server:impl/edge/node': { subpath: 'edge/node', source: 'impl/edge/node/index.ts' },
  'server:impl/edge/deno': { subpath: 'edge/deno', source: 'impl/edge/deno/index.ts' },
  'server:impl/carrier/network': {
    subpath: 'carrier/network',
    source: 'impl/carrier/network/index.ts',
  },
  'server:plugins': { subpath: 'plugins', source: 'plugins/index.ts' },
  'server:plugins/observe/otlp': {
    subpath: 'plugins/observe/otlp',
    source: 'plugins/observe/impl/otlp/index.ts',
  },
  'server:plugins/metrics/starrocks': {
    subpath: 'plugins/metrics/starrocks',
    source: 'plugins/metrics/impl/starrocks/index.ts',
  },
  'server:app': { subpath: 'app', source: 'app/index.ts' },
}

const DB_MODULES: Record<string, ModuleEntry> = {
  'db:core': { subpath: '', source: 'core/index.ts' },
  'db:impl/memory': { subpath: 'impl/memory', source: 'impl/memory/index.ts' },
  'db:impl/sqlite': { subpath: 'impl/sqlite', source: 'impl/sqlite/index.ts' },
  'db:impl/pg': { subpath: 'impl/pg', source: 'impl/pg/index.ts' },
  'db:impl/bun-sql': { subpath: 'impl/bun-sql', source: 'impl/bun-sql/index.ts' },
  'db:impl/memory-kv': { subpath: 'impl/memory-kv', source: 'impl/memory-kv/index.ts' },
  'db:impl/redis-kv': { subpath: 'impl/redis-kv', source: 'impl/redis-kv/index.ts' },
}

const TRANSPORT_MODULES: Record<string, ModuleEntry> = {
  'transport:core': { subpath: '', source: 'core/index.ts' },
  'transport:impl/memory': { subpath: 'impl/memory', source: 'impl/memory/index.ts' },
  'transport:impl/nats': { subpath: 'impl/nats', source: 'impl/nats/index.ts' },
  'transport:impl/redis': { subpath: 'impl/redis', source: 'impl/redis/index.ts' },
  'transport:impl/worker': { subpath: 'impl/worker', source: 'impl/worker/index.ts' },
}

const AI_MODULES: Record<string, ModuleEntry> = {
  'ai:core': { subpath: '', source: 'core/index.ts' },
  'ai:impl/openai': { subpath: 'impl/openai', source: 'impl/openai/index.ts' },
  'ai:impl/mock': { subpath: 'impl/mock', source: 'impl/mock/index.ts' },
}

const CLI_MODULES: Record<string, ModuleEntry> = {
  'cli:core': { subpath: '', source: 'core/index.ts' },
  'cli:palette': { subpath: 'palette', source: 'palette/index.ts' },
  'cli:prompt': { subpath: 'prompt', source: 'prompt/index.ts' },
  'cli:spinner': { subpath: 'spinner', source: 'spinner/index.ts' },
  'cli:command': { subpath: 'command', source: 'command/index.ts' },
  'cli:table': { subpath: 'table', source: 'table/index.ts' },
}

const CLIENT_MODULES: Record<string, ModuleEntry> = {
  'client:core': { subpath: '', source: 'core/index.ts' },
  'client:codegen': { subpath: 'codegen', source: 'codegen/index.ts' },
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

const transportResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:transport')(
      buildAliases(TRANSPORT_MODULES, '@ozaco/transport', options?.sourceDir),
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

export {
  aiResolve,
  clientResolve,
  cliResolve,
  dbResolve,
  resolveAlias,
  serverResolve,
  stdResolve,
  transportResolve,
}
export type { ResolveAliasOptions, ResolveOptions }
