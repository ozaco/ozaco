import { createTags } from 'std:shared'

export const PluginErrors = createTags(
  'std:plugin',

  'missing-action',
  'not-connected',
  'protocol-not-cloneable',
)
