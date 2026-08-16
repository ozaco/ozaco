/**
 * `server:gateway/bun` — the Bun runtime gateway adapter (`Bun.serve` + native WebSocket
 * upgrade). The engine (router, transforms, sessions) lives in core; install this adapter, then
 * `install(DefaultGateway)` and `Gateway.actions.start(...)`.
 */
export * from './definition'
