import { createTags } from 'std:shared'

/** The causes crud appends to the `server.not-found` its ops raise: which op missed the row (an
 * out-of-scope row is a miss too). */
export const CrudCauses = createTags(
  'server:crud',

  'get',
  'update',
  'replace',
  'remove',
)
