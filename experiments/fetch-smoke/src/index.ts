import { run } from '@ozaco/std/effect'
import { fetch } from '@ozaco/std/fetch'
import { isFailure, isSuccess, unwrap } from '@ozaco/std/result'

let failures = 0

const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    console.error(`  FAIL  ${name}`, detail ?? '')
    failures += 1
  }
}

const BASE = 'https://httpbin.org'

console.log('\n▶ fetch().json() chain')
const getResult = await run(function* () {
  return yield* fetch(`${BASE}/get?hello=world`).json<{ args: Record<string, string> }>()
})
check('chain isSuccess', isSuccess(getResult), getResult)
if (isSuccess(getResult)) {
  check('query param echoed', unwrap(getResult).args?.hello === 'world')
}

console.log('\n▶ fetch() → response.json() two-step')
const postResult = await run(function* () {
  const response = yield* fetch(`${BASE}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ foo: 'bar' }),
  })
  return yield* response.json<{ json: { foo: string } }>()
})
check('two-step isSuccess', isSuccess(postResult), postResult)
if (isSuccess(postResult)) {
  check('body echoed', unwrap(postResult).json?.foo === 'bar')
}

console.log('\n▶ fetch().text()')
const textResult = await run(function* () {
  return yield* fetch(`${BASE}/get`).text()
})
check('text isSuccess', isSuccess(textResult), textResult)
if (isSuccess(textResult)) {
  check(
    'text is non-empty',
    typeof unwrap(textResult) === 'string' && unwrap(textResult).length > 0,
  )
}

console.log('\n▶ fetch().expect() 404 fails with http-status')
const notFound = await run(function* () {
  return yield* fetch(`${BASE}/status/404`).expect()
})
check('404 is failure', isFailure(notFound), notFound)
if (isFailure(notFound)) {
  check('error kind is http-status', notFound.error === 'http-status', notFound.error)
}

console.log('\n▶ fetch() without .expect() → 404 flows through')
const passThrough = await run(function* () {
  const response = yield* fetch(`${BASE}/status/404`)
  return { status: response.status, ok: response.ok }
})
check('pass-through success', isSuccess(passThrough), passThrough)
if (isSuccess(passThrough)) {
  check('status is 404', unwrap(passThrough).status === 404)
  check('ok is false', unwrap(passThrough).ok === false)
}

console.log('\n▶ response.expect() 200 → same response')
const expect200 = await run(function* () {
  const response = yield* fetch(`${BASE}/get`)
  const checked = yield* response.expect()
  return checked.status
})
check('expect 200 success', isSuccess(expect200) && unwrap(expect200) === 200, expect200)

console.log('\n▶ response.expect() 500 fails with http-status')
const expect500 = await run(function* () {
  const response = yield* fetch(`${BASE}/status/500`)
  return yield* response.expect()
})
check('500 is failure', isFailure(expect500), expect500)
if (isFailure(expect500)) {
  check('error kind is http-status', expect500.error === 'http-status', expect500.error)
}

console.log('\n▶ fetch() bad host → network failure')
const networkFail = await run(function* () {
  return yield* fetch('https://this-host-does-not-exist-ozaco-test.invalid/')
})
check('network fail is failure', isFailure(networkFail), networkFail)
if (isFailure(networkFail)) {
  check('error kind is network', networkFail.error === 'network', networkFail.error)
}

if (failures > 0) {
  throw new Error(`${failures} check(s) failed`)
}

console.log('\n✓ all checks passed')
