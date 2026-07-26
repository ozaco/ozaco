/**
 * How this process was deployed, published by whoever orchestrates it (the daemon). Absent in a plain
 * single-process app, which is what makes self-wiring default to own + serve.
 */
export interface RoleResolver {
  /** does THIS process run the thing called `name`? */
  owns(name: string): boolean
  /** does THIS process expose routes at all? */
  serves(): boolean
  /** is this service already wired by the orchestrator, so it must not wire itself? */
  managed(service: unknown): boolean
}

/** What one process does with one piece of the app: run it, expose it, or both. */
export interface Role {
  /** install its plugins and register it on the broker — this process executes the code */
  own: boolean
  /** put its routes on the router — this process answers the client, wherever the code lives */
  serve: boolean
}
