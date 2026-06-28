import { Terminal } from 'cli:core'
import { operation, useContext } from 'std:effect'

import {
  terminalDisplayWidth,
  terminalKeys,
  terminalRenderer,
  terminalSession,
  terminalWrite,
} from './shared/actions'
import { nodelikeSetup } from './shared/setup'
import { terminalSize } from './shared/size'

export const BunTerminal = Terminal.implement({
  name: 'cli/bun-terminal',
  version: '0.0.0',

  setup: nodelikeSetup,
}).build({
  isInteractive: operation(function* () {
    return (yield* useContext(Terminal)).interactive
  }),

  size: terminalSize,
  write: terminalWrite,
  keys: terminalKeys,
  session: terminalSession,
  displayWidth: terminalDisplayWidth,
  renderer: terminalRenderer,

  stripAnsi: operation(function* (text) {
    return Bun.stripANSI(text)
  }),
  wrapAnsi: operation(function* (text, columns, options) {
    return Bun.wrapAnsi(text, columns, options)
  }),
})
