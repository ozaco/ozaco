export const AI_SUBTYPE = Symbol.for('ozaco:ai')

/** Default OpenAI-compatible base URL. Override with any OpenAI-compatible server (incl. local). */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Default model used when neither install config nor a per-call option provides one. */
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini'
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'
export const DEFAULT_TTS_MODEL = 'tts-1'
export const DEFAULT_TTS_VOICE = 'alloy'
export const DEFAULT_STT_MODEL = 'whisper-1'

/** The SSE sentinel a chat stream emits to signal the end of the token stream. */
export const SSE_DONE = '[DONE]'
