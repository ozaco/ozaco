import type { Future } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { Request } from 'server:service'

export type RestTransformerContext = EmptyType

export interface RestTransformerActions extends Record<string, AnyType> {
  parse: (req: unknown, res: unknown) => Future<Request, unknown>
}
