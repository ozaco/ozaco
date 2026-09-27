import { attributesOf } from '../internal/attributes'
import { MAX_ATTRIBUTES, MAX_VALUE_BYTES } from '../internal/const'
import type { TraceDef } from '../types/trace'

/**
 * Attributes in their stored form, under the span limits by default (string values ≤ 2048 UTF-8
 * bytes, 128 keys): `null` / `undefined` dropped, plain objects flattened to dotted keys (3 levels;
 * deeper ones a capped JSON string), arrays of objects a JSON string, mixed primitive arrays string
 * arrays, non-finite numbers their strings (`'NaN'`, `'Infinity'`, `'-Infinity'`: every sink —
 * JSON, protobuf, a store — then holds the same value). `dropped` counts the keys past `maxCount`.
 */
export const toAttributes = (
  input: TraceDef.AttributesInput | undefined,
  options: { maxBytes?: number | undefined; maxCount?: number | undefined } = {},
): { attributes: TraceDef.Attributes; dropped: number } =>
  attributesOf(input, options.maxBytes ?? MAX_VALUE_BYTES, options.maxCount ?? MAX_ATTRIBUTES)
