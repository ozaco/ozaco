export interface WrapOptions {
  /** Break words longer than a line at the column boundary (default false). */
  hard?: boolean
}

export interface Size {
  columns: number
  rows: number
}

/** A decoded keypress event. */
export interface Key {
  /**
   * Logical name: `up`/`down`/`left`/`right`, `return`, `backspace`, `delete`, `tab`, `escape`,
   * `space`, `home`, `end`, `pageup`, `pagedown`, `insert`, a single printable character, or
   * `unknown`.
   */
  name: string
  /** The raw decoded character/sequence as text. */
  sequence: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}
