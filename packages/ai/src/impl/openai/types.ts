/** How the api key travels: the standard bearer header, or a custom header (e.g. `api-key`). */
export type OpenAIAuth =
  | { readonly kind: 'bearer' }
  | { readonly kind: 'header'; readonly name: string }

export interface OpenAIProviderOptions {
  readonly apiKey: string
  /** Base URL of the OpenAI-compatible API. Defaults to `DEFAULT_BASE_URL` from `./const`. */
  readonly baseUrl?: string | undefined
  /** Extra headers for every request. The COMPUTED auth header overrides these, never the
   * reverse — a stray user `authorization` cannot silently clobber the credentials. */
  readonly headers?: Record<string, string> | undefined
  /** Per-request deadline; a hit surfaces as `ai.timeout`. */
  readonly timeoutMs?: number | undefined
  /** Auth transport. Default `{ kind: 'bearer' }`. */
  readonly auth?: OpenAIAuth | undefined
}
