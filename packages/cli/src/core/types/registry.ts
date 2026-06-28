import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

export namespace RegistryDef {
  /** A registered command: any command-plugin (kept generic so core needn't depend on cli:command). */
  export type Command = Plugin<AnyType, AnyType, AnyType[], AnyType>

  export interface Options {
    name?: string | undefined
    version?: string | undefined
    description?: string | undefined
  }

  export interface Context {
    name: string
    version?: string | undefined
    description?: string | undefined
    commands: Map<string, RegistryDef.Command>
  }

  export interface Actions {
    /** Register (and install) a top-level command, keyed by its `name`. */
    register(command: RegistryDef.Command): Future<void, unknown>
    /** Dispatch argv: `argv[0]` selects a registered command, the rest is run against it. */
    run(argv?: string[]): Future<void, unknown>
    /** Look up a registered command by name. */
    get(name: string): Future<RegistryDef.Command | undefined, unknown>
  }
}
