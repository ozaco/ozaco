import type { SymbolDisplayPart } from 'typescript/lib/tsserverlibrary'

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: <explanation>
export const renamePluginActions = (symbols: SymbolDisplayPart[]): SymbolDisplayPart[] => {
  const pluginStart = symbols.findIndex(p => p.kind === 'aliasName' && p.text === 'PluginInstance')
  if (pluginStart === -1) {
    return symbols
  }

  const genericStart = symbols.findIndex((s, i) => i > pluginStart && s.text === '<')
  if (genericStart === -1) {
    return symbols
  }

  // Find matching '>'
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

  // Split top-level generic args by commas
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

  // Only transform 3rd generic arg if it's an object literal with property blocks
  if (genericArgs.length >= 3) {
    const thirdArg = genericArgs[2]
    const transformed: SymbolDisplayPart[] = []

    const trimmed = thirdArg
      .map(p => p.text)
      .join('')
      .trim()

    if (trimmed === '{}' || trimmed === '{ }') {
      return symbols
    }

    let i = 0
    while (i < thirdArg.length) {
      const current = thirdArg[i]

      if (current.kind === 'propertyName') {
        const propName = current.text
        transformed.push(current) // propertyName
        i++

        // skip `:`, `space`, then detect `{` to find block start
        if (
          thirdArg[i]?.text === ':' &&
          thirdArg[i + 1]?.kind === 'space' &&
          thirdArg[i + 2]?.text === '{'
        ) {
          transformed.push(thirdArg[i++]) // :
          transformed.push(thirdArg[i++]) // space
          // Skip until matching closing '}'
          let blockDepth = 0
          const blockStart = i
          while (i < thirdArg.length) {
            const t = thirdArg[i]
            if (t.text === '{') {
              blockDepth++
            } else if (t.text === '}') {
              blockDepth--
              if (blockDepth === 0) {
                i++ // include the closing `}`
                break
              }
            }
            i++
          }

          // Replace full block with alias
          transformed.push({
            text: `${propName[0].toUpperCase() + propName.slice(1)}Action`,
            kind: 'aliasName',
          })

          // Optional: expect/force `;`
          if (thirdArg[i]?.text === ';') {
            transformed.push(thirdArg[i++]) // ;
          }
          continue
        }
      }

      // default: copy token
      transformed.push(current)
      i++
    }

    genericArgs[2] = transformed
  }

  const joinedGeneric: SymbolDisplayPart[] = []
  genericArgs.forEach((arg, idx) => {
    joinedGeneric.push(...arg)
    if (idx < genericArgs.length - 1) {
      joinedGeneric.push({ text: ',', kind: 'punctuation' })
      joinedGeneric.push({ text: ' ', kind: 'space' })
    }
  })

  return [...symbols.slice(0, genericStart + 1), ...joinedGeneric, ...symbols.slice(genericEnd)]
}
