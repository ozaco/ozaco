import type { AiDef } from 'ai:core'
import { AI } from 'ai:core'
import { defineAction, defineService, Gateway, useResponse } from 'server:core'

import { AccessRefreshAuth, useAuth } from 'server:plugin/auth'
import { z } from 'zod'

/** Map a requested TTS output format to the response Content-Type. */
const TTS_CONTENT_TYPE: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

/**
 * A tiny AI service wired onto the same broker + gateway as everything else. It talks to any
 * OpenAI-compatible provider through `@ozaco/ai`'s `AI` protocol — the concrete client
 * (`OpenAICompatible`) and its API key are installed once in `index.ts`, so these actions just
 * `yield* AI.actions.*` and let the broker scope hand them the provider context.
 *
 * Every action authenticates the Bearer access token via `useAuth`, so the AI surface sits behind
 * the same login as `/todos` — any signed-in seed user can call it. Provider-side failures (a bad
 * key, a rate limit, an unparseable response) surface as `ai.*` Result failures and are mapped to
 * HTTP statuses by the status map in `index.ts`. `/ai/tts` streams the synthesized audio straight to
 * the response body as the provider generates it (see `AI.actions.ttsStream` + the gateway sink).
 *
 * Only mounted when `OPENAI_API_KEY` is present in the environment (see `index.ts`); without a key
 * the rest of the app still boots normally.
 */
export const AiService = defineService({
  name: 'ai',
  version: '0.0.0',

  actions: {
    chat: defineAction(
      {
        title: 'Chat completion',
        description: 'Send a prompt (with an optional system message) and get a single completion.',
        input: z.object({
          prompt: z.string().min(1),
          system: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
          temperature: z.number().min(0).max(2).optional(),
          maxTokens: z.number().int().positive().optional(),
        }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/chat' })],
      },
      function* (body) {
        // gate the AI surface behind the same Bearer login as /todos (any signed-in user)
        yield* useAuth(AccessRefreshAuth)

        const messages: AiDef.Message[] = []
        if (body.system !== undefined) {
          messages.push({ role: 'system', content: body.system })
        }
        messages.push({ role: 'user', content: body.prompt })

        const options: AiDef.ChatOptions = {}
        if (body.model !== undefined) {
          options.model = body.model
        }
        if (body.temperature !== undefined) {
          options.temperature = body.temperature
        }
        if (body.maxTokens !== undefined) {
          options.maxTokens = body.maxTokens
        }

        const result = yield* AI.actions.chat(messages, options)

        return {
          text: result.text,
          model: result.model,
          finishReason: result.finishReason,
          usage: result.usage,
        }
      },
    ),

    tts: defineAction(
      {
        title: 'Text to speech',
        description: 'Synthesize speech and stream the audio back as the provider generates it.',
        input: z.object({
          text: z.string().min(1),
          model: z.string().min(1).optional(),
          voice: z.string().min(1).optional(),
          format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
          speed: z.number().min(0.25).max(4).optional(),
          octet: z.boolean().optional(),
        }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/tts' })],
      },
      function* (body) {
        const options: AiDef.TtsOptions = {}
        if (body.model !== undefined) {
          options.model = body.model
        }
        if (body.voice !== undefined) {
          options.voice = body.voice
        }
        if (body.format !== undefined) {
          options.format = body.format
        }
        if (body.speed !== undefined) {
          options.speed = body.speed
        }

        // Set the Content-Type BEFORE returning the stream: the gateway reads it off the response
        // envelope to build the streaming Response's headers. The audio is pumped to the client as
        // `ttsStream` yields it (the gateway keeps this action's scope alive until the body drains),
        // so headers must be known by the time we hand back the stream.
        const res = yield* useResponse()
        res.meta['Content-Type'] =
          (body.octet ? 'application/octet-stream' : TTS_CONTENT_TYPE[body.format ?? 'mp3']) ??
          'application/octet-stream'

        return yield* AI.actions.ttsStream(body.text, options)
      },
    ),

    embed: defineAction(
      {
        title: 'Embeddings',
        description: 'Turn one string or a batch of strings into embedding vectors.',
        input: z.object({
          input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
          model: z.string().min(1).optional(),
        }),
        settings: [Gateway.actions.rest({ method: 'POST', path: '/embed' })],
      },
      function* (body) {
        yield* useAuth(AccessRefreshAuth)

        const options: AiDef.EmbedOptions = {}
        if (body.model !== undefined) {
          options.model = body.model
        }

        const vectors = yield* AI.actions.embed(body.input, options)

        return {
          count: vectors.length,
          dimensions: vectors[0]?.length ?? 0,
          vectors,
        }
      },
    ),
  },

  *setup() {},
})
