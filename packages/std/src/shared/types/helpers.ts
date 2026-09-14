/** Public helper shapes of the shared module: `FlatEntry` is the return type of `flattenEntries`. */
export namespace Helpers {
  /** A flattened leaf: its dotted key path and the value found there. */
  export interface FlatEntry {
    key: string
    value: unknown
  }
}
