/**
 * `@ozaco/server/plugins` — the plugins every server may take: observability, cors, cache,
 * resilience, auth, audit, docs, resources, hot reload, proxy. Each is a std plugin `Server.actions.create({ plugins })` installs.
 */
export * from './audit'
export * from './auth'
export * from './cache'
export * from './cors'
export * from './docs'
export * from './hot-reload'
export * from './observe'
export * from './proxy'
export * from './resilience'
export * from './resource'
