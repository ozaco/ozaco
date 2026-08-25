import type { Key } from 'cli:core'
import type { PaletteDef } from 'cli:palette'
import type { Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

export namespace PromptDef {
  export type Options = EmptyType

  export type Context = EmptyType

  export type Validate<T> = (value: T) => string | undefined

  export interface Base {
    message: string
    description?: string
  }

  export interface Choice<T> {
    value: T
    label?: string
    hint?: string
    disabled?: boolean
  }

  export interface TextOptions extends Base {
    initial?: string
    placeholder?: string
    validate?: Validate<string>
  }

  export interface PasswordOptions extends Base {
    mask?: string
    validate?: Validate<string>
  }

  export interface NumberOptions extends Base {
    initial?: number
    min?: number
    max?: number
    float?: boolean
    validate?: Validate<number>
  }

  export interface ConfirmOptions extends Base {
    initial?: boolean
  }

  export interface SelectOptions<T> extends Base {
    choices: readonly Choice<T>[]
    initial?: number | T
  }

  export interface MultiSelectOptions<T> extends Base {
    choices: readonly Choice<T>[]
    initial?: readonly (number | T)[]
    required?: boolean
    min?: number
    max?: number
  }

  export interface AutocompleteOptions<T> extends Base {
    choices: readonly Choice<T>[]
    placeholder?: string
    suggest?: (input: string, choices: readonly Choice<T>[]) => readonly Choice<T>[]
  }

  /** One directory entry a path prompt suggests. */
  export interface PathEntry {
    name: string
    isDir: boolean
  }

  export interface PathOptions extends Base {
    initial?: string
    root?: string
    directory?: boolean
    validate?: Validate<string>
    /**
     * Directory lister for suggestions/completion. Defaults to the installed `std:io` IO protocol
     * (`readdir` + `stat`); pass your own to avoid the IO dependency or virtualize the tree.
     */
    scan?: (dir: string) => Operation<PathEntry[]>
  }

  export interface Actions {
    text(options: TextOptions): Operation<string>
    password(options: PasswordOptions): Operation<string>
    number(options: NumberOptions): Operation<number>
    confirm(options: ConfirmOptions): Operation<boolean>
    select<T>(options: SelectOptions<T>): Operation<T>
    multiselect<T>(options: MultiSelectOptions<T>): Operation<T[]>
    autocomplete<T>(options: AutocompleteOptions<T>): Operation<T>
    path(options: PathOptions): Operation<string>
  }
}

export interface PromptContext {
  palette: PaletteDef.Context
  columns: number
}

export type KeyAction<S, V> =
  | { type: 'update'; state: S }
  | { type: 'submit'; value: V }
  | { type: 'cancel' }
  | undefined

/**
 * A prompt as the engine sees it: a pure state machine (`render`/`onKey` are synchronous) plus an
 * optional effectful `prepare` that enriches the state after each update (the path prompt loads
 * directory entries there — never inside `render`).
 */
export interface PromptSpec<S, V> {
  initial: S
  description?: string | undefined
  render(state: S, ctx: PromptContext): string
  onKey(state: S, key: Key, ctx: PromptContext): KeyAction<S, V>
  submitted(value: V, state: S, ctx: PromptContext): string
  cancelled(state: S, ctx: PromptContext): string
  prepare?(state: S, ctx: PromptContext): Operation<S>
}
