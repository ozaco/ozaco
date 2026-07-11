import type { Future, Stream } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { AiErrors } from './errors'

export type AiDef = Plugin<AiDef.Context, [config: AiDef.Config], AiDef.Actions>

export namespace AiDef {
  /** An `ai.*` tag for a mapped non-2xx, plus whatever `std:fetch` surfaces raw (it no longer re-tags
   * thrown errors — `FetchDef.Error` is `unknown`), so this widens to `unknown`. The `ai.*` tags are
   * still produced at runtime by `failStatus`/`statusTag`; match them by value. */
  export type Error = (typeof AiErrors)[keyof typeof AiErrors] | FetchDef.Error

  /** Install-time configuration for an OpenAI-compatible provider. */
  export interface Config {
    /** API key sent as `Authorization: Bearer <apiKey>`. */
    apiKey: string
    /** Base URL of the OpenAI-compatible API. Defaults to `https://api.openai.com/v1`. */
    baseURL?: string
    /** Default model used for chat completions when a call omits `model`. */
    model?: string
    /** Extra headers merged into every request. */
    headers?: Record<string, string>
  }

  /** Resolved provider context, stored after install. */
  export interface Context {
    apiKey: string
    baseURL: string
    model: string | undefined
    headers: Record<string, string>
  }

  export type Role = 'system' | 'user' | 'assistant' | 'tool'

  /** A function the model may call. `parameters` is a JSON Schema describing the arguments. */
  export interface Tool {
    type: 'function'
    function: {
      name: string
      description?: string
      parameters?: Record<string, unknown>
    }
  }

  /** A tool invocation requested by the model. `arguments` is the raw JSON string it emitted. */
  export interface ToolCall {
    id: string
    name: string
    arguments: string
  }

  /** How the model should pick tools: a strategy, or a forced `{ name }`. */
  export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

  /**
   * Structured-output request. `text` is the default free-form mode; `json_object` asks the model to
   * emit syntactically valid JSON; `json_schema` constrains it to a named JSON Schema (set
   * `strict: true` for guaranteed-conformant output where the provider supports it).
   */
  export type ResponseFormat =
    | { type: 'text' }
    | { type: 'json_object' }
    | {
        type: 'json_schema'
        jsonSchema: { name: string; schema: Record<string, unknown>; strict?: boolean }
      }

  export interface Message {
    role: Role
    content: string
    /** Optional name (e.g. the tool name for `role: 'tool'`). */
    name?: string
    /** Tool calls the assistant requested (set on `role: 'assistant'` messages). */
    toolCalls?: ToolCall[]
    /** The `ToolCall.id` this message answers (set on `role: 'tool'` result messages). */
    toolCallId?: string
  }

  /** Per-call chat options forwarded to `/chat/completions`. */
  export interface ChatOptions {
    model?: string
    temperature?: number
    topP?: number
    maxTokens?: number
    stop?: string | string[]
    frequencyPenalty?: number
    presencePenalty?: number
    seed?: number
    /** Tools (functions) the model may call. */
    tools?: Tool[]
    /** How the model should pick tools. */
    toolChoice?: ToolChoice
    /** Constrain the model's output (free text, a JSON object, or a named JSON Schema). */
    responseFormat?: ResponseFormat
    /** Arbitrary extra body fields merged last (escape hatch for provider-specific params). */
    extra?: Record<string, unknown>
  }

  export interface ChatResult {
    /** The full assistant message returned by the provider. */
    message: Message
    /** Convenience alias for `message.content`. */
    text: string
    model: string
    finishReason: string | undefined
    usage: Usage | undefined
    /** Tool calls the model requested, or `undefined` when none. */
    toolCalls: ToolCall[] | undefined
  }

  export interface Usage {
    promptTokens: number | undefined
    completionTokens: number | undefined
    totalTokens: number | undefined
  }

  /**
   * One tool-call fragment within a streaming chat chunk. `arguments` is a PARTIAL JSON fragment — the
   * provider streams a tool call's arguments across many chunks. Accumulate fragments that share the
   * same `index` (and adopt the first non-empty `id`/`name`) to reconstruct the full tool call; that
   * stitching is the consumer's responsibility.
   */
  export interface ToolCallDelta {
    index: number
    id?: string
    name?: string
    /** Partial JSON fragment of the tool call's arguments — concatenate across chunks by `index`. */
    arguments?: string
  }

  /**
   * One streamed `/chat/completions` chunk: the incremental content `delta` (empty string when the
   * chunk carries no text), any `toolCalls` fragments, the terminal `finishReason`, and — on the final
   * usage chunk — `usage`. A single chunk may carry only one of these (e.g. the last chunk often has
   * just `usage`).
   */
  export interface ChatStreamChunk {
    delta: string
    toolCalls?: ToolCallDelta[]
    finishReason?: string
    usage?: Usage
  }

  export interface EmbedOptions {
    model?: string
    dimensions?: number
    extra?: Record<string, unknown>
  }

  export interface TtsOptions {
    model?: string
    voice?: string
    /** Output format, e.g. `mp3`, `wav`, `opus`. */
    format?: string
    speed?: number
    extra?: Record<string, unknown>
  }

  export interface SttOptions {
    model?: string
    /** ISO-639-1 language hint. */
    language?: string
    prompt?: string
    /** File name reported to the provider for the multipart upload. */
    filename?: string
    /** MIME type of the audio blob. */
    contentType?: string
    extra?: Record<string, string>
  }

  /** Close value a token stream settles with: `true` on clean end, or a failure mid-stream. */
  export type StreamClose = true | Result.Failure<unknown>

  export interface Actions {
    /** POST `{baseURL}/chat/completions` (non-streaming). */
    chat(messages: Message[], options?: ChatOptions): Future<ChatResult>
    /**
     * POST `{baseURL}/chat/completions` with `stream: true`; yields one `ChatStreamChunk` per SSE
     * event. Each chunk carries the incremental text `delta`, any `toolCalls` fragments, the terminal
     * `finishReason`, and — on the final chunk (requested via `stream_options.include_usage`) —
     * `usage`. Tool-call `arguments` arrive as PARTIAL JSON fragments spread across chunks; the
     * CONSUMER must accumulate fragments sharing the same `index` to rebuild each tool call.
     */
    chatStream(
      messages: Message[],
      options?: ChatOptions,
    ): Future<Stream<ChatStreamChunk, StreamClose>>
    /** POST `{baseURL}/embeddings`; one vector per input. */
    embed(input: string | string[], options?: EmbedOptions): Future<number[][]>
    /** POST `{baseURL}/audio/speech`; returns the synthesized audio bytes. */
    tts(text: string, options?: TtsOptions): Future<Uint8Array>
    /**
     * POST `{baseURL}/audio/speech` (same body as `tts`); yields the synthesized audio as a byte
     * stream for low-latency playback rather than buffering the whole clip.
     */
    ttsStream(text: string, options?: TtsOptions): Future<Stream<Uint8Array, StreamClose>>
    /** POST `{baseURL}/audio/transcriptions` (multipart); returns the transcription text. */
    stt(audio: Uint8Array | Blob, options?: SttOptions): Future<string>
    /**
     * POST `{baseURL}/audio/transcriptions` (multipart, `stream: true`); the response is SSE and
     * yields transcript text deltas as they arrive. The audio input is still uploaded whole.
     */
    sttStream(audio: Uint8Array | Blob, options?: SttOptions): Future<Stream<string, StreamClose>>
  }
}
