declare module 'server:core' {
  interface PolicyOptionsMap {
    timeout: TimeoutOverride
  }
}

/** Install-time options for the timeout policy. */
export interface TimeoutOptions {
  /** Deadline per dispatch in milliseconds; 0 or less disables the layer (default 30_000). */
  readonly ms?: number | undefined
}

/** Per-action override (`policies: { timeout: { ms } | false }`). */
export interface TimeoutOverride {
  readonly ms: number
}

/** Scope-bound state: the resolved default deadline. */
export interface TimeoutState {
  readonly ms: number
}
