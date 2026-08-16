declare module 'server:core' {
  interface PolicyOptionsMap {
    'circuit-breaker': CircuitBreakerOverride
  }
}

/** Install-time options for the circuit-breaker policy. */
export interface CircuitBreakerOptions {
  /** Consecutive counted failures that open the circuit (default 5). */
  readonly threshold?: number | undefined
  /** How long an open circuit rejects before allowing probes, in milliseconds (default 30_000). */
  readonly resetTimeoutMs?: number | undefined
  /** Concurrent probe dispatches allowed while half-open (default 1). */
  readonly halfOpenMax?: number | undefined
}

/** Per-action override (`policies: { 'circuit-breaker': { … } | false }`) — same shape. */
export type CircuitBreakerOverride = CircuitBreakerOptions

/** The breaker's lifecycle phase. */
export type BreakerPhase = 'closed' | 'open' | 'half-open'

/** One per-action breaker. */
export interface BreakerSlot {
  phase: BreakerPhase
  /** Consecutive counted failures while closed. */
  failures: number
  /** When the circuit last opened (epoch ms). */
  openedAt: number
  /** Probes admitted during the current half-open window. */
  probes: number
}

/** Scope-bound state: the resolved defaults plus the breakers keyed by `service\0action`. */
export interface CircuitBreakerState {
  readonly breakers: Map<string, BreakerSlot>
  readonly threshold: number
  readonly resetTimeoutMs: number
  readonly halfOpenMax: number
}
