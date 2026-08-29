import type { MockCalls, MockResponder, MockScript } from './mock'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface MockState {
    readonly script: MockScript
    readonly cursors: Map<string, number>
    readonly calls: MockCalls
  }

  export interface ResolveInput<TSpec, TValue> {
    readonly state: MockState
    readonly key: keyof MockScript & string
    readonly spec: TSpec
    readonly responder: MockResponder<TSpec, TValue> | undefined
    readonly fallback: TValue
  }
}
