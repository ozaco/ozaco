import type { TerminalDef } from 'cli:core'
import { Terminal, useTerminal } from 'cli:core'
import type { PaletteDef } from 'cli:palette'
import { usePalette } from 'cli:palette'
import type { Operation, Task } from 'std:effect'
import { ensure, sleep, spawn } from 'std:effect'

import type { Helpers } from '../types/helpers'
import type { SpinnerDef } from '../types/spinner'

import { barNode, clamp, renderTree, spinnerNode } from './tree'

const DEFAULT_INTERVAL = 80

const normalize = (options?: string | SpinnerDef.StartOptions): SpinnerDef.StartOptions =>
  typeof options === 'string' ? { message: options } : (options ?? {})

const normalizeBar = (options?: string | SpinnerDef.BarOptions): SpinnerDef.BarOptions =>
  typeof options === 'string' ? { message: options } : (options ?? {})

/**
 * Shared runner for the tree renderers (`group`/`bar`): acquires the render lease, spawns the
 * animation loop while interactive, and commits the final tree on finish. All drawing goes through
 * the lease — no cursor codes are written here, so the cursor can never leak hidden.
 */
function* setupTree(intervalMs: number) {
  const info = yield* useTerminal()
  const palette = yield* usePalette()
  const interactive = info.capabilities.interactive

  const lease: TerminalDef.Renderer = yield* Terminal.actions.renderer()
  const state = { roots: [] as Helpers.TreeNode[], frame: 0, stopped: false }

  let task: Task<void> | undefined

  if (interactive) {
    task = yield* spawn(function* () {
      while (!state.stopped) {
        yield* lease.render(renderTree(state.roots, palette, state.frame))
        state.frame += 1
        yield* sleep(intervalMs)
      }
    })
  }

  const finish = function* () {
    if (state.stopped) {
      return
    }
    state.stopped = true

    if (task) {
      yield* task.halt()
    }

    // commit the final tree and release the lease
    yield* lease.done(renderTree(state.roots, palette, state.frame))
  }

  yield* ensure(function* () {
    yield* finish()
  })

  return { state, palette, finish }
}

const makeBarHandle = (
  node: Helpers.TreeNode,
  finish?: () => Operation<void>,
): SpinnerDef.BarHandle => ({
  *update(value: number) {
    node.value = clamp(node, value)
  },
  *advance(delta?: number) {
    node.value = clamp(node, node.value + (delta ?? 1))
  },
  *succeed(message?: string) {
    node.status = 'success'
    node.value = node.total
    node.message = message ?? node.message
    if (finish) {
      yield* finish()
    }
  },
  *fail(message?: string) {
    node.status = 'fail'
    node.message = message ?? node.message
    if (finish) {
      yield* finish()
    }
  },
  *stop(message?: string) {
    if (node.status === 'pending') {
      node.status = 'success'
    }
    node.message = message ?? node.message
    if (finish) {
      yield* finish()
    }
  },
})

const makeTaskHandle = (node: Helpers.TreeNode): SpinnerDef.TaskHandle => ({
  *update(message: string) {
    node.message = message
  },
  *succeed(message?: string) {
    node.status = 'success'
    node.message = message ?? node.message
  },
  *fail(message?: string) {
    node.status = 'fail'
    node.message = message ?? node.message
  },
  *warn(message?: string) {
    node.status = 'warn'
    node.message = message ?? node.message
  },
  *info(message?: string) {
    node.status = 'info'
    node.message = message ?? node.message
  },
  *task(message: string) {
    const child = spinnerNode(message)
    node.children.push(child)
    return makeTaskHandle(child)
  },
  *bar(message: string, options?: SpinnerDef.NodeBarOptions) {
    const child = barNode(message, options ?? {})
    node.children.push(child)
    return makeBarHandle(child)
  },
})

export function* start(options?: string | SpinnerDef.StartOptions) {
  const opts = normalize(options)
  const info = yield* useTerminal()
  const palette = yield* usePalette()

  const interactive = info.capabilities.interactive
  const frames = opts.frames ?? palette.symbols.spinner
  const intervalMs = opts.interval ?? DEFAULT_INTERVAL
  const color = opts.color ?? palette.colors.primary

  const lease: TerminalDef.Renderer = yield* Terminal.actions.renderer()
  const state = { message: opts.message ?? '', stopped: false }

  let task: Task<void> | undefined

  if (interactive) {
    task = yield* spawn(function* () {
      let index = 0

      while (!state.stopped) {
        const frame = frames[index % frames.length] ?? ''
        yield* lease.render(`${color(frame)} ${state.message}`)
        index += 1
        yield* sleep(intervalMs)
      }
    })
  }

  const stopWith = function* (line: string | null) {
    if (state.stopped) {
      return
    }
    state.stopped = true

    if (task) {
      yield* task.halt()
    }

    // `done` clears the live region itself; `null` releases without committing a line
    yield* lease.done(line ?? undefined)
  }

  yield* ensure(function* () {
    yield* stopWith(null)
  })

  const lead = (symbol: string, paint: PaletteDef.Style) => (message?: string) =>
    stopWith(`${paint(symbol)} ${message ?? state.message}`)

  const handle: SpinnerDef.Handle = {
    *update(message: string) {
      state.message = message
    },
    succeed: lead(palette.symbols.answered, palette.colors.success),
    fail: lead(palette.symbols.error, palette.colors.error),
    warn: lead(palette.symbols.warning, palette.colors.warning),
    info: lead(palette.symbols.info, palette.colors.info),
    stop: (message?: string) => stopWith(message === undefined ? null : message),
  }

  return handle
}

export function* group(options?: SpinnerDef.GroupOptions) {
  const runner = yield* setupTree(options?.interval ?? DEFAULT_INTERVAL)

  const handle: SpinnerDef.GroupHandle = {
    *task(message: string) {
      const node = spinnerNode(message)
      runner.state.roots.push(node)
      return makeTaskHandle(node)
    },
    *bar(message: string, barOptions?: SpinnerDef.NodeBarOptions) {
      const node = barNode(message, barOptions ?? {})
      runner.state.roots.push(node)
      return makeBarHandle(node)
    },
    stop: runner.finish,
  }

  return handle
}

export function* bar(options?: string | SpinnerDef.BarOptions) {
  const opts = normalizeBar(options)
  const runner = yield* setupTree(opts.interval ?? DEFAULT_INTERVAL)
  const node = barNode(opts.message ?? '', { total: opts.total, width: opts.width })
  runner.state.roots.push(node)

  return makeBarHandle(node, runner.finish)
}
