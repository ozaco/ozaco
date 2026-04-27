import type { Action, Service } from 'server:core'

import type { NatsConnection, Subscription } from '@nats-io/nats-core'

import type { NatsTransport } from '.'

export interface NatsTransportOptions {
  servers: string | string[]
  prefix?: string
  requestTimeoutMs?: number
}

export interface NatsEntry {
  service: Service
  key: string
  action: Action
  subject: string
  queueGroup?: string | undefined
}

export interface NatsTransportContext {
  subjects: Map<string, NatsEntry>
  subscriptions: Map<string, Subscription>
  options: NatsTransportOptions
  nc: NatsConnection
  abort: AbortController
  isStarted: boolean
  isPaused: false | string
}

export interface NatsSettingOptions {
  subject?: string
  queueGroup?: string
}

export interface NatsSetting extends NatsSettingOptions {
  transport: typeof NatsTransport
}
