/** What `readonly` / `docs` change in the emitted type text (the third argument of
 * `schemaToType`; `generate` reads them off its options). */
export interface SchemaStyle {
  /** Emit `readonly` members and `readonly T[]` arrays. */
  readonly readonly?: boolean | undefined

  /** Emit a JSDoc line from every schema `description` (properties, actions). */
  readonly docs?: boolean | undefined

  /** Emit an optional member as `name?: T | undefined` — what a consumer compiled with
   * `exactOptionalPropertyTypes` needs to pass a partial object straight through (an absent
   * optional and an explicit `undefined` are the same thing on the wire: `JSON.stringify` drops
   * both, the server's zod takes both). */
  readonly exactOptional?: boolean | undefined
}

export interface GenerateOptions extends SchemaStyle {
  /** Leading comment of the emitted file (default: a "generated — do not edit" banner). */
  readonly banner?: string | undefined

  /** Where `Flow` is imported from in the emitted file (default `@ozaco/std/effect`). */
  readonly effectModule?: string | undefined

  /** Also emit `apiEnums`: every string enum the schemas declare, `as const`, by service and
   * field (`apiEnums.contacts.status` → `['lead', 'active', 'dnc']`) — the one list a form, a
   * filter and a type share. */
  readonly enums?: boolean | undefined
}

/** What `generate`'s emitters carry along: whether `Flow` got used, and the style asked. */
export interface Emit {
  flow: boolean
  readonly style: SchemaStyle
}
