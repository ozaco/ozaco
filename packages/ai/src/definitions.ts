import { defineProtocol } from 'std:plugin'

import { AI_SUBTYPE } from './const'
import type { AiDef } from './types'

/**
 * The AI protocol: an OpenAI-compatible client surface. Install an implementation (e.g.
 * `OpenAICompatible`) with provider config to populate the context, then drive it through
 * `AI.actions.*` (chat / chatStream / embed / tts / stt). Mirrors the `Logger`/`Codec` protocol
 * shape — all actions are effect-native (`operation` returning `Future`) and surface failures as
 * `Result` via the `ai.*` error tags.
 */
export const AI = defineProtocol<AiDef.Context, [config: AiDef.Config], AiDef.Actions>({
  name: 'ozaco/ai',
  version: '0.0.1',
  subtype: AI_SUBTYPE,
})
