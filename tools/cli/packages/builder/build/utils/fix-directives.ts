import { parse } from 'acorn-loose'

export const fixDirectives = (source: string, rawCode: string, removeOnly = false) => {
  let code = rawCode

  const parsed = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  })

  const parsedSource = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  })

  const directives: string[] = []
  const otherDirectives: string[] = []
  const targetRanges = new Set<string>()

  for (const node of parsed.body) {
    if (node.type === 'ExpressionStatement' && node.directive) {
      directives.push(node.directive)
      targetRanges.add(`${node.start}-${node.end}`)
    } else if (node.type === 'ExpressionStatement' && node.expression.type === 'Literal' && typeof node.expression.value === 'string') {
      directives.push(node.expression.value)
      targetRanges.add(`${node.start}-${node.end}`)
    }
  }

  for (const node of parsedSource.body) {
    if (node.type === 'ExpressionStatement' && node.directive) {
      otherDirectives.push(node.directive)
    }
  }

  let offset = 0

  for (const range of targetRanges) {
    const [start, end] = range.split('-').map(Number) as [number, number]

    code = code.slice(0, start + offset) + code.slice(end + offset)

    offset -= end - start
  }

  const uniqueDirectives = [...new Set(directives.concat(otherDirectives))].map(x => `"${x}";`).join('\n')

  if (!uniqueDirectives || removeOnly) {
    return code
  }

  return `${uniqueDirectives}\n${code}`
}
