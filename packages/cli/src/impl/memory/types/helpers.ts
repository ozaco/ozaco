import type { Size } from 'cli:core'

/** The shapes this binding passes around inside itself. */
export namespace Helpers {
  /** What the fake screen keeps between the test's side and the driver's side. */
  export interface State {
    written: string
    size: Size
    raw: boolean
    onText: ((text: string) => void) | null
    onResize: ((size: Size) => void) | null
    onInterrupt: (() => void) | null
    keys: string[]
  }
}
