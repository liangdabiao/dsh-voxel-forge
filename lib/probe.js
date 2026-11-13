// 切片体检（probe.py 移植）：颜色分布 / 正面 ASCII 色图 / 深度剖面。文本输出，不写文件。
const CH = {
  BrightLightOrange: 'S', Black: '#', Orange: 'o', Yellow: 'y', Red: 'R',
  DarkRed: 'r', Green: 'G', BrightGreen: 'g', White: 'W', Tan: 't',
  LightNougat: 'n', ReddishBrown: 'b', DarkTan: 'T', DarkBrown: 'B', DarkOrange: 'd',
  Blue: 'U', MediumBlue: 'M', DarkBlue: 'D', Lime: 'L', MediumAzure: 'A', PearlGold: 'P',
}
const normKey = (s) => String(s).replace(/[^a-zA-Z]/g, '')

const counter = (iter) => {
  const m = new Map()
  for (const c of iter) m.set(c, (m.get(c) || 0) + 1)
  return m
}
const topN = (m, n = 4) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)

export function probeStats(vol) {
  const lines = [`grid ${vol.nx} x ${vol.ny} x ${vol.nz}, cells ${vol.cells.length}`]
  const all = counter(vol.cells.map((c) => c[3]))
  lines.push(`整体颜色: ${topN(all, 15).map(([c, n]) => `${c}=${n}`).join('  ')}`)
  const by = new Map()
  for (const [, b, , c] of vol.cells) {
    if (!by.has(b)) by.set(b, new Map())
    const m = by.get(b)
    m.set(c, (m.get(c) || 0) + 1)
  }
  lines.push('逐层颜色（只列前 4）:')
  for (const b of [...by.keys()].sort((x, y) => x - y)) {
    const m = by.get(b)
    const total = [...m.values()].reduce((x, y) => x + y, 0)
    lines.push(`  layer ${String(b).padStart(3)}  ${String(total).padStart(5)} cells  ${topN(m).map(([c, n]) => `${c}=${n}`).join('  ')}`)
  }
  return lines.join('\n')
}

export function probeLayers(vol, layersRange, colsRange) {
  const [b0, b1] = layersRange
  const [a0, a1] = colsRange
  const front = new Map()
  for (const [a, b, d, c] of vol.cells) {
    const k = a + ',' + b
    const f = front.get(k)
    if (!f || d > f[0]) front.set(k, [d, c])
  }
  const lines = [`正面 ASCII（行 = 层，从高到低；列 = ${a0}..${a1}）`]
  lines.push('     ' + Array.from({ length: a1 - a0 }, (_x, i) => Math.floor((a0 + i) / 10) % 10).join(''))
  lines.push('     ' + Array.from({ length: a1 - a0 }, (_x, i) => (a0 + i) % 10).join(''))
  for (let b = b1 - 1; b >= b0; b--) {
    let line = ''
    for (let a = a0; a < a1; a++) {
      const f = front.get(a + ',' + b)
      line += f ? (CH[normKey(f[1])] || '?') : '.'
    }
    lines.push(`${String(b).padStart(3)}  ${line}`)
  }
  lines.push('     ' + Array.from({ length: a1 - a0 }, (_x, i) => Math.floor((a0 + i) / 10) % 10).join(''))
  lines.push('     ' + Array.from({ length: a1 - a0 }, (_x, i) => (a0 + i) % 10).join(''))
  return lines.join('\n')
}

export function probeProfile(vol, a, b) {
  const row = new Map()
  for (const [aa, bb, d, c] of vol.cells) {
    if (aa === a && bb === b) row.set(d, c)
  }
  const lines = [`深度剖面 a=${a} b=${b}（z 从小到大 = 从后到前）`]
  for (const d of [...row.keys()].sort((x, y) => x - y)) lines.push(`  z=${String(d).padStart(3)}  ${row.get(d)}`)
  if (row.size) {
    const maxD = Math.max(...row.keys())
    lines.push(`  最前 = z=${maxD} ${row.get(maxD)}`)
  }
  return lines.join('\n')
}
