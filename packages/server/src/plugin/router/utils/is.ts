import type { Helpers as CoreHelpers } from 'server:core'
import { Rest } from 'server:core'
import type { AnyType } from 'std:shared'
import { isObject } from 'std:shared'

export const isRestSetting = (value: unknown): value is CoreHelpers.TransformerSetting => {
  if (!isObject(value)) {
    return false
  }
  const v = value as AnyType
  return v.transformer === Rest && typeof v.method === 'string' && typeof v.path === 'string'
}
