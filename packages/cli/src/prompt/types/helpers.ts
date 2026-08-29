import type { PromptDef } from './prompt'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface InputState {
    value: string
    cursor: number
  }

  export interface RenderInputOptions {
    mask?: string | undefined
    placeholder?: string | undefined
  }

  export interface InlineParts {
    body: string
    error?: string | undefined
  }

  export interface Page<T> {
    items: readonly T[]
    start: number
  }

  export interface StepOptions {
    length: number
    disabled?: (index: number) => boolean
  }

  export interface FieldState {
    input: InputState
    error?: string | undefined
  }

  export interface ConfirmState {
    value: boolean
  }

  export interface SelectState {
    active: number
  }

  export interface MultiSelectState {
    cursor: number
    selected: Set<number>
    error?: string | undefined
  }

  export interface AutocompleteState {
    input: InputState
    active: number
  }

  export interface NumberParsed {
    value?: number
    error?: string
  }

  export interface PathState {
    input: InputState
    /** The input value `entries` was scanned for (drives the lazy rescan in `prepare`). */
    scanned: string
    entries: PromptDef.PathEntry[]
    error?: string | undefined
  }

  export interface Split {
    /** The directory to list. */
    dir: string
    /** The typed leaf being completed. */
    prefix: string
    /** The input text up to (excluding) the leaf. */
    base: string
  }
}
