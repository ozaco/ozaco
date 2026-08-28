import type { Size, TerminalDef } from 'cli:core'

export namespace MemoryTerminalDef {
  /** What the fake terminal reports about itself. Every capability is settable, so a test can
   * ask for the non-interactive path or a 16-color one without a real tty. */
  export interface Options {
    /** the screen to drive it with — `createMemoryScreen()`. Omitted: a throwaway one. */
    readonly screen?: Screen | undefined
  }

  export interface ScreenOptions {
    readonly columns?: number | undefined
    readonly rows?: number | undefined
    readonly capabilities?: Partial<TerminalDef.Capabilities> | undefined
  }

  /** The test's side of the terminal: type into it, read what came out. */
  export interface Screen {
    readonly capabilities: TerminalDef.Capabilities

    /** Feed raw text — escape sequences included — as one chunk of input. */
    feed(text: string): void

    /** Feed printable text, one key per character. */
    type(text: string): void

    /** Feed named keys (`up`, `enter`, `ctrl+c`, …) or single characters. */
    press(...keys: readonly string[]): void

    /** Raise the platform interrupt, as ctrl+c does outside raw mode. */
    interrupt(): void

    /** Everything written so far, escape sequences included. */
    read(): string

    /** The same, with the escape sequences stripped — what a person would see. */
    plain(): string
    clear(): void

    /** Resize, and notify a `resize()` flow if the capability is on. */
    setSize(size: Size): void

    /** Whether the terminal is in raw mode right now (a session is running). */
    readonly raw: boolean

    /** every key the decoder produced, by name and in order — what the binding delivered. */
    readonly keys: readonly string[]
  }
}
