import type { Helpers as CoreHelpers } from 'server:core'
import { RestTransformer } from 'server:core'
import type { AnyType } from 'std:shared'
import { isObject } from 'std:shared'

export const isRestSetting = (value: unknown): value is CoreHelpers.TransformerSetting => {
  if (!isObject(value)) {
    return false
  }
  const v = value as AnyType
  return (
    v.transformer === RestTransformer && typeof v.method === 'string' && typeof v.path === 'string'
  )
}
