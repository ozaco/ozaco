/**
 * `server:gateway/node` — the Node runtime gateway adapter (`node:http`; WebSocket upgrades need
 * the optional `ws` peer). The engine lives in core — install this adapter, then
 * `install(DefaultGateway)` and `Gateway.actions.start(...)`.
 */
export * from './definition'
