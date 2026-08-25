import { isPromise, pipe } from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('pipe', () => {
  it('threads a value through the functions left to right', () => {
    const piped = pipe(
      2,
      value => value + 1,
      value => `${value * 3}`,
    )

    expect(piped).toBe('9')
    expect(pipe('untouched')).toBe('untouched')
  })

  it('switches to promise chaining as soon as a step goes async', async () => {
    const eventual = pipe(
      2,
      value => Promise.resolve(value + 1),
      value => value * 10,
    )

    expect(isPromise(eventual)).toBe(true)
    expect(await eventual).toBe(30)

    expect(await pipe(Promise.resolve('a'), value => `${value}b`)).toBe('ab')
  })
})
