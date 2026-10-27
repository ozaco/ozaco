/**
 * The kernel plumbing behind the `Server` protocol's own actions — loaded by `definition/
 * protocol.ts` on first use, never imported there statically: this module reaches the impls
 * (`ServerClient`, the edge engine), which read the protocol handles at module level, so a static
 * import would evaluate them before `Server` exists.
 */
export { createNode } from './create'
export { openEdge } from '../utils/edge'
export { dispatchSpan } from '../utils/trace'
