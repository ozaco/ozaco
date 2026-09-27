/** Where a `createTags` bundle keeps its matchers: `[tag, matcher]` pairs in declaration order
 * (non-enumerable — `Object.values(bundle)` and `JSON.stringify(bundle)` stay the tags alone). */
export const TAG_MATCHERS = Symbol.for('std:shared:tag-matchers')
