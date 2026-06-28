// --------- STD ---------

declare module 'std:shared' {
  export * from '@ozaco/std/shared'
}
declare module 'std:result' {
  export * from '@ozaco/std/result'
}
declare module 'std:effect' {
  export * from '@ozaco/std/effect'
}
declare module 'std:event' {
  export * from '@ozaco/std/event'
}
declare module 'std:plugin' {
  export * from '@ozaco/std/plugin'
}
declare module 'std:io' {
  export * from '@ozaco/std/io'
}
declare module 'std:io/impl/bun' {
  export * from '@ozaco/std/io/impl/bun'
}
declare module 'std:io/impl/node' {
  export * from '@ozaco/std/io/impl/node'
}
declare module 'std:io/impl/web' {
  export * from '@ozaco/std/io/impl/web'
}
declare module 'std:logger' {
  export * from '@ozaco/std/logger'
}
declare module 'std:logger/transport/file' {
  export * from '@ozaco/std/logger/transport/file'
}
declare module 'std:logger/transport/console' {
  export * from '@ozaco/std/logger/transport/console'
}
declare module 'std:fetch' {
  export * from '@ozaco/std/fetch'
}
declare module 'std:codec' {
  export * from '@ozaco/std/codec'
}

// --------- SERVER ---------

declare module 'server:core' {
  export * from '@ozaco/server/core'
}
declare module 'server:transport/nats' {
  export * from '@ozaco/server/transport/nats'
}
declare module 'server:transport/worker' {
  export * from '@ozaco/server/transport/worker'
}
declare module 'server:policy/bucket' {
  export * from '@ozaco/server/policy/bucket'
}
declare module 'server:policy/retry' {
  export * from '@ozaco/server/policy/retry'
}
declare module 'server:policy/cache' {
  export * from '@ozaco/server/policy/cache'
}
declare module 'server:policy/circuit-breaker' {
  export * from '@ozaco/server/policy/circuit-breaker'
}
declare module 'server:policy/bulk' {
  export * from '@ozaco/server/policy/bulk'
}
declare module 'server:policy/timeout' {
  export * from '@ozaco/server/policy/timeout'
}
declare module 'server:policy/fallback' {
  export * from '@ozaco/server/policy/fallback'
}
declare module 'server:policy/metrics' {
  export * from '@ozaco/server/policy/metrics'
}
declare module 'server:gateway/bun' {
  export * from '@ozaco/server/gateway/bun'
}
declare module 'server:gateway/node' {
  export * from '@ozaco/server/gateway/node'
}
declare module 'server:plugin/cors' {
  export * from '@ozaco/server/plugin/cors'
}
declare module 'server:plugin/docs' {
  export * from '@ozaco/server/plugin/docs'
}
declare module 'server:plugin/auth' {
  export * from '@ozaco/server/plugin/auth'
}
declare module 'server:client' {
  export * from '@ozaco/server/client'
}

declare module 'server:daemon' {
  export * from '@ozaco/server/daemon'
}

// --------- DB ---------

declare module 'db:core' {
  export * from '@ozaco/db'
}
declare module 'db:impl/sqlite' {
  export * from '@ozaco/db/impl/sqlite'
}
declare module 'db:impl/postgres' {
  export * from '@ozaco/db/impl/postgres'
}

// --------- AI ---------
declare module 'ai:core' {
  export * from '@ozaco/ai/core'
}
declare module 'ai:impl/openai' {
  export * from '@ozaco/ai/impl/openai'
}

// --------- CLI ---------
declare module 'cli:core' {
  export * from '@ozaco/cli/core'
}

declare module 'cli:palette' {
  export * from '@ozaco/cli/palette'
}

declare module 'cli:prompt' {
  export * from '@ozaco/cli/prompt'
}

declare module 'cli:spinner' {
  export * from '@ozaco/cli/spinner'
}

declare module 'cli:terminal/bun' {
  export * from '@ozaco/cli/terminal/bun'
}
