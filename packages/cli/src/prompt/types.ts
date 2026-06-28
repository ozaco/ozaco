import type { Key, PaletteDef } from 'cli:core'
import type { Operation } from 'std:effect'

export interface PromptContext {
  palette: PaletteDef.Context
  columns: number
}

export type KeyAction<S, V> =
  | { type: 'update'; state: S }
  | { type: 'submit'; value: V }
  | { type: 'cancel' }
  | undefined

export interface PromptSpec<S, V> {
  initial: S
  description?: string | undefined
  render(state: S, ctx: PromptContext): string
  onKey(state: S, key: Key, ctx: PromptContext): KeyAction<S, V>
  submitted(value: V, state: S, ctx: PromptContext): string
  cancelled(state: S, ctx: PromptContext): string
  fallback?(ctx: PromptContext): Operation<V, unknown>
}

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

export interface PathEntry {
  name: string
  isDir: boolean
}
