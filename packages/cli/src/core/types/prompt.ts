import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { EmptyType } from 'std:shared'

export type PromptDef = Plugin<
  PromptDef.Context,
  unknown,
  [options?: PromptDef.Options],
  PromptDef.Actions
>

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

  export interface TextOptions extends PromptDef.Base {
    initial?: string
    placeholder?: string
    validate?: PromptDef.Validate<string>
  }

  export interface PasswordOptions extends PromptDef.Base {
    mask?: string
    validate?: PromptDef.Validate<string>
  }

  export interface NumberOptions extends PromptDef.Base {
    initial?: number
    min?: number
    max?: number
    float?: boolean
    validate?: PromptDef.Validate<number>
  }

  export interface ConfirmOptions extends PromptDef.Base {
    initial?: boolean
  }

  export interface SelectOptions<T> extends PromptDef.Base {
    choices: readonly PromptDef.Choice<T>[]
    initial?: number | T
  }

  export interface MultiSelectOptions<T> extends PromptDef.Base {
    choices: readonly PromptDef.Choice<T>[]
    initial?: readonly (number | T)[]
    required?: boolean
    min?: number
    max?: number
  }

  export interface AutocompleteOptions<T> extends PromptDef.Base {
    choices: readonly PromptDef.Choice<T>[]
    placeholder?: string
    suggest?: (
      input: string,
      choices: readonly PromptDef.Choice<T>[],
    ) => readonly PromptDef.Choice<T>[]
  }

  export interface PathOptions extends PromptDef.Base {
    initial?: string
    root?: string
    directory?: boolean
    validate?: PromptDef.Validate<string>
  }

  export interface Actions {
    text(options: PromptDef.TextOptions): Future<string, unknown>
    password(options: PromptDef.PasswordOptions): Future<string, unknown>
    number(options: PromptDef.NumberOptions): Future<number, unknown>
    confirm(options: PromptDef.ConfirmOptions): Future<boolean, unknown>
    select<T>(options: PromptDef.SelectOptions<T>): Future<T, unknown>
    multiselect<T>(options: PromptDef.MultiSelectOptions<T>): Future<T[], unknown>
    autocomplete<T>(options: PromptDef.AutocompleteOptions<T>): Future<T, unknown>
    path(options: PromptDef.PathOptions): Future<string, unknown>
  }
}
