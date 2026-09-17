import type { FetchDef } from 'std:fetch'
import { Fetch, FetchClient } from 'std:fetch'
import type { Result } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('fetch contract', () => {
  it('the protocol and its impl carry different names, like ws and webrtc', () => {
    expect(Fetch.name).toBe('std/fetch')
    expect(FetchClient.name).toBe('std/fetch-client')
  })

  it('the close type of `Response.flow()` can be named by a consumer', () => {
    const clean: FetchDef.FlowClose = true
    const broken = { _t: Symbol.for('never') } as unknown as Result.Failure<unknown>
    const failed: FetchDef.FlowClose = broken

    // @ts-expect-error — `false` is not a close value
    const wrong: FetchDef.FlowClose = false

    expect([clean, failed === broken, wrong]).toEqual([true, true, false])
  })

  it('`FetchDef.Body` covers what a request accepts without the dom lib spelled out', () => {
    const bodies: FetchDef.Body[] = ['text', new Uint8Array(1), new URLSearchParams('a=1'), null]
    // a string member goes straight into an `Init`; the union as a whole is wider than the lib's
    // `BodyInit` (it admits views over a `SharedArrayBuffer`), so it is narrowed at the call site
    const init: FetchDef.Init = { body: 'text' satisfies FetchDef.Body }

    expect(bodies.length).toBe(4)
    expect(init.body).toBe('text')
  })
})
