import type { Flow, Operation } from 'std:effect'

import type { Helpers } from './helpers'

export namespace ProviderDef {
  /** What the installed provider can do. The client gates dispatch on these, and the protocol's
   * failing defaults back them up for actions an impl omits. `tts` covers both `tts` and
   * `ttsStream`; `tools`/`json` refine what `chat`/`chatStream` accept. */
  export interface Capabilities {
    readonly chat: boolean
    readonly chatStream: boolean
    readonly tools: boolean
    readonly json: boolean
    readonly embed: boolean
    readonly tts: boolean
    readonly stt: boolean
  }

  /** The provider protocol context — what an impl's `setup()` resolves. */
  export interface Info {
    readonly provider: string
    readonly capabilities: Capabilities
  }

  /**
   * The contract every model-provider binding implements. Specs are portable, provider-neutral
   * data; the impl owns all wire en/decoding and classifies its backend's errors into `AiErrors`
   * tags (a malformed 200 body MUST fail `ai.bad-response`, never degrade silently). Every action
   * is capability-gated: the protocol provides failing (`ai.unsupported`) defaults, and
   * `providerDefaults(name)` gives impls a typed spread to build on.
   */
  export interface Actions {
    chat(spec: Helpers.ChatSpec): Operation<Helpers.ChatResult>
    /** Resolve a live delta flow. The flow closes `true` on a clean end, or with the classifying
     * Failure when the stream is truncated or the provider reports a mid-stream error. */
    chatStream(spec: Helpers.ChatSpec): Operation<Flow<Helpers.ChatDelta, Helpers.StreamClose>>
    embed(spec: Helpers.EmbedSpec): Operation<Helpers.EmbedResult>
    /** Synthesize speech and resolve the whole clip's bytes. */
    tts(spec: Helpers.SpeechSpec): Operation<Uint8Array>
    /** Synthesize speech as a byte flow for low-latency playback. */
    ttsStream(spec: Helpers.SpeechSpec): Operation<Flow<Uint8Array, Helpers.StreamClose>>
    /** Transcribe audio and resolve the transcript text. */
    stt(spec: Helpers.TranscribeSpec): Operation<string>
  }
}
