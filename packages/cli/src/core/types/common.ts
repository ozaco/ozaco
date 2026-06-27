import type { AnyType } from 'std:shared'

export interface Size {
  columns: number
  rows: number
}

/** A decoded keypress event. */
export interface Key {
  /**
   * Logical name: `up`/`down`/`left`/`right`, `return`, `backspace`, `delete`, `tab`, `escape`,
   * `space`, `home`, `end`, `pageup`, `pagedown`, a single printable character, or `unknown`.
   */
  name: string
  /** The raw decoded character/sequence as text. */
  sequence: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  /** The original bytes that produced this key. */
  raw: Uint8Array
}

/** Minimal structural shape of a readable input (Node `ReadStream`, or a test double). */
export interface InputStream {
  on(event: string, listener: (...args: AnyType[]) => void): this
  off(event: string, listener: (...args: AnyType[]) => void): this
  setRawMode?(mode: boolean): unknown
  resume?(): unknown
  pause?(): unknown
  isTTY?: boolean
}

/** Minimal structural shape of a writable output (Node `WriteStream`, or a test double). */
export interface OutputStream {
  write(data: string): unknown
  columns?: number
  rows?: number
  isTTY?: boolean
}
