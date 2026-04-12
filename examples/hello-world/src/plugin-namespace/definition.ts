import type { Future } from 'std:effect'
import { defineNamespace } from 'std:plugin'
import type { AnyType } from 'std:shared'

export type IOActions = {
  readFile: (path: string) => Future<string, 'io:error'>
  writeFile: (path: string, content: string) => Future<void, 'io:error'>
}

export const IO = defineNamespace<AnyType, AnyType, IOActions>({
  name: 'io',
  version: '0.0.0',
})
