import type { Result } from 'std:result'

export namespace Helpers {
  /** The conversation roles the portable message shape carries. */
  export type Role = 'system' | 'user' | 'assistant' | 'tool'

  /** One text content part. */
  export interface TextPart {
    readonly kind: 'text'
    readonly text: string
  }

  /** One typed content part of a message. Text-only today — the closed union is the extension
   * point for image/audio parts later, which is why messages carry `parts` instead of a bare
   * string. */
  export type MessagePart = TextPart

  /** A complete tool invocation the model requested. `arguments` is the raw JSON string it
   * emitted. */
  export interface ToolCall {
    readonly id: string
    readonly name: string
    readonly arguments: string
  }

  /** The normalized, provider-neutral message shape every {@link ChatSpec} carries. */
  export interface Message {
    readonly role: Role
    readonly parts: readonly MessagePart[]
    /** Optional name (the tool name on `role: 'tool'` result messages). */
    readonly name?: string | undefined
    /** Tool calls the assistant requested (`role: 'assistant'` messages). */
    readonly toolCalls?: readonly ToolCall[] | undefined
    /** The {@link ToolCall.id} this message answers (`role: 'tool'` result messages). */
    readonly toolCallId?: string | undefined
  }

  /** Message sugar the client accepts: `content` may be a plain string instead of parts. */
  export interface MessageInit {
    readonly role: Role
    readonly content: string | readonly MessagePart[]
    readonly name?: string | undefined
    readonly toolCalls?: readonly ToolCall[] | undefined
    readonly toolCallId?: string | undefined
  }

  /** Anything the client normalizes into one {@link Message}; a bare string becomes a user
   * message. */
  export type MessageLike = string | Message | MessageInit

  /** The client's message input: one prompt string, or a list of {@link MessageLike}s. */
  export type MessagesInit = string | readonly MessageLike[]

  /** A function the model may call, in the NEUTRAL shape (`schema` is a JSON Schema for the
   * arguments object). Providers convert this to their own wire form — never the reverse. */
  export interface ToolSpec {
    readonly name: string
    readonly description?: string | undefined
    readonly schema?: Record<string, unknown> | undefined
  }

  /** How the model should pick tools: a strategy, or a forced `{ name }`. */
  export type ToolChoice = 'auto' | 'none' | 'required' | { readonly name: string }

  /** Output constraint: free text, syntactically-valid JSON, or a JSON-Schema-constrained
   * object. */
  export type OutputSpec =
    | 'text'
    | 'json'
    | {
        readonly schema: Record<string, unknown>
        readonly name?: string | undefined
        readonly strict?: boolean | undefined
      }

  /** The portable sampling knobs. Every field optional; providers drop what they can't map. */
  export interface Sampling {
    readonly temperature?: number | undefined
    readonly topP?: number | undefined
    readonly maxTokens?: number | undefined
    readonly stop?: readonly string[] | undefined
    readonly seed?: number | undefined
    readonly frequencyPenalty?: number | undefined
    readonly presencePenalty?: number | undefined
  }

  /** A fully-resolved chat request: what the client hands the provider. Portable — no provider
   * wire shapes; `extra` is the raw escape hatch merged into the provider request body last. */
  export interface ChatSpec {
    readonly model: string
    readonly messages: readonly Message[]
    readonly tools: readonly ToolSpec[]
    readonly toolChoice: ToolChoice
    readonly output: OutputSpec
    readonly sampling: Sampling
    readonly extra?: Record<string, unknown> | undefined
  }

  /** A fully-resolved embedding request — always a batch (`input` is one vector per entry). */
  export interface EmbedSpec {
    readonly model: string
    readonly input: readonly string[]
    readonly dimensions?: number | undefined
    readonly extra?: Record<string, unknown> | undefined
  }

  /** A fully-resolved speech-synthesis request. */
  export interface SpeechSpec {
    readonly model: string
    readonly voice: string
    readonly text: string
    /** Output container, e.g. `mp3`, `wav`, `opus`. */
    readonly format?: string | undefined
    readonly speed?: number | undefined
    readonly extra?: Record<string, unknown> | undefined
  }

  /** A fully-resolved transcription request. */
  export interface TranscribeSpec {
    readonly model: string
    readonly audio: Uint8Array | Blob
    /** ISO-639-1 language hint. */
    readonly language?: string | undefined
    readonly prompt?: string | undefined
    /** File name reported for the multipart upload. */
    readonly filename?: string | undefined
    /** MIME type of the audio payload. */
    readonly contentType?: string | undefined
    readonly extra?: Record<string, unknown> | undefined
  }

  /** Normalized token accounting, when the provider reports it. */
  export interface Usage {
    readonly promptTokens?: number | undefined
    readonly completionTokens?: number | undefined
    readonly totalTokens?: number | undefined
  }

  /** A normalized chat completion. `message` is the full assistant message (append it back to the
   * conversation for tool round-trips); `text` and `toolCalls` are its flattened conveniences. */
  export interface ChatResult {
    readonly message: Message
    readonly text: string
    readonly toolCalls: readonly ToolCall[]
    readonly finishReason: string | undefined
    readonly usage: Usage | undefined
    readonly model: string
  }

  /**
   * One tool-call fragment within a streamed {@link ChatDelta}. `arguments` is a PARTIAL JSON
   * fragment spread across many deltas — stitch fragments sharing the same `index` back together
   * (adopting the first non-empty `id`/`name`) with `accumulateToolCalls`.
   */
  export interface ToolCallDelta {
    readonly index: number
    readonly id?: string | undefined
    readonly name?: string | undefined
    readonly arguments?: string | undefined
  }

  /** One streamed chat increment. A single delta may carry any subset of its fields (the final
   * usage-only delta is common); absent fields mean "nothing new", never "reset". */
  export interface ChatDelta {
    readonly text?: string | undefined
    readonly toolCalls?: readonly ToolCallDelta[] | undefined
    readonly finishReason?: string | undefined
    readonly usage?: Usage | undefined
  }

  /** Stitches streamed tool-call fragments back into complete calls. Feed it every
   * {@link ChatDelta.toolCalls} you receive, then `collect()` once the stream closes. */
  export interface ToolCallAccumulator {
    /** Fold one delta's fragments in (a no-op for `undefined`, so `add(delta.toolCalls)` is
     * safe). */
    add(fragments: readonly ToolCallDelta[] | undefined): void
    /** The completed calls so far, ordered by stream index. */
    collect(): readonly ToolCall[]
  }

  /** A normalized embedding response — one vector per {@link EmbedSpec.input} entry, in order. */
  export interface EmbedResult {
    readonly vectors: readonly (readonly number[])[]
    readonly model: string
    readonly usage: Usage | undefined
  }

  /** The close value every ai stream settles with: `true` on a clean end, or the Failure that
   * truncated it mid-flight (mid-stream provider error frames close this way). */
  export type StreamClose = true | Result.Failure<unknown>
}
