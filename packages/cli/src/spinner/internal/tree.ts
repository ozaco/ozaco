import type { PaletteDef } from 'cli:core'

import type { TreeNode } from '../types'

const glyph = (node: TreeNode, palette: PaletteDef.Context, frame: number): string => {
  const { colors, symbols } = palette

  if (node.status === 'success') {
    return colors.success(symbols.answered)
  }
  if (node.status === 'fail') {
    return colors.error(symbols.error)
  }
  if (node.status === 'warn') {
    return colors.warning(symbols.warning)
  }
  if (node.status === 'info') {
    return colors.info(symbols.info)
  }

  const frames = symbols.spinner
  return colors.primary(frames[frame % frames.length] ?? '')
}

const bar = (node: TreeNode, palette: PaletteDef.Context): string => {
  const { colors, symbols } = palette
  const total = node.total > 0 ? node.total : 1
  const ratio = clamp(node.value / total, 1)
  const filled = Math.round(ratio * node.width)

  const cells =
    colors.primary(symbols.barComplete.repeat(filled)) +
    colors.muted(symbols.barIncomplete.repeat(node.width - filled))

  return `${cells} ${colors.muted(`${Math.round(ratio * 100)}%`)}`
}

const line = (node: TreeNode, palette: PaletteDef.Context, frame: number): string => {
  const head = `${glyph(node, palette, frame)} ${node.message}`
  return node.type === 'bar' ? `${head} ${bar(node, palette)}` : head
}

export const clamp = (node: TreeNode | number, max: number): number =>
  Math.max(0, Math.min(max, typeof node === 'number' ? node : node.total))

export const spinnerNode = (message: string): TreeNode => ({
  type: 'spinner',
  message,
  status: 'pending',
  value: 0,
  total: 0,
  width: 0,
  children: [],
})

export const barNode = (
  message: string,
  options: { total?: number | undefined; width?: number | undefined } = {},
): TreeNode => ({
  type: 'bar',
  message,
  status: 'pending',
  value: 0,
  total: options.total ?? 100,
  width: options.width ?? 18,
  children: [],
})

export const renderTree = (
  nodes: readonly TreeNode[],
  palette: PaletteDef.Context,
  frame: number,
): string => {
  const walk = (items: readonly TreeNode[], depth: number, indent: string): string[] => {
    const out: string[] = []

    for (const [index, node] of Object.entries(items)) {
      const isLast = +index === items.length - 1
      const connector = depth === 0 ? '' : isLast ? '└ ' : '├ '
      out.push(`${palette.colors.muted(indent + connector)}${line(node, palette, frame)}`)

      if (node.children.length > 0) {
        const childIndent = depth === 0 ? '  ' : indent + (isLast ? '   ' : '│  ')
        out.push(...walk(node.children, depth + 1, childIndent))
      }
    }

    return out
  }

  return walk(nodes, 0, '').join('\n')
}
