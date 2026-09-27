import type { Spec } from '../types/spec'
import type { Utils } from '../types/utils'

/** Split a field reference into the column and the (optional) path inside it. */
export const refOf = <TField extends string>(
  ref: Utils.FieldRef<TField>,
): { readonly field: TField; readonly path?: readonly Spec.PathSegment[] } => {
  if (typeof ref === 'string') {
    return { field: ref }
  }

  const [field, ...path] = ref

  return path.length === 0 ? { field } : { field, path }
}

/** Whether a leaf filter reaches into a `json` column. */
export const hasPath = (filter: {
  readonly path?: readonly Spec.PathSegment[] | undefined
}): boolean => filter.path !== undefined && filter.path.length > 0
