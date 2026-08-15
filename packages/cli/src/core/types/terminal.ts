import type { Flow, Operation } from 'std:effect'

import type { Key, Size } from './common'

/** How much color the terminal can render. */
export type ColorLevel = 'none' | '16' | '256' | 'true'

export namespace TerminalDef {
  /** What the installed terminal can do, detected once at setup (env/platform reads live in the
   * impls — core and the feature modules only ever branch on these flags). */
  export interface Capabilities {
    /** tty in AND out — prompts and live regions are possible. */
    readonly interactive: boolean
    readonly color: ColorLevel
    readonly unicode: boolean
    /** the input can enter raw (unbuffered, signal-free) mode. */
    readonly rawMode: boolean
    /** the terminal reports size changes (`resize()` emits). */
    readonly resize: boolean
    /** the terminal supports the alternate screen buffer. */
    readonly altScreen: boolean
  }

  /** The terminal protocol context — what an impl's `setup()` resolves. */
  export interface Info {
    readonly terminal: string
    readonly capabilities: Capabilities
  }

  export interface RendererOptions {
    /** Queue (FIFO) for the live region instead of failing `cli.busy` when it is taken. */
    wait?: boolean
  }

  /**
   * An exclusive live-region lease. All in-place drawing (spinners, live tables, prompt frames)
   * goes through one of these — never through raw cursor codes — so regions can't interleave and
   * the cursor is always restored. `done()` commits + releases early; otherwise the lease releases
   * (and wipes any leftover frame) when the acquiring scope exits.
   */
  export interface Renderer {
    /** Replace the live region with `frame` (no-op once released / on non-interactive outputs). */
    render(frame: string): Operation<void>
    /** Erase the live region but keep the lease. */
    clear(): Operation<void>
    /** Commit `frame` (if given) permanently to the scrollback and release the lease. */
    done(frame?: string): Operation<void>
  }

  /**
   * The contract every terminal binding implements. Impls own the platform surface (streams, raw
   * mode, signals, size probing); everything above them is portable. `resize` is capability-gated:
   * the protocol provides a failing default for impls that omit it.
   */
  export interface Actions {
    /** Write raw text to the output. The ONLY output path — everything funnels through here. */
    write(text: string): Operation<void>
    /** Current terminal size. */
    size(): Operation<Size>
    /** The decoded key flow of the active `session()`; fails `cli.terminal` outside one. */
    keys(): Operation<Flow<Key, void>>
    /** Size-change flow (capability-gated — fails `cli.unsupported` without the capability). */
    resize(): Operation<Flow<Size, never>>
    /**
     * Run `fn` inside a raw-input session: raw mode on, a key reader feeding the `keys()` flow and
     * a SIGINT guard that fails the session (`cli.cancelled`) so teardown restores the tty. On exit
     * — success, failure, or halt — raw mode is switched off and the cursor restored.
     */
    session<R>(fn: () => Operation<R>): Operation<R>
  }

  /** Protocol-level actions implemented once in core, shared by every impl. */
  export interface Handlers {
    /**
     * Acquire the exclusive live-region lease (see {@link Renderer}). A second concurrent acquire
     * fails `cli.busy`, or queues FIFO with `{ wait: true }`. The lease is a resource: it
     * auto-releases (and cleans the screen) when the acquiring scope exits, re-renders on terminal
     * resize when the capability is present, and hides/shows the cursor around its lifetime.
     */
    renderer(options?: RendererOptions): Operation<Renderer>
  }
}
