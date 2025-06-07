import type { SymbolDisplayPart } from 'typescript/lib/tsserverlibrary'

const NAME_REGEX = /name:(\s*[^;]+)/

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
export const renamePluginInstance = (symbols: SymbolDisplayPart[]): SymbolDisplayPart[] => {
  const pluginStart = symbols.findIndex(p => p.kind === 'aliasName' && p.text === 'PluginInstance')
  if (pluginStart === -1) {
    return symbols
  }

  const genericStart = symbols.findIndex((s, i) => i > pluginStart && s.text === '<')
  if (genericStart === -1) {
    return symbols
  }

  let depth = 0
  let genericEnd = -1
  for (let i = genericStart; i < symbols.length; i++) {
    if (symbols[i].text === '<') {
      depth++
    } else if (symbols[i].text === '>') {
      depth--
    }
    if (depth === 0) {
      genericEnd = i
      break
    }
  }
  if (genericEnd === -1) {
    return symbols
  }

  const genericParts = symbols.slice(genericStart + 1, genericEnd)

  const genericArgs: SymbolDisplayPart[][] = []
  let arg: SymbolDisplayPart[] = []
  let level = 0

  for (let i = 0; i < genericParts.length; i++) {
    const part = genericParts[i]
    if (part.text === '<' || part.text === '{' || part.text === '[') {
      level++
    } else if (part.text === '>' || part.text === '}' || part.text === ']') {
      level--
    }

    if (part.text === ',' && level === 0) {
      genericArgs.push(arg)
      arg = []
    } else {
      arg.push(part)
    }
  }
  if (arg.length > 0) {
    genericArgs.push(arg)
  }

  let name = 'Unknown'
  if (genericArgs.length > 0) {
    const firstArg = genericArgs[0]
    const trimmed = firstArg
      .map(p => p.text)
      .join('')
      .trim()
    if (trimmed.match(NAME_REGEX)) {
      const foundName = (trimmed.match(NAME_REGEX)?.[1] as string).trim().split('"').join('')
      if (foundName.length > 0) {
        name = foundName
      }
    }
  }

  const thirdArg = genericArgs[2] || []

  const colonIndex = symbols.findIndex(s => s.text === ':' && s.kind === 'punctuation')
  if (colonIndex === -1) {
    return symbols
  }

  const beforeColon = symbols.slice(0, colonIndex + 1)

  const newSymbols: SymbolDisplayPart[] = []
  newSymbols.push(...beforeColon)
  newSymbols.push({
    text: ` ${name.charAt(0).toUpperCase() + name.slice(1)}Plugin`,
    kind: 'aliasName',
  })
  newSymbols.push({ text: '<', kind: 'punctuation' })

  while (
    thirdArg.length > 0 &&
    (thirdArg[0].text.trim() === '' ||
      thirdArg[0].kind === 'space' ||
      thirdArg[0].kind === 'lineBreak')
  ) {
    thirdArg.shift()
  }

  newSymbols.push(...thirdArg)
  newSymbols.push({ text: '>', kind: 'punctuation' })

  const afterGeneric = symbols.slice(genericEnd + 1)
  newSymbols.push(...afterGeneric)

  return newSymbols
}
