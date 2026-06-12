import type { PolicyDef } from 'server:core'

export const TimeoutPolicyKey = 'timeout' as const

export namespace Timeout {
  export interface Options extends PolicyDef.Options {
    timeoutMs?: number
    timeoutStreams?: boolean
  }

  export interface Context extends PolicyDef.Context {
    timeoutMs: number
    timeoutStreams: boolean
  }
}
