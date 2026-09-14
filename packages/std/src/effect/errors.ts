import { createTags } from 'std:shared'

export const EffectErrors = createTags(
  'std:effect',

  'halted',
  'iteration-error',
  'missing-context',
  'no-scope-handler',
  'using',
)

/** The cause names effect stamps on its own primitives. */
export const EffectCauses = createTags('std:effect', 'until', 'suspend')
