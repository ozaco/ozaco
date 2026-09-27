/** The shapes the table-backed store passes around inside itself. */
export namespace Helpers {
  /** An entry row as the store reads it back (the system `_id` is the namespaced key). */
  export interface Row {
    readonly _id: string
    readonly data: string
    readonly expires_at: number | null
    readonly tags: readonly string[]
  }
}
