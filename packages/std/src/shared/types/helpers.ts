/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /** A flattened leaf: its dotted key path and the value found there. */
  export interface FlatEntry {
    key: string
    value: unknown
  }
}
