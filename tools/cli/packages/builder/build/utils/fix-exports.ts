import type { ExportSpecifier } from 'acorn'
import { parse } from 'acorn-loose'

// fix for https://github.com/oven-sh/bun/issues/14493
export const fixExports = (rawCode: string) => {
  let code = rawCode

  const parsed = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  })

  const exports = parsed.body.filter(node => node.type === 'ExportNamedDeclaration')

  const seenExports = new Set<string>()
  const targetRanges = new Set<string>()

  for (const exportNode of exports) {
    let total = 0
    let target = 0

    const localTargets = new Set<ExportSpecifier>()

    for (const specifier of exportNode.specifiers) {
      if (specifier.exported.type !== 'Identifier' || specifier.local.type !== 'Identifier') {
        continue
      }

      total += 1

      const data = rawCode.slice(specifier.start, specifier.end)

      if (seenExports.has(data)) {
        target += 1
        localTargets.add(specifier)

        continue
      }

      seenExports.add(data)
    }

    if (total === target) {
      targetRanges.add(`${exportNode.start}-${exportNode.end}`)
    } else if (localTargets.size > 0) {
      for (const localTarget of localTargets) {
        const currIndex = exportNode.specifiers.indexOf(localTarget)
        const prev = exportNode.specifiers[currIndex - 1]

        if (prev) {
          targetRanges.add(`${prev.end}-${localTarget.end}`)
          continue
        }

        targetRanges.add(`${localTarget.start}-${localTarget.end}`)
      }
    }
  }

  let offset = 0

  for (const range of targetRanges) {
    const [start, end] = range.split('-').map(Number) as [number, number]

    code = code.slice(0, start + offset) + code.slice(end + offset)

    offset -= end - start
  }

  return code
}
