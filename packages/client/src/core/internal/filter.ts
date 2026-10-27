import type { ClientDef } from '../types/client'

/** Escape `%`, `_` and `\` so `text` matches ITSELF inside a `like` pattern. */
export const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/gu, String.raw`\$&`)

/** A field reference as the wire carries it: the column, plus the path into it when given. */
export const refOf = (
  field: ClientDef.FieldRef,
): { readonly field: string; readonly path?: readonly (string | number)[] } =>
  typeof field === 'string' ? { field } : { field: field[0], path: field.slice(1) }
