import type { Action, Helpers as CoreHelpers, Service } from 'server:core'

export interface RegisteredRoute {
  sym: symbol
  key?: string
  prefix: string

  setting: CoreHelpers.TransformerSetting
  target: Action | Service
}
