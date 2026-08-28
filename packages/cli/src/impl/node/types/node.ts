import type { TerminalDef } from 'cli:core'

export namespace NodeTerminalDef {
  export interface Options {
    /** Override what was detected. A `--no-color` flag lands here. */
    readonly capabilities?: Partial<TerminalDef.Capabilities> | undefined
  }
}
