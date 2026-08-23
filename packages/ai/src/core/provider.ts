import type { Operation } from 'std:effect'
import { defineProtocol } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { AiErrors } from './errors'
import type { ProviderDef } from './types/provider'

/** A failing action for a capability the provider does not implement. */
const unsupported = (subject: string, action: string): AnyType =>
  function* () {
    return yield* fail(AiErrors.Unsupported, `${subject} does not support ${action}`)
  } as AnyType

const gated = (subject: string): ProviderDef.Actions => ({
  chat: unsupported(subject, 'chat'),
  chatStream: unsupported(subject, 'chatStream'),
  embed: unsupported(subject, 'embed'),
  tts: unsupported(subject, 'tts'),
  ttsStream: unsupported(subject, 'ttsStream'),
  stt: unsupported(subject, 'stt'),
})

/**
 * The model-provider binding protocol. Each backend lives in its own module
 * (`ai:impl/{openai,mock,…}`). A provider receives PORTABLE, provider-neutral specs (never wire
 * shapes), owns all request/response en/decoding, and classifies backend errors into `AiErrors`
 * tags. Not cloneable — one provider per scope; install a provider, then `AiClient`. Every action
 * is capability-gated with a failing (`ai.unsupported`) protocol default, so an impl only
 * implements what its backend supports.
 *
 * Middleware belongs here: `AiProvider.around({ chat: … })` wraps every resolved spec the `Ai`
 * client dispatches — the metrics/caching/redaction seam.
 */
export const AiProvider = defineProtocol<ProviderDef.Info, ProviderDef.Actions>({
  name: 'ai-provider',
  version: '0.1.0',
  description: 'Structured AI provider: portable specs in, normalized results out',
  defaults: gated('the installed ai provider') as Partial<ProviderDef.Actions>,
})

/** Resolve the installed provider's info (`{ provider, capabilities }`); install a provider
 * first. */
export const useProvider = (): Operation<ProviderDef.Info> => AiProvider.context.expect()

/**
 * Typed failing fallbacks for every capability-gated action — spread these into `build({...})` and
 * override only what the backend actually supports:
 * `AiProvider.implement({...}).build({ ...providerDefaults('x'), chat, … })`.
 */
export const providerDefaults = (provider: string): ProviderDef.Actions =>
  gated(`the "${provider}" ai provider`)
