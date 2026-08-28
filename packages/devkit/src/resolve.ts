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
  'server:internal': { subpath: 'internal', source: 'internal.ts' },
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
  'server:plugins/observe/openobserve': {
    subpath: 'plugins/observe/openobserve',
    source: 'plugins/observe/impl/openobserve/index.ts',
  },
}

const DB_MODULES: Record<string, ModuleEntry> = {
  'db:core': { subpath: '', source: 'core/index.ts' },
  'db:internal': { subpath: 'internal', source: 'internal.ts' },
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
  'cli:impl/memory': { subpath: 'impl/memory', source: 'impl/memory/index.ts' },
  'cli:impl/node': { subpath: 'impl/node', source: 'impl/node/index.ts' },
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

/** One module, in the three spellings that matter: the build alias, the published package
 * specifier, and where this build should point at (the package, or a source file when the
 * caller inlines sources). */
interface Binding {
  /** `'std:codec/impl/json'` — the in-repo alias. */
  readonly alias: string

  /** `'@ozaco/std/codec/impl/json'` — what a published artifact must say. */
  readonly packageSpecifier: string

  /** where THIS build resolves it to (the package specifier, or a source path). */
  readonly target: string
}

const buildBindings = (
  modules: Record<string, ModuleEntry>,
  pkg: string,
  sourceDir: string | undefined,
): readonly Binding[] =>
  Object.entries(modules).map(([alias, { subpath, source }]) => {
    const packageSpecifier = subpath ? `${pkg}/${subpath}` : pkg

    return {
      alias,
      packageSpecifier,
      target: sourceDir ? `${sourceDir}/${source}` : packageSpecifier,
    }
  })

const escapeRe = (value: string): string =>
  value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, character => `\\${character}`)

/** The quoted specifiers a declaration file may carry: `import("std:shared")`, `from 'db:core'`.
 * Matching WITH the quotes keeps `std:io` from eating `std:io/impl/bun`. */
const quoted = (specifier: string): RegExp =>
  new RegExp(`(["'])${escapeRe(specifier)}${String.raw`\1`}`, 'gu')

const isDeclaration = (fileName: string): boolean =>
  fileName.endsWith('.d.ts') || fileName.endsWith('.d.cts') || fileName.endsWith('.d.mts')

/**
 * Resolve the in-repo aliases, and make sure NOTHING but the published package specifier ever
 * leaves the build.
 *
 * BOTH spellings are accepted as input — `std:shared` and `@ozaco/std/shared` resolve to the
 * same place — so a source file may use either. The OUTPUT is always the package form:
 * `resolveId` marks it external for the module graph, and `renderChunk` rewrites the aliases
 * that never pass through module resolution at all — the inline `import("std:shared")` type
 * queries a declaration file is made of. Those are the ones that used to ship: they resolve
 * inside this repo (the tsconfig paths map them) and fail in every consumer that installs the
 * package, with `TS2307: Cannot find module 'std:shared'`.
 */
const resolveFactory = (name: string) => (bindings: readonly Binding[], external: boolean) => {
  const targets = new Map<string, string>()

  for (const binding of bindings) {
    targets.set(binding.alias, binding.target)
    targets.set(binding.packageSpecifier, binding.target)
  }

  // only a build that emits the package form has anything to rewrite; a `sourceDir` build
  // inlines real files and its declarations never name an alias
  const rewrites = external
    ? bindings
        // longest first so a prefix never wins over the specifier that extends it
        .toSorted((left, right) => right.alias.length - left.alias.length)
        .map(binding => ({ pattern: quoted(binding.alias), to: binding.packageSpecifier }))
    : []

  return {
    name,

    resolveId(source: string) {
      const target = targets.get(source)

      if (!target) {
        return
      }

      return external ? { id: target, external: true } : target
    },

    renderChunk(code: string, chunk: { fileName: string }) {
      if (rewrites.length === 0 || !isDeclaration(chunk.fileName)) {
        return null
      }

      let out = code

      for (const { pattern, to } of rewrites) {
        out = out.replaceAll(pattern, `$1${to}$1`)
      }

      return out === code ? null : { code: out }
    },
  }
}

const resolveAlias: UnpluginInstance<ResolveAliasOptions, false> = createUnplugin(
  (options: ResolveAliasOptions) =>
    resolveFactory('@ozaco/devkit:resolve:alias')(
      Object.entries(options.aliases).map(([alias, target]) => ({
        alias,
        packageSpecifier: target,
        target,
      })),
      Boolean(options.external),
    ),
)

const stdResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:std')(
      buildBindings(STD_MODULES, '@ozaco/std', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const serverResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:server')(
      buildBindings(SERVER_MODULES, '@ozaco/server', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const dbResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:db')(
      buildBindings(DB_MODULES, '@ozaco/db', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const transportResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:transport')(
      buildBindings(TRANSPORT_MODULES, '@ozaco/transport', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const aiResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:ai')(
      buildBindings(AI_MODULES, '@ozaco/ai', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const cliResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:cli')(
      buildBindings(CLI_MODULES, '@ozaco/cli', options?.sourceDir),
      !options?.sourceDir,
    ),
)

const clientResolve: UnpluginInstance<ResolveOptions | undefined, false> = createUnplugin(
  (options?: ResolveOptions) =>
    resolveFactory('@ozaco/devkit:resolve:client')(
      buildBindings(CLIENT_MODULES, '@ozaco/client', options?.sourceDir),
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
