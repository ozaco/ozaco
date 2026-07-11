import type { Future, Operation, Stream } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { InputStream, Key, OutputStream, Size } from './common'

export type TerminalDef = Plugin<
  TerminalDef.Context,
  [options?: TerminalDef.Options],
  TerminalDef.Actions
>

export namespace TerminalDef {
  export type Encoding = 'utf8' | 'hex' | 'binary' | 'ascii' | 'base64'

  export interface Options {
    input?: InputStream
    output?: OutputStream
    error?: OutputStream
    /** Force interactive (raw-mode) behavior on/off. Defaults to the input/output `isTTY`. */
    interactive?: boolean
    encoding?: TerminalDef.Encoding
  }

  export interface Context {
    input: InputStream
    output: OutputStream
    error: OutputStream
    interactive: boolean
    encoding: TerminalDef.Encoding
  }

  export interface WrapAnsiOptions {
    /**
     * If `true`, break words in the middle if they don't fit on a line.
     * If `false`, only break at word boundaries.
     *
     * @default false
     */
    hard?: boolean

    /**
     * If `true`, wrap at word boundaries when possible.
     * If `false`, don't perform word wrapping (only wrap at explicit newlines).
     *
     * @default true
     */
    wordWrap?: boolean

    /**
     * If `true`, trim leading and trailing whitespace from each line.
     * If `false`, preserve whitespace.
     *
     * @default true
     */
    trim?: boolean

    /**
     * When it's ambiguous and `true`, count ambiguous width characters as 1 character wide.
     * If `false`, count them as 2 characters wide.
     *
     * @default true
     */
    ambiguousIsNarrow?: boolean
  }

  export interface Renderer {
    render(frame: string): Future<void>
    clear(): Future<void>
    done(frame?: string): Future<void>
  }

  export interface Actions {
    /** Current terminal size. */
    size(): Future<Size>

    /** Whether the terminal is interactive (TTY + raw-mode capable). */
    isInteractive(): Future<boolean>

    /**
     * Run `fn` inside a raw-input session: raw mode on, cursor hidden, a key reader feeding a
     * shared key stream. On exit (success, error, or halt) raw mode and the cursor are restored.
     */
    session<R>(fn: () => Operation<R>): Future<R>

    /** Write raw text to the output stream. */
    write(text: string | Stream<string, unknown>): Future<void>

    /** The decoded key stream for the active `session()`. Subscribe with `yield* stream`. */
    keys(): Future<Stream<Key, void>>

    stripAnsi(text: string): Future<string>
    wrapAnsi(text: string, columns: number, options: TerminalDef.WrapAnsiOptions): Future<string>
    displayWidth(line: string): Future<number>

    renderer(columns: number): Future<TerminalDef.Renderer>
  }
}
