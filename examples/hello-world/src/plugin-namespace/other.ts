import type { Future } from 'std:effect'
import { operation } from 'std:effect'
import { definePlugin } from 'std:plugin'

import { IO } from './definition'

export const Other = definePlugin({
  name: 'other',
  version: '0.0.0',
  *setup() {},
}).build({
  read: operation(function* (path: string) {
    return yield* IO.actions.readFile(path)
  }, 'read') as (path: string) => Future<string, 'io:error' | 'not-implemented'>,
})
