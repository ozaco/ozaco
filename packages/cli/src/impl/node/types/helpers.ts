import type { AnyType } from 'std:shared'

/** The shapes this binding passes around inside itself. */
export namespace Helpers {
  /** The slice of the host `process` this binding touches — structural, so it fits Node and Bun
   * without either one's type packages. */
  export interface Stdin {
    readonly isTTY?: boolean | undefined
    on(event: string, listener: (chunk: AnyType) => void): unknown
    off(event: string, listener: (chunk: AnyType) => void): unknown
    setRawMode?(raw: boolean): unknown
    resume?(): unknown
    pause?(): unknown
  }

  export interface Stdout {
    readonly isTTY?: boolean | undefined
    readonly columns?: number | undefined
    readonly rows?: number | undefined
    write(text: string): unknown
  }

  export interface Process {
    readonly stdin: Stdin
    readonly stdout: Stdout
    readonly env: Record<string, string | undefined>
    readonly platform?: string | undefined
    on(event: string, listener: () => void): unknown
    off(event: string, listener: () => void): unknown
  }
}
