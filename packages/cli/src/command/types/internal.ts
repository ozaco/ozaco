import type { CommandDef } from './command'

/** Tokenizer output: option values by canonical field, positionals, `--` rest, and parse errors. */
export interface RawParse {
  /** Canonical field name → raw string values (in order seen). */
  options: Map<string, string[]>
  positionals: string[]
  /** Tokens after a `--` separator. */
  rest: string[]
  errors: string[]
}

/** The resolved shape a single action contributes to help rendering (usage + options). */
export interface ActionHelp {
  path: string[]
  description?: string | undefined
  infos: readonly CommandDef.OptionInfo[]
  short: Record<string, string>
  args: readonly string[]
}

/** A single property of the JSON Schema produced by `z.toJSONSchema` (what schema introspection walks). */
export interface JsonProp {
  type?: string | string[] | undefined
  enum?: readonly string[] | undefined
  default?: unknown
  items?: { type?: string | undefined; enum?: readonly string[] | undefined } | undefined
}

/** The top-level JSON Schema produced by `z.toJSONSchema` for an action's `input`. */
export interface JsonSchema {
  properties?: Record<string, JsonProp> | undefined
  required?: readonly string[] | undefined
}
