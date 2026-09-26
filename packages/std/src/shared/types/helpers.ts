/** Helper shapes of the shared module: `FlatEntry` is the return type of `flattenEntries`. */
export namespace Helpers {
  /** A flattened leaf: its dotted key path and the value found there. */
  export interface FlatEntry {
    key: string
    value: unknown
  }

  /** A parsed version (build metadata dropped) — `prerelease` holds the dot-separated identifiers. */
  export interface Version {
    major: number
    minor: number
    patch: number
    prerelease: string[]
  }
}
