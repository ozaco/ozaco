export interface GenerateOptions {
  /** Leading comment of the emitted file (default: a "generated — do not edit" banner). */
  readonly banner?: string | undefined

  /** Where `Flow` is imported from in the emitted file (default `@ozaco/std/effect`). */
  readonly effectModule?: string | undefined
}
