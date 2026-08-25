import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { Helpers } from './helpers'
import type { ProviderDef } from './provider'

export type AiDef = Plugin<AiDef.Context, [options?: AiDef.Options], AiDef.Actions>

export namespace AiDef {
  /** Per-modality model names — the fix for the old single-shared-model bug: chat and embed (and
   * speech) never compete for one `model` field again. A per-call `options.model` overrides. */
  export interface Models {
    readonly chat?: string | undefined
    readonly embed?: string | undefined
    readonly tts?: string | undefined
    readonly stt?: string | undefined
  }

  /** Install-time defaults merged UNDER per-call options. */
  export interface Defaults extends Helpers.Sampling {
    /** Default speech voice for `tts`/`ttsStream`. */
    readonly voice?: string | undefined
  }

  export interface Options {
    readonly models?: Models | undefined
    readonly defaults?: Defaults | undefined
    /** Default rate-limit retry budget for the idempotent calls (`chat` without `run`, `embed`).
     * Default 0 (off); a per-call `options.retries` overrides. */
    readonly retries?: number | undefined
  }

  /** The resolved client state the install exposes as the `Ai` context. */
  export interface Context {
    readonly provider: ProviderDef.Info
    readonly models: Models
    readonly defaults: Defaults
    readonly retries: number
  }

  /** A tool handler for the `run:` loop. Receives the JSON-parsed arguments object; the returned
   * value is serialized into the tool result message (strings pass through verbatim). */
  export type ToolRunner = (args: Record<string, unknown>) => Operation<unknown>

  export interface ChatOptions extends Helpers.Sampling {
    readonly model?: string | undefined
    readonly tools?: readonly Helpers.ToolSpec[] | undefined
    readonly toolChoice?: Helpers.ToolChoice | undefined
    readonly output?: Helpers.OutputSpec | undefined
    /** Raw provider-body escape hatch, merged last. */
    readonly extra?: Record<string, unknown> | undefined
    /** Rate-limit retries for this call. Overrides the install default. */
    readonly retries?: number | undefined
    /**
     * Tool handlers keyed by {@link Helpers.ToolSpec.name}. When given, `chat` becomes the tool
     * LOOP: the client JSON-parses each requested call's arguments (`ai.bad-response` on garbage),
     * invokes the handler, appends the assistant + tool messages, and re-asks — until a round
     * produces no tool calls or `maxRounds` is exhausted.
     */
    readonly run?: Readonly<Record<string, ToolRunner>> | undefined
    /** Round budget for the `run:` loop. Default 4; exceeding it fails `ai.request`. */
    readonly maxRounds?: number | undefined
  }

  /** `chat` options minus the loop/retry members (streams accumulate on the consumer side). */
  export type ChatStreamOptions = Omit<ChatOptions, 'run' | 'maxRounds' | 'retries'>

  export interface EmbedOptions {
    readonly model?: string | undefined
    readonly dimensions?: number | undefined
    readonly retries?: number | undefined
    readonly extra?: Record<string, unknown> | undefined
  }

  export interface SpeechOptions {
    readonly model?: string | undefined
    readonly voice?: string | undefined
    readonly format?: string | undefined
    readonly speed?: number | undefined
    readonly extra?: Record<string, unknown> | undefined
  }

  export interface TranscribeOptions {
    readonly model?: string | undefined
    readonly language?: string | undefined
    readonly prompt?: string | undefined
    readonly filename?: string | undefined
    readonly contentType?: string | undefined
    readonly extra?: Record<string, unknown> | undefined
  }

  /**
   * The app-facing surface. Each action resolves a portable spec (per-modality model, sampling
   * merge, message normalization, capability gating) and dispatches the matching `AiProvider`
   * action — `AiProvider.around({...})` is therefore the middleware/metrics seam for every call.
   */
  export interface Actions {
    chat(messages: Helpers.MessagesInit, options?: ChatOptions): Operation<Helpers.ChatResult>
    chatStream(
      messages: Helpers.MessagesInit,
      options?: ChatStreamOptions,
    ): Operation<Flow<Helpers.ChatDelta, Helpers.StreamClose>>
    embed(input: string | readonly string[], options?: EmbedOptions): Operation<Helpers.EmbedResult>
    tts(text: string, options?: SpeechOptions): Operation<Uint8Array>
    ttsStream(
      text: string,
      options?: SpeechOptions,
    ): Operation<Flow<Uint8Array, Helpers.StreamClose>>
    stt(audio: Uint8Array | Blob, options?: TranscribeOptions): Operation<string>
  }
}
