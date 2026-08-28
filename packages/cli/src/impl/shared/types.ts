import type { Key, Size, TerminalDef } from 'cli:core'

/**
 * What a terminal BINDING owns: the platform surface, and nothing else. Everything above it —
 * key decoding, the session lifecycle, the keys flow, the resize flow — is built once in
 * {@link terminalActions}, so a binding is the few dozen lines that only it can write.
 */
export namespace Driver {
  export interface Handle {
    /** the only output path. */
    write(text: string): void
    size(): Size

    /** Start delivering input as decoded text; the returned function detaches the listener.
     * Never destroy the input here — the process keeps using it after the session. */
    listen(onText: (text: string) => void): () => void

    /** Enter raw (unbuffered, signal-free) mode; the returned function restores the previous
     * mode. A binding whose input cannot go raw returns a no-op and reports `rawMode: false`. */
    raw(): () => void

    /** Size changes, when the platform reports them (`resize` capability). */
    onResize?: ((next: (size: Size) => void) => () => void) | undefined

    /** Interrupts (ctrl+c at the platform level), when raw mode does not already deliver them
     * as a key. Fails the running session with `cli.cancelled`. */
    onInterrupt?: ((next: () => void) => () => void) | undefined
  }

  /** What a binding resolves at setup: its identity, its capabilities and its handle. */
  export interface Binding {
    readonly terminal: string
    readonly capabilities: TerminalDef.Capabilities
    readonly handle: Handle
  }

  /** The session state the shared actions keep — one active session per install. */
  export interface Session {
    keys: readonly Key[]
    active: boolean
  }
}

/** The shapes the shared terminal plumbing passes around inside itself. */
export namespace Helpers {
  /** The modifier flags a decoded key may carry. */
  export interface Mods {
    ctrl?: boolean
    meta?: boolean
    shift?: boolean
  }
}
