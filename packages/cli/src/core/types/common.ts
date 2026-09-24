export interface WrapOptions {
  /** Break words longer than a line at the column boundary (default false). */
  hard?: boolean
}

export interface Size {
  columns: number
  rows: number
  /**
   * `true` when the platform reported no size and `columns`/`rows` are the defaults (a pipe, a
   * redirected file) — width-sensitive output (tables) then skips truncation instead of guessing.
   */
  fallback?: boolean | undefined
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
