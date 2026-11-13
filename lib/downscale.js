// volume.json 缩放（downscale.py 移植）：N×N×N 桶归并 → 尺寸 1/N。
// 为什么要归并而不是降层数重切：重切要重新全量采样（内存峰值大），归并只读已验收的 volume.json，秒级、确定性。
// 代价（交付时必须说明）：1 格宽的细结构归并后变粗或断开。定色 = 桶内众数，先到者赢（平票），不做插值。
export function downscale(vol, { factor = 2 } = {}) {
  const f = Math.max(1, Math.floor(factor))
  const buckets = new Map()
  const order = []
  for (const [x, y, z, c] of vol.cells) {
    const k = `${Math.floor(x / f)},${Math.floor(y / f)},${Math.floor(z / f)}`
    let m = buckets.get(k)
    if (!m) {
      m = new Map()
      buckets.set(k, m)
      order.push(k)
    }
    m.set(c, (m.get(c) || 0) + 1)
  }
  const cells = []
  for (const k of order) {
    const m = buckets.get(k)
    let best = null
    let bn = -1
    for (const [c, n] of m) {
      if (n > bn) { bn = n; best = c }
    }
    const [x, y, z] = k.split(',').map(Number)
    cells.push([x, y, z, best])
  }
  cells.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]) || (p[2] - q[2]))
  return {
    nx: Math.ceil(vol.nx / f),
    ny: Math.ceil(vol.ny / f),
    nz: Math.ceil(vol.nz / f),
    up: vol.up, front: vol.front, cam: vol.cam ?? 1,
    cells,
    scaled_from: { nx: vol.nx, ny: vol.ny, nz: vol.nz, cells: vol.cells.length },
  }
}
