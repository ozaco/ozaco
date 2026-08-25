import { Codec } from 'std:codec'
import type { CodecDef } from 'std:codec'
import { fail } from 'std:result'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * A minimal, self-contained codec impl that prefixes its label — enough to see WHO answered.
 * Because decode/parse strip the label prefix, feeding them plain JSON mangles it: WHICH codec
 * handled a payload is always visible in the output.
 */
const fakeCodec = (label: string) =>
  Codec.implement({
    name: label,
    version: '1.0.0',
    *setup(options: CodecDef.Options = {}) {
      const context: CodecDef.Context = {
        name: options.name ?? label,
        priority: options.priority ?? 500,
      }
      return context
    },
  }).build({
    *encode(value) {
      return encoder.encode(`${label}:${JSON.stringify(value)}`)
    },
    *decode(data) {
      return JSON.parse(decoder.decode(data).slice(label.length + 1))
    },
    *stringify(value) {
      return `${label}:${JSON.stringify(value)}`
    },
    *parse(text) {
      return JSON.parse(text.slice(label.length + 1))
    },
    *encodeFlow() {
      return yield* fail('not-implemented', `${label} encodeFlow`)
    },
    *decodeFlow() {
      return yield* fail('not-implemented', `${label} decodeFlow`)
    },
  })

export { fakeCodec }
