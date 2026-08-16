/**
 * `server:daemon` — topology bootstrap. The same app file runs monolith (no `SERVICE` env),
 * edge-only (`SERVICE=gateway`) or headless service owner (`SERVICE=<module>`); module ownership
 * decides registration, the role decides mounting, transports carry the rest.
 */
export * from './definition'
export type * from './types'
