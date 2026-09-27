/**
 * JSON Schema document → TypeScript type TEXT. Deliberately small and dependency-free: it covers
 * what `z.toJSONSchema` emits for wizard schemas (objects, arrays, primitives, enum/const
 * literals, anyOf/oneOf unions, additionalProperties) — anything unrecognized (including the
 * manifest's `{ declared: true }` opaque marker) degrades to `unknown`, never to an error.
 */

import { typeTextOf } from './internal/schema'

/** Render one JSON Schema document as TypeScript type text (multi-line for object shapes). */
export const schemaToType = (schema: unknown, depth = 0): string => typeTextOf(schema, depth)
