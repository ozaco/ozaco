import { createTags } from 'std:shared'

export const ConfigErrors = createTags(
  'std:config',

  'missing-extends',
  /** the plugin cannot be built as asked: the codec is not installed / declares no `ext`, … */
  'configuration',
)
