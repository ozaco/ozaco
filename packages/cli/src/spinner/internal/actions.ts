import type { SpinnerDef } from 'cli:core'
import { ansi, Palette, Terminal } from 'cli:core'
import type { Task } from 'std:effect'
import { ensure, operation, sleep, spawn, useContext } from 'std:effect'

import type { TreeNode, TreeRunnerOptions } from '../types'

import { barNode, clamp, renderTree, spinnerNode } from './tree'

const DEFAULT_INTERVAL = 80

const normalize = (options?: string | SpinnerDef.StartOptions): SpinnerDef.StartOptions =>
  typeof options === 'string' ? { message: options } : (options ?? {})

const normalizeBar = (options?: string | SpinnerDef.BarOptions): SpinnerDef.BarOptions =>
  typeof options === 'string' ? { message: options } : (options ?? {})

const setupTree = operation(function* (options: TreeRunnerOptions = {}) {
  const ctx = yield* useContext(Terminal)
  const palette = yield* useContext(Palette)
  const { columns } = yield* Terminal.actions.size()

  const interactive = ctx.interactive
  const intervalMs = options.interval ?? DEFAULT_INTERVAL

  const renderer = yield* Terminal.actions.renderer(columns)
  const state = { roots: [] as TreeNode[], frame: 0, stopped: false }

  let task: Task<void> | undefined

  if (interactive) {
    ctx.output.write(ansi.hideCursor)

    task = yield* spawn(function* () {
      while (!state.stopped) {
        yield* renderer.render(renderTree(state.roots, palette, state.frame))
        state.frame += 1
        yield* sleep(intervalMs)
      }
    })
  }

  const finish = operation(function* () {
    if (state.stopped) {
      return
    }
    state.stopped = true

    if (task) {
      yield* task.halt()
    }

    yield* renderer.done(renderTree(state.roots, palette, state.frame))

    if (interactive) {
      ctx.output.write(ansi.showCursor)
    }
  })

  yield* ensure(function* () {
    yield* finish()
  })

  return { state, finish }
})

const makeBarHandle = (node: TreeNode): SpinnerDef.BarHandle => ({
  update: operation(function* (value: number) {
    node.value = clamp(node, value)
  }),
  advance: operation(function* (delta?: number) {
    node.value = clamp(node, node.value + (delta ?? 1))
  }),
  succeed: operation(function* (message?: string) {
    node.status = 'success'
    node.value = node.total
    node.message = message ?? node.message
  }),
  fail: operation(function* (message?: string) {
    node.status = 'fail'
    node.message = message ?? node.message
  }),
  stop: operation(function* (message?: string) {
    node.status = 'success'
    node.message = message ?? node.message
  }),
})

const makeTaskHandle = (node: TreeNode): SpinnerDef.TaskHandle => ({
  update: operation(function* (message: string) {
    node.message = message
  }),
  succeed: operation(function* (message?: string) {
    node.status = 'success'
    node.message = message ?? node.message
  }),
  fail: operation(function* (message?: string) {
    node.status = 'fail'
    node.message = message ?? node.message
  }),
  warn: operation(function* (message?: string) {
    node.status = 'warn'
    node.message = message ?? node.message
  }),
  info: operation(function* (message?: string) {
    node.status = 'info'
    node.message = message ?? node.message
  }),
  task: operation(function* (message: string) {
    const child = spinnerNode(message)
    node.children.push(child)
    return makeTaskHandle(child)
  }),
  bar: operation(function* (message: string, options?: SpinnerDef.NodeBarOptions) {
    const child = barNode(message, options ?? {})
    node.children.push(child)
    return makeBarHandle(child)
  }),
})

export const start = operation(function* (options?: string | SpinnerDef.StartOptions) {
  const opts = normalize(options)
  const ctx = yield* useContext(Terminal)
  const palette = yield* useContext(Palette)
  const { columns } = yield* Terminal.actions.size()

  const interactive = ctx.interactive
  const frames = opts.frames ?? palette.symbols.spinner
  const intervalMs = opts.interval ?? DEFAULT_INTERVAL
  const color = opts.color ?? palette.colors.primary

  const renderer = yield* Terminal.actions.renderer(columns)
  const state = { message: opts.message ?? '', stopped: false }

  let task: Task<void> | undefined

  if (interactive) {
    ctx.output.write(ansi.hideCursor)

    task = yield* spawn(function* () {
      let index = 0

      while (!state.stopped) {
        const frame = frames[index % frames.length] ?? ''
        yield* renderer.render(`${color(frame)} ${state.message}`)
        index += 1
        yield* sleep(intervalMs)
      }
    })
  }

  const stopWith = operation(function* (line: string | null) {
    if (state.stopped) {
      return
    }
    state.stopped = true

    if (task) {
      yield* task.halt()
    }

    // oxlint-disable-next-line unicorn/prefer-ternary
    if (line === null) {
      yield* renderer.clear()
    } else {
      yield* renderer.done(line)
    }

    if (interactive) {
      ctx.output.write(ansi.showCursor)
    }
  })

  yield* ensure(function* () {
    yield* stopWith(null)
  })

  const lead = (symbol: string, paint: (text: string) => string) => (message?: string) =>
    stopWith(`${paint(symbol)} ${message ?? state.message}`)

  const handle: SpinnerDef.Handle = {
    update: operation(function* (message: string) {
      state.message = message
    }),
    succeed: lead(palette.symbols.answered, palette.colors.success),
    fail: lead(palette.symbols.error, palette.colors.error),
    warn: lead(palette.symbols.warning, palette.colors.warning),
    info: lead(palette.symbols.info, palette.colors.info),
    stop: (message?: string) => stopWith(message === undefined ? null : message),
  }

  return handle
})

export const group = operation(function* (options?: SpinnerDef.GroupOptions) {
  const runner = yield* setupTree(options ?? {})

  const handle: SpinnerDef.GroupHandle = {
    task: operation(function* (message: string) {
      const node = spinnerNode(message)
      runner.state.roots.push(node)
      return makeTaskHandle(node)
    }),
    bar: operation(function* (message: string, barOptions?: SpinnerDef.NodeBarOptions) {
      const node = barNode(message, barOptions ?? {})
      runner.state.roots.push(node)
      return makeBarHandle(node)
    }),
    stop: runner.finish,
  }

  return handle
})

export const bar = operation(function* (options?: string | SpinnerDef.BarOptions) {
  const opts = normalizeBar(options)
  const runner = yield* setupTree({ frames: opts.frames, interval: opts.interval })
  const node = barNode(opts.message ?? '', { total: opts.total, width: opts.width })
  runner.state.roots.push(node)

  const handle: SpinnerDef.BarHandle = {
    update: operation(function* (value: number) {
      node.value = clamp(node, value)
    }),
    advance: operation(function* (delta?: number) {
      node.value = clamp(node, node.value + (delta ?? 1))
    }),
    succeed: operation(function* (message?: string) {
      node.status = 'success'
      node.value = node.total
      node.message = message ?? node.message
      yield* runner.finish()
    }),
    fail: operation(function* (message?: string) {
      node.status = 'fail'
      node.message = message ?? node.message
      yield* runner.finish()
    }),
    stop: operation(function* (message?: string) {
      node.message = message ?? node.message
      yield* runner.finish()
    }),
  }

  return handle
})
