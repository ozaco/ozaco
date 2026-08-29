import type { Helpers as Ai } from 'ai:core'
import type { Operation, Queue, Subscription } from 'std:effect'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface OpenAIState {
    readonly base: string
    /** Lower-cased user headers with the auth header computed OVER them. */
    readonly headers: Record<string, string>
    readonly timeoutMs: number | undefined
  }

  /** The OpenAI structured error envelope. */
  export interface ProviderError {
    readonly message?: string | undefined
    readonly type?: string | undefined
    readonly code?: string | undefined
  }

  export interface PumpInput<T> {
    readonly subscription: Subscription<Uint8Array, void>
    readonly queue: Queue<T, Ai.StreamClose>
    readonly parse: (data: string) => Operation<T | undefined>
  }

  export interface CopyInput {
    readonly subscription: Subscription<Uint8Array, void>
    readonly queue: Queue<Uint8Array, Ai.StreamClose>
  }
}
