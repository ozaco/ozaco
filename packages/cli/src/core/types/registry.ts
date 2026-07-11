import type { Future } from 'std:effect'

export namespace RegistryDef {
  /**
   * A registered command as the registry sees it — kept structural so core needn't depend on
   * cli:command. `register` receives a command spec; the stored value is its compiled runtime node.
   * Both expose `name`/`description`, which is all the registry + program help ever read.
   */
  export interface Command {
    name: string
    description?: string | undefined
  }

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
    /** Register a top-level command (compiles it and runs its own setup), keyed by its `name`. */
    register(command: RegistryDef.Command): Future<void>
    /** Dispatch argv: `argv[0]` selects a registered command, the rest is run against it. */
    run(argv?: string[]): Future<void>
    /** Look up a registered command by name. */
    get(name: string): Future<RegistryDef.Command | undefined>
  }
}
