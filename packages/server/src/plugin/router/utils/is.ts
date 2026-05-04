import type { Helpers as CoreHelpers } from 'server:core'
import { Rest, Ws } from 'server:core'
import type { AnyType } from 'std:shared'
import { isObject } from 'std:shared'

export const isRestSetting = (value: unknown): value is CoreHelpers.TransformerSetting => {
  if (!isObject(value)) {
    return false
  }
  const v = value as AnyType
  return v.transformer === Rest && typeof v.method === 'string' && typeof v.path === 'string'
}

export const isWsSetting = (value: unknown): value is CoreHelpers.TransformerSetting => {
  if (!isObject(value)) {
    return false
  }
  const v = value as AnyType
  return v.transformer === Ws && typeof v.method === 'string' && typeof v.path === 'string'
}

export const isRoutableSetting = (value: unknown): value is CoreHelpers.TransformerSetting =>
  isRestSetting(value) || isWsSetting(value)
