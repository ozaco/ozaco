import { Terminal } from 'cli:core'

import pkg from '../../../package.json'
import { terminalActions } from '../shared/actions'
import type { Driver } from '../shared/types'

import { openScreen } from './internal'
import type { MemoryTerminalDef } from './types/memory'

/** every screen handed out, with the binding that reads it. */
const bindings = new WeakMap<MemoryTerminalDef.Screen, Driver.Binding>()

const open = (options: MemoryTerminalDef.ScreenOptions): MemoryTerminalDef.Screen => {
  const { screen, handle, capabilities } = openScreen(options)
  bindings.set(screen, { terminal: 'memory', capabilities, handle })

  return screen
}

/**
 * A fake screen to drive a terminal from a test: type into it, read what came out.
 *
 * ```ts
 * const screen = createMemoryScreen()
 * yield* MemoryTerminal.use({ screen })
 * screen.press('down', 'enter')
 * expect(screen.plain()).toContain('…')
 * ```
 *
 * The control surface is the option, not the plugin — the same shape `createMemoryLink` has in
 * `@ozaco/transport`, so the install stays a plain install.
 */
export const createMemoryScreen = (
  options: MemoryTerminalDef.ScreenOptions = {},
): MemoryTerminalDef.Screen => open(options)

/** An in-memory terminal: no tty, no platform, every capability settable. What the rest of the
 * cli is exercised through. */
export const MemoryTerminal = Terminal.implement<
  Driver.Binding,
  [options?: MemoryTerminalDef.Options]
>({
  name: 'cli-memory-terminal',
  version: pkg.version,
  description: 'in-memory terminal for tests',

  *setup(options?: MemoryTerminalDef.Options) {
    const screen = options?.screen ?? open({})

    return bindings.get(screen)!
  },
}).build(terminalActions())
