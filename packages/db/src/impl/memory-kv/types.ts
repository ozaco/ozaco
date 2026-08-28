import type { KvDef } from 'db:core'

export namespace MemoryKvDef {
  export interface Options extends KvDef.CommonOptions {
    /** Share one store between several installs (different scopes) so they see the same keys —
     * the in-process stand-in for a shared backend. Default: a private store per install. */
    readonly link?: Link | undefined
  }

  export interface Entry {
    readonly data: Uint8Array

    /** epoch ms, or null for "never". */
    expiresAt: number | null
    readonly tags: Set<string>
  }

  /** The shared in-process store. */
  export interface Link {
    readonly entries: Map<string, Entry>

    /** namespaced tag → keys carrying it. */
    readonly tags: Map<string, Set<string>>
  }

  export interface State {
    readonly link: Link
  }
}
