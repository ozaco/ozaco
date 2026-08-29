import type { Helpers, ProviderDef } from 'ai:core'
import type { Operation } from 'std:effect'

/** One scripted stream: its chunks, whether it stays open after them (teardown tests), and the
 * close value (`true` default; a Failure simulates mid-stream truncation). */
export interface MockStream<T> {
  readonly chunks: readonly T[]
  readonly hang?: boolean | undefined
  readonly close?: Helpers.StreamClose | undefined
}

/** A scripted response: one value for every call, an explicit `{ queue }` consumed call by call
 * (exhaustion fails `ai.configuration`), or a function of the resolved spec — which may return an
 * `Operation` (e.g. `() => fail(AiErrors.Auth, …)`) to script failures. */
export type MockResponder<TSpec, TValue> =
  | TValue
  | { readonly queue: readonly TValue[] }
  | ((spec: TSpec) => TValue | Operation<TValue>)

/** A scripted chat turn — omitted fields are completed from the spec (`model`), the `text`
 * (message/finishReason), and sensible defaults. */
export type MockChatResult = Partial<Helpers.ChatResult>

export interface MockScript {
  /** Overrides merged over the full-capability default. */
  readonly capabilities?: Partial<ProviderDef.Capabilities> | undefined
  readonly chat?: MockResponder<Helpers.ChatSpec, MockChatResult> | undefined
  readonly chatStream?: MockResponder<Helpers.ChatSpec, MockStream<Helpers.ChatDelta>> | undefined
  /** One vector per input entry. Default: `[0]` per entry. */
  readonly embed?: MockResponder<Helpers.EmbedSpec, readonly (readonly number[])[]> | undefined
  readonly tts?: MockResponder<Helpers.SpeechSpec, Uint8Array> | undefined
  readonly ttsStream?: MockResponder<Helpers.SpeechSpec, MockStream<Uint8Array>> | undefined
  readonly stt?: MockResponder<Helpers.TranscribeSpec, string> | undefined
}

/** Every spec the mock received, per action — assert on these in tests. */
export interface MockCalls {
  readonly chat: Helpers.ChatSpec[]
  readonly chatStream: Helpers.ChatSpec[]
  readonly embed: Helpers.EmbedSpec[]
  readonly tts: Helpers.SpeechSpec[]
  readonly ttsStream: Helpers.SpeechSpec[]
  readonly stt: Helpers.TranscribeSpec[]
}

/** The mock's context: provider info plus the received-call log. */
export interface MockInfo extends ProviderDef.Info {
  readonly calls: MockCalls
}

/** The shapes this module passes around inside itself. */
