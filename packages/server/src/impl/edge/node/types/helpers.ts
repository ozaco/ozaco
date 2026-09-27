/** The shapes this edge passes around inside itself. */
export namespace Helpers {
  /** How the driver reports a fault of its own: one Logger WARN line. */
  export type Warn = (message: string, data: Record<string, unknown>) => void

  /** How `write` learns of the client: `gone` aborts when it left before the response finished. */
  export interface Writing {
    readonly gone: AbortSignal
    readonly warn: Warn
  }
}
