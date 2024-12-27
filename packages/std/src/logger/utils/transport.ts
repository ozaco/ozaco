import { capsule } from '../../results'
import type { Fn } from '../../shared'

import { loggerTags } from '../tag'

export const createTransport = (
  cb: Fn<[Std.Logger.Message], void>,
  ...additionalCauses: Std.ErrorValues[]
) => {
  return capsule(cb, loggerTags.get('transport'), ...additionalCauses) as Std.Logger.Transport
}
