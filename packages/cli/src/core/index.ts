/**
 * `@ozaco/cli` — the terminal core. Pure structure: the single {@link CliErrors} taxonomy, the
 * ANSI-aware text measurers (`stripAnsi`/`displayWidth`/`wrapAnsi`), the `Terminal` protocol with
 * its core-owned render lease (platform bindings are built with `Terminal.implement`; packaged
 * `cli:impl/*` modules are planned), and the Standard Schema type re-exported from `std:shared`.
 * Platform-free: importing this never touches `process` or `node:*`.
 */
export * from './const'
export * from './definition'
export * from './errors'
export * from './utils'

export type * from './types/common'
export type * from './types/schema'
export type * from './types/terminal'
