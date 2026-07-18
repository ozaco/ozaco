import { IO } from 'std:io'
import { LogLevel } from 'std:logger'
import { createTags } from 'std:shared'

export const TRANSPORT_REGEX = /server\/.+-transport@.+/gmu
export const BROKER_REGEX = /server\/broker@.+/gmu

export const STATUS_MAP: Record<string, number> = {
  'invalid-credentials': 401,
  'invalid-token': 401,
  'expired-token': 401,
  'revoked-token': 401,
  'missing-token': 401,
  'unknown-provider': 400,
  'invalid-duration': 400,

  // @ozaco/ai provider failures bubble up as `ai.*` tags — map them to upstream-style statuses
  'ai.auth': 502,
  'ai.rate-limit': 429,
  'ai.request': 502,
  'ai.bad-response': 502,
  'ai.unsupported': 400,
  'upload.no-file': 400,
}

export const ENV = IO.actions.env(data => ({
  port: +(data.PORT ?? data.port ?? 0) || 3000,
  host: data.HOST ?? data.host ?? '0.0.0.0',
  service: data.SERVICE ?? data.service ?? null,

  level: (LogLevel[(data.LEVEL || data.level) as unknown as LogLevel] ?? LogLevel.info) as LogLevel,

  // AI provider config — set OPENAI_API_KEY to enable the /ai/* routes. baseURL/model are optional
  // (any OpenAI-compatible server works via AI_BASE_URL; AI_MODEL overrides the per-call default).
  aiApiKey: data.OPENAI_API_KEY ?? data.AI_API_KEY ?? '',
  aiBaseURL: data.AI_BASE_URL ?? data.OPENAI_BASE_URL ?? '',
  aiModel: data.AI_MODEL ?? data.OPENAI_MODEL ?? '',
}))

export const AppErrors = createTags(
  'app:backend',

  'cleanup',
)
