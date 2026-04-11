import type { Future } from 'std:effect'
import { definePlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

export type IOActions = {
  readFile: (path: string) => Future<string, 'io:error'>
  writeFile: (path: string, content: string) => Future<void, 'io:error'>
}

export const IO = definePlugin<AnyType, AnyType, IOActions>({
  name: 'io',
  version: '0.0.0',
  namespace: true,
})
