import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { Impl } from '../types/impl'

const validate = (
  schema: StandardSchemaV1,
  value: unknown,
): StandardSchemaV1.SuccessResult<unknown> | StandardSchemaV1.FailureResult => {
  const result = schema['~standard'].validate(value)

  if (result instanceof Promise) {
    throw new TypeError('Async schema validation is not supported in defineAction')
  }

  return result
}

const formatIssues = (type: string, issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  `${type}: ${issues.map(i => i.message).join(', ')}`

export const defineAction: Impl.DefineAction = (...args: AnyType[]) => {
  const [configOrHandler, maybeHandler] = args
  const hasConfig =
    typeof configOrHandler === 'object' && configOrHandler !== null && 'input' in configOrHandler

  const handler = hasConfig ? maybeHandler : configOrHandler
  const config = hasConfig ? configOrHandler : undefined

  const inputSchema = config?.input as StandardSchemaV1 | undefined
  const outputSchema = config?.output as StandardSchemaV1 | undefined

  const validated =
    inputSchema || outputSchema
      ? function* (...callArgs: AnyType[]) {
          if (inputSchema) {
            const ctx = callArgs[0]
            const result = validate(inputSchema, ctx.body)

            if (result.issues) {
              yield* fail('validation' as const, formatIssues('input', result.issues))
            }
            ctx.body = (result as StandardSchemaV1.SuccessResult<unknown>).value
          }

          const output: AnyType = yield* handler(...callArgs)

          if (outputSchema) {
            const result = validate(outputSchema, output)
            if (result.issues) {
              yield* fail('validation' as const, formatIssues('output', result.issues))
            }
            return (result as StandardSchemaV1.SuccessResult<unknown>).value
          }

          return output
        }
      : handler

  const action = operation(validated)

  Object.assign(action, {
    input: inputSchema,
    output: outputSchema,
    title: config?.title,
    description: config?.description,
  })

  return action as AnyType
}
