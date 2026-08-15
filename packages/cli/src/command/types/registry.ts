import type { Operation } from 'std:effect'

export namespace RegistryDef {
  /**
   * A registered command as the registry sees it — kept structural so the registry needn't know the
   * spec/node internals. `register` receives a command spec; the stored value is its compiled
   * runtime node. Both expose `name`/`description`, which is all program help ever reads.
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
    commands: Map<string, Command>
  }

  export interface Actions {
    /** Register a top-level command (compiled, its `setup` NOT run), keyed by its `name`. */
    register(command: Command): Operation<void>
    /** Dispatch argv: `argv[0]` selects a registered command, the rest is run against it. */
    run(argv?: string[]): Operation<void>
    /** Look up a registered command by name. */
    get(name: string): Operation<Command | undefined>
  }
}
