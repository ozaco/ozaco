import type { CommandDef } from './command'

/**
 * A node in the compiled command tree: a command's built plugin (identity = its tree path) plus its
 * child nodes keyed by the token you type. Built eagerly at `register`; each node's `setup` runs
 * lazily, as the dispatcher descends into it.
 */
export interface RuntimeNode {
  name: string
  description?: string | undefined
  plugin: CommandDef.Built
  children: Record<string, RuntimeNode>
}

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
