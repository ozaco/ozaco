import type { Action, GatewayDef } from 'server:core'
import { Gateway } from 'server:core'
import type { AnyType } from 'std:shared'
import { isObject } from 'std:shared'

const isMarked = (value: unknown): value is GatewayDef.TransformerSetting => {
  if (!isObject(value)) {
    return false
  }
  const setting = value as AnyType
  return (
    setting.transformer === Gateway &&
    typeof setting.method === 'string' &&
    typeof setting.path === 'string'
  )
}

// the router captures the concrete Action at mount time, so the seam can hand it to Broker.call
export const resolveRouteAction = (entry: GatewayDef.RegisteredRoute): Action => entry.action

export const isRestSetting = (value: unknown): value is GatewayDef.TransformerSetting =>
  isMarked(value) && (value as AnyType).method !== 'WS'

export const isWsSetting = (value: unknown): value is GatewayDef.TransformerSetting =>
  isMarked(value) && (value as AnyType).method === 'WS'

export const isRoutableSetting = (value: unknown): value is GatewayDef.TransformerSetting =>
  isMarked(value)
