import { createEvent, isEventEmitter } from 'std:event'

import { describe, expect, it } from 'bun:test'

type Events = {
  zero: []
  one: [string]
  two: [string, number]
  three: [number, number, number]
  many: [number, number, number, number, number]
}

describe('createEvent + isEventEmitter', () => {
  it('tags emitters with the shared std:event symbol', () => {
    const emitter = createEvent()

    expect(isEventEmitter(emitter)).toBe(true)
    expect(isEventEmitter({})).toBe(false)
    expect(isEventEmitter(null)).toBe(false)
    expect(isEventEmitter(42)).toBe(false)
    // duck typing is keyed on the registered symbol, not the instance
    expect(isEventEmitter({ _t: Symbol.for('std:event') })).toBe(true)
    expect(isEventEmitter({ _t: Symbol('std:event') })).toBe(false)
  })
})

describe('on / emit', () => {
  it('delivers payloads of every arity (covers each callListener arm)', () => {
    const emitter = createEvent<Events>()
    const seen: unknown[][] = []

    const record = (...args: unknown[]) => {
      seen.push(args)
    }

    emitter.on('zero', record)
    emitter.on('one', record)
    emitter.on('two', record)
    emitter.on('three', record)
    emitter.on('many', record)

    emitter.emit('zero')
    emitter.emit('one', 'a')
    emitter.emit('two', 'b', 2)
    emitter.emit('three', 1, 2, 3)
    emitter.emit('many', 1, 2, 3, 4, 5)

    expect(seen).toEqual([[], ['a'], ['b', 2], [1, 2, 3], [1, 2, 3, 4, 5]])
  })

  it('calls multiple listeners in registration order with the same payload', () => {
    const emitter = createEvent<{ msg: [string] }>()
    const calls: string[] = []

    emitter.on('msg', text => {
      calls.push(`first:${text}`)
    })
    emitter.on('msg', text => {
      calls.push(`second:${text}`)
    })
    emitter.on('msg', text => {
      calls.push(`third:${text}`)
    })

    emitter.emit('msg', 'x')

    expect(calls).toEqual(['first:x', 'second:x', 'third:x'])
    expect(emitter.listenerCount('msg')).toBe(3)
  })

  it('emitting a name nobody listens to is a safe no-op', () => {
    const emitter = createEvent<{ ghost: [number] }>()

    expect(() => emitter.emit('ghost', 1)).not.toThrow()
    expect(emitter.listenerCount('ghost')).toBe(0)
  })

  it('the disposer returned by on removes exactly that listener and is idempotent', () => {
    const emitter = createEvent<{ tick: [] }>()
    const calls: string[] = []

    const dispose = emitter.on('tick', () => {
      calls.push('a')
    })
    emitter.on('tick', () => {
      calls.push('b')
    })

    dispose()
    dispose()
    emitter.emit('tick')

    expect(calls).toEqual(['b'])
    expect(emitter.listenerCount('tick')).toBe(1)
  })

  it('an emit dispatches to a snapshot: removals inside a listener do not skip peers', () => {
    const emitter = createEvent<{ tick: [] }>()
    const calls: string[] = []

    let disposeSecond = () => {}
    emitter.on('tick', () => {
      calls.push('first')
      disposeSecond()
    })
    disposeSecond = emitter.on('tick', () => {
      calls.push('second')
    })

    emitter.emit('tick')
    emitter.emit('tick')

    expect(calls).toEqual(['first', 'second', 'first'])
  })

  it('listeners added during an emit are not called for that emit', () => {
    const emitter = createEvent<{ tick: [] }>()
    const calls: string[] = []

    emitter.on('tick', () => {
      calls.push('outer')
      emitter.on('tick', () => {
        calls.push('inner')
      })
    })

    emitter.emit('tick')

    expect(calls).toEqual(['outer'])
    expect(emitter.listenerCount('tick')).toBe(2)
  })

  it('disposers made before off(name) do not touch listeners registered afterwards', () => {
    const emitter = createEvent<{ tick: [] }>()
    let calls = 0

    const dispose = emitter.on('tick', () => {
      calls += 1
    })
    emitter.off('tick') // wipes the name, orphaning the old list
    emitter.on('tick', () => {
      calls += 10
    })

    dispose() // must only affect its own (orphaned) registration
    emitter.emit('tick')

    expect(calls).toBe(10)
  })
})

describe('once', () => {
  it('fires exactly once and unregisters itself', () => {
    const emitter = createEvent<{ ping: [string] }>()
    const calls: string[] = []

    emitter.once('ping', text => {
      calls.push(text)
    })

    emitter.emit('ping', 'a')
    expect(emitter.listenerCount('ping')).toBe(0)

    emitter.emit('ping', 'b')
    expect(calls).toEqual(['a'])
  })

  it('unregisters before invoking, so the listener can re-arm itself', () => {
    const emitter = createEvent<{ tick: [] }>()
    let calls = 0

    const rearm = () => {
      calls += 1
      if (calls < 2) {
        emitter.once('tick', rearm)
      }
    }
    emitter.once('tick', rearm)

    emitter.emit('tick')
    emitter.emit('tick')
    emitter.emit('tick')

    expect(calls).toBe(2)
  })

  it('the disposer cancels a once listener before it ever fires', () => {
    const emitter = createEvent<{ tick: [] }>()
    let calls = 0

    const dispose = emitter.once('tick', () => {
      calls += 1
    })
    dispose()
    emitter.emit('tick')

    expect(calls).toBe(0)
  })
})

describe('off / clear / listenerCount', () => {
  it('off(name, listener) removes only the matching listener', () => {
    const emitter = createEvent<{ msg: [string] }>()
    const calls: string[] = []

    const keep = (text: string) => {
      calls.push(`keep:${text}`)
    }
    const drop = (text: string) => {
      calls.push(`drop:${text}`)
    }

    emitter.on('msg', keep)
    emitter.on('msg', drop)
    emitter.off('msg', drop)
    emitter.off('msg', drop) // unknown listener afterwards — no-op

    emitter.emit('msg', 'x')

    expect(calls).toEqual(['keep:x'])
  })

  it('off(name) removes every listener for that name, leaving other names alone', () => {
    const emitter = createEvent<{ a: []; b: [] }>()
    const calls: string[] = []

    emitter.on('a', () => {
      calls.push('a1')
    })
    emitter.on('a', () => {
      calls.push('a2')
    })
    emitter.on('b', () => {
      calls.push('b1')
    })

    emitter.off('a')
    emitter.emit('a')
    emitter.emit('b')

    expect(calls).toEqual(['b1'])
    expect(emitter.listenerCount('a')).toBe(0)
    expect(emitter.listenerCount('b')).toBe(1)
  })

  it('clear() drops all listeners across every event name', () => {
    const emitter = createEvent<{ a: []; b: [] }>()
    let calls = 0

    emitter.on('a', () => {
      calls += 1
    })
    emitter.on('b', () => {
      calls += 1
    })

    emitter.clear()
    emitter.emit('a')
    emitter.emit('b')

    expect(calls).toBe(0)
    expect(emitter.listenerCount('a')).toBe(0)
    expect(emitter.listenerCount('b')).toBe(0)
  })
})

describe('emitAsync', () => {
  it('resolves only after a single async listener settles', async () => {
    const emitter = createEvent<{ job: [string] }>()
    const gate = Promise.withResolvers<void>()
    const steps: string[] = []

    emitter.on('job', async name => {
      steps.push(`start:${name}`)
      await gate.promise
      steps.push(`end:${name}`)
    })

    const pending = emitter.emitAsync('job', 'x')
    expect(steps).toEqual(['start:x'])

    gate.resolve()
    await pending

    expect(steps).toEqual(['start:x', 'end:x'])
  })

  it('starts every listener synchronously, then awaits all async ones', async () => {
    const emitter = createEvent<{ job: [] }>()
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const steps: string[] = []

    emitter.on('job', async () => {
      steps.push('start:first')
      await first.promise
      steps.push('end:first')
    })
    emitter.on('job', () => {
      steps.push('sync')
    })
    emitter.on('job', async () => {
      steps.push('start:second')
      await second.promise
      steps.push('end:second')
    })

    const pending = emitter.emitAsync('job')
    // all three started before any async listener resolved
    expect(steps).toEqual(['start:first', 'sync', 'start:second'])

    second.resolve()
    first.resolve()
    await pending

    expect(steps.slice(3).toSorted()).toEqual(['end:first', 'end:second'])
  })

  it('resolves immediately when nobody listens', async () => {
    const emitter = createEvent<{ job: [] }>()

    await expect(emitter.emitAsync('job')).resolves.toBeUndefined()
  })

  it('propagates a rejection from an async listener', async () => {
    const emitter = createEvent<{ job: [] }>()

    emitter.on('job', async () => {
      await Promise.resolve()
      throw new Error('listener-failed')
    })

    await expect(emitter.emitAsync('job')).rejects.toThrow('listener-failed')
  })
})
