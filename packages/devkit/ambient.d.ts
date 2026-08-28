// --------- STD ---------

declare module 'std:shared' {
  export * from '@ozaco/std/shared';
}
declare module 'std:result' {
  export * from '@ozaco/std/result';
}
declare module 'std:effect' {
  export * from '@ozaco/std/effect';
}
declare module 'std:event' {
  export * from '@ozaco/std/event';
}
declare module 'std:plugin' {
  export * from '@ozaco/std/plugin';
}
declare module 'std:io' {
  export * from '@ozaco/std/io';
}
declare module 'std:io/impl/bun' {
  export * from '@ozaco/std/io/impl/bun';
}
declare module 'std:io/impl/node' {
  export * from '@ozaco/std/io/impl/node';
}
declare module 'std:io/impl/web' {
  export * from '@ozaco/std/io/impl/web';
}
declare module 'std:logger' {
  export * from '@ozaco/std/logger';
}
declare module 'std:logger/transport/file' {
  export * from '@ozaco/std/logger/transport/file';
}
declare module 'std:logger/transport/console' {
  export * from '@ozaco/std/logger/transport/console';
}
declare module 'std:fetch' {
  export * from '@ozaco/std/fetch';
}
declare module 'std:codec' {
  export * from '@ozaco/std/codec';
}
declare module 'std:codec/impl/json' {
  export * from '@ozaco/std/codec/impl/json';
}
declare module 'std:codec/impl/toml' {
  export * from '@ozaco/std/codec/impl/toml';
}
declare module 'std:codec/impl/yaml' {
  export * from '@ozaco/std/codec/impl/yaml';
}
declare module 'std:config' {
  export * from '@ozaco/std/config';
}
declare module 'std:ws' {
  export * from '@ozaco/std/ws';
}
declare module 'std:webrtc' {
  export * from '@ozaco/std/webrtc';
}

// --------- SERVER ---------

declare module 'server:core' {
  export * from '@ozaco/server';
}
declare module 'server:impl/edge/bun' {
  export * from '@ozaco/server/edge/bun';
}
declare module 'server:impl/edge/node' {
  export * from '@ozaco/server/edge/node';
}
declare module 'server:impl/edge/deno' {
  export * from '@ozaco/server/edge/deno';
}
declare module 'server:impl/carrier/network' {
  export * from '@ozaco/server/carrier/network';
}
declare module 'server:plugins' {
  export * from '@ozaco/server/plugins';
}
declare module 'server:plugins/observe/otlp' {
  export * from '@ozaco/server/plugins/observe/otlp';
}
declare module 'server:plugins/metrics/starrocks' {
  export * from '@ozaco/server/plugins/metrics/starrocks';
}
declare module 'server:app' {
  export * from '@ozaco/server/app';
}

// --------- DB ---------

declare module 'db:core' {
  export * from '@ozaco/db';
}
declare module 'db:impl/memory' {
  export * from '@ozaco/db/impl/memory';
}
declare module 'db:impl/sqlite' {
  export * from '@ozaco/db/impl/sqlite';
}
declare module 'db:impl/pg' {
  export * from '@ozaco/db/impl/pg';
}
declare module 'db:impl/bun-sql' {
  export * from '@ozaco/db/impl/bun-sql';
}
declare module 'db:impl/memory-kv' {
  export * from '@ozaco/db/impl/memory-kv';
}
declare module 'db:impl/redis-kv' {
  export * from '@ozaco/db/impl/redis-kv';
}

// --------- TRANSPORT ---------

declare module 'transport:core' {
  export * from '@ozaco/transport';
}
declare module 'transport:impl/memory' {
  export * from '@ozaco/transport/impl/memory';
}
declare module 'transport:impl/nats' {
  export * from '@ozaco/transport/impl/nats';
}
declare module 'transport:impl/redis' {
  export * from '@ozaco/transport/impl/redis';
}
declare module 'transport:impl/worker' {
  export * from '@ozaco/transport/impl/worker';
}

// --------- AI ---------
declare module 'ai:core' {
  export * from '@ozaco/ai';
}
declare module 'ai:impl/openai' {
  export * from '@ozaco/ai/impl/openai';
}
declare module 'ai:impl/mock' {
  export * from '@ozaco/ai/impl/mock';
}

// --------- CLI ---------
declare module 'cli:core' {
  export * from '@ozaco/cli';
}

declare module 'cli:palette' {
  export * from '@ozaco/cli/palette';
}

declare module 'cli:prompt' {
  export * from '@ozaco/cli/prompt';
}

declare module 'cli:spinner' {
  export * from '@ozaco/cli/spinner';
}

declare module 'cli:command' {
  export * from '@ozaco/cli/command';
}

declare module 'cli:table' {
  export * from '@ozaco/cli/table';
}

// --------- CLIENT ---------
declare module 'client:core' {
  export * from '@ozaco/client';
}

declare module 'client:codegen' {
  export * from '@ozaco/client/codegen';
}
