/**
 * `@ozaco/ai` — the provider-agnostic AI module. The core is pure structure: portable spec/result
 * types, the `AiProvider` protocol (backend bindings live at `ai:impl/{openai,mock}`), the
 * `Ai`/`AiClient` plugin that resolves specs and runs the tool loop, and the streaming tool-call
 * accumulator. `JsonCodec` is a baseline dependency (the tool loop and the wire impls dispatch
 * it for all JSON work). Transport-free: importing this never performs IO.
 */
export * from './const'
export * from './definition'
export * from './errors'
export * from './provider'
export * from './utils'

export type * from './types/ai'
export type * from './types/helpers'
export type * from './types/provider'
