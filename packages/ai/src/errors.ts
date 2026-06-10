import { createTags } from 'std:shared'

export const AiErrors = createTags(
  'ai',

  'request',
  'auth',
  'rate-limit',
  'bad-response',
  'unsupported',
)
