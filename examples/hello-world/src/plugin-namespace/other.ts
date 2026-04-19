import { operation } from 'std:effect'
import { IO } from 'std:io'
import { definePlugin } from 'std:plugin'

export const Other = definePlugin({
  name: 'other',
  version: '0.0.0',
  *setup() {},
}).build({
  read: operation(function* (path: string) {
    return yield* IO.actions.readText(path)
  }, 'read'),
})
