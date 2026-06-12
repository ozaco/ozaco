import type { EventEmitter } from './types'

export const removeFrom = (list: EventEmitter.Listener[], fn: EventEmitter.Listener): void => {
  const i = list.indexOf(fn)
  if (i !== -1) {
    list.splice(i, 1)
  }
}

export const callListener = (fn: EventEmitter.Listener, args: unknown[]): unknown => {
  switch (args.length) {
    case 0: {
      return fn()
    }
    case 1: {
      return fn(args[0])
    }
    case 2: {
      return fn(args[0], args[1])
    }

    case 3: {
      return fn(args[0], args[1], args[2])
    }

    default: {
      return fn(...args)
    }
  }
}
