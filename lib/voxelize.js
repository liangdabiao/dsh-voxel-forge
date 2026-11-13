// GLB → 积木体素切片（vox.py 全量 JS 移植，numpy 向量化 → TypedArray + Map）。
// 六步：面积加权投票（+暗细节保底）→ 三维洪泛判内外 → 反填 carve → 表面取色（归并/吸收）→ 内部 BFS 传色 → 去噪。
// 移植说明（一处对上游的有意修正）：
//   ① face_pal 逐面主色：vox.py 注释说"覆盖面积最大的颜色"，但 lexsort 升序后取组首实际取的是最小面积色——
//      按注释意图取最大（多数面只有一种颜色不受影响；边界格取最大才是"面积加权"本意）。
//   ② 外部空气洪泛：numpy 逐轮 OR 迭代（≤400 轮）→ BFS 队列（O(N)，不动点等价）。
import { extractMesh, loadGlb } from './glb.js'

export const PAL_DEFAULT = [
  ['Red', [200, 30, 25]], ['Dark Red', [110, 20, 22]],
  ['Bright Light Orange', [248, 180, 60]], ['Yellow', [245, 205, 60]],
  ['Orange', [250, 125, 20]], ['Dark Orange', [170, 85, 10]],
  ['Green', [35, 120, 60]], ['Bright Green', [90, 170, 80]],
  ['Black', [30, 33, 36]], ['White', [245, 245, 245]],
  ['Tan', [225, 200, 150]], ['Light Nougat', [245, 215, 180]],
  ['Reddish Brown', [95, 45, 25]], ['Dark Tan', [150, 140, 118]],
  ['Dark Brown', [60, 40, 28]],
]

// 6 方向仓顺序必须与 binid 一致：0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z
const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

export const MERGE_DEFAULT = {
  Red: ['Dark Red', 'Orange', 'Dark Orange'],
  Green: ['Bright Green'],
  'Bright Light Orange': ['Yellow', 'Tan', 'Light Nougat', 'Dark Tan'],
}

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 24 层每层一色验证球：证明分层/坐标/叠砖链路正确（vox.py --ball）。 */
export function makeBall(palette = PAL_DEFAULT) {
  const n = 24
  const r = n / 2 - 0.5
  const cells = []
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      for (let d = 0; d < n; d++) {
        const cx = a - r, cy = b - r, cz = d - r
        if (cx * cx + cy * cy + cz * cz <= r * r) cells.push([a, b, d, palette[(b * 3) % palette.length][0]])
      }
    }
  }
  return { nx: n, ny: n, nz: n, up: 1, front: 2, cam: 1, cells }
}

function quantizeIndex(rgb, palc, w) {
  let best = 0
  let bestD = Infinity
  for (let p = 0; p < palc.length; p++) {
    const dr = rgb[0] - palc[p][0], dg = rgb[1] - palc[p][1], db = rgb[2] - palc[p][2]
    const d = dr * dr * w[0] + dg * dg * w[1] + db * db * w[2]
    if (d < bestD) { bestD = d; best = p }
  }
  return best
}

/**
 * 体素切片主入口。
 * @param mesh { pos,nrm,uv,idx,tex } 来自 extractMesh()
 * @param opts { courses=96, ratio=1.2, denoise=2, merge='default', absorb=3, protect='Black,White',
 *               darkdetail=0.32, cam=1, palette?, rotation?, log? }
 * @returns { nx, ny, nz, up, front, cam, cells }
 */
export function voxelize(mesh, opts = {}) {
  const log = opts.log || (() => {})
  const courses = Math.max(8, Math.min(256, Number(opts.courses) || 96))
  const ratio = Number(opts.ratio) || 1.2
  const denoise = opts.denoise === undefined ? 2 : Number(opts.denoise)
  const absorb = opts.absorb === undefined ? 3 : Number(opts.absorb)
  const darkdetail = opts.darkdetail === undefined ? 0.32 : Number(opts.darkdetail)
  const cam = Number(opts.cam) || 1

  const PAL = opts.palette && Object.keys(opts.palette).length
    ? Object.entries(opts.palette).map(([k, v]) => [k, Array.isArray(v) ? v : hexToRgb(v)])
    : PAL_DEFAULT
  const PALS = PAL.map(([n]) => n)
  const PALC = PAL.map(([, c]) => c)
  const LUM = PALC.map((c) => 0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2])
  const W3 = [0.30, 0.59, 0.11]
  const BLACKI = Math.max(0, PALS.indexOf('Black'))

  const { pos, nrm, uv, idx, tex } = mesh
  const triCount = idx.length / 3
  if (!triCount) throw new Error('模型没有三角面')

  // ── 节点旋转（四元数）→ 世界坐标
  const [qx, qy, qz, qw] = opts.rotation || [0, 0, 0, 1]
  const R = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ]
  const vn = pos.length / 3
  const P = new Float32Array(pos.length)
  const NR = new Float32Array(nrm.length)
  for (let i = 0; i < vn; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    P[i * 3] = R[0][0] * x + R[0][1] * y + R[0][2] * z
    P[i * 3 + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z
    P[i * 3 + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z
  }
  for (let i = 0; i < vn; i++) {
    const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2]
    NR[i * 3] = R[0][0] * x + R[0][1] * y + R[0][2] * z
    NR[i * 3 + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z
    NR[i * 3 + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z
  }

  // ── 包围盒、朝向轴、网格尺寸
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < vn; i++) {
    for (let k = 0; k < 3; k++) {
      const v = P[i * 3 + k]
      if (v < lo[k]) lo[k] = v
      if (v > hi[k]) hi[k] = v
    }
  }
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  const up = ext.indexOf(Math.max(...ext))
  const rest = [0, 1, 2].filter((i) => i !== up)
  const front = ext[rest[0]] <= ext[rest[1]] ? rest[0] : rest[1]
  log(`bbox ext=${ext.map((v) => v.toFixed(2)).join('×')} up=${'XYZ'[up]} front=${'XYZ'[front]} courses=${courses}`)

  const h = ext[up] / courses
  const stud = h / ratio
  const ns = [0, 1, 2].map((i) => Math.max(1, Math.round(ext[i] / stud)))
  ns[up] = courses
  log(`grid ${ns.join('×')} stud=${stud.toFixed(3)} course=${h.toFixed(3)}`)
  const [NA, NB1, NC1] = ns
  const cells3 = NA * NB1 * NC1
  const cellKey = (a, b, d) => (a * NB1 + b) * NC1 + d

  const sampleTex = (u, v, out) => {
    let tx = Math.floor((u - Math.floor(u)) * (tex.w - 1))
    let ty = Math.floor((v - Math.floor(v)) * (tex.h - 1)) // glTF: V 原点在左上角，不翻转
    if (tx < 0) tx = 0
    if (tx > tex.w - 1) tx = tex.w - 1
    if (ty < 0) ty = 0
    if (ty > tex.h - 1) ty = tex.h - 1
    const o = (ty * tex.w + tx) * 3
    out[0] = tex.data[o]; out[1] = tex.data[o + 1]; out[2] = tex.data[o + 2]
  }

  // ── 步骤 1：面积加权投票 + surface 标记（7 点采样落点）
  const acc = new Map() // key=(cell*6+bin)*64+pi → area
  const surface = new Uint8Array(cells3)
  const BC = [[1 / 3, 1 / 3, 1 / 3], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]
  const rgb = [0, 0, 0]
  for (let t0 = 0; t0 < triCount; t0++) {
    const i0 = idx[t0 * 3] * 3, i1 = idx[t0 * 3 + 1] * 3, i2 = idx[t0 * 3 + 2] * 3
    const nx_ = (NR[i0] + NR[i1] + NR[i2]) / 3
    const ny_ = (NR[i0 + 1] + NR[i1 + 1] + NR[i2 + 1]) / 3
    const nz_ = (NR[i0 + 2] + NR[i1 + 2] + NR[i2 + 2]) / 3
    let ax = 0, av = Math.abs(nx_)
    if (Math.abs(ny_) > av) { ax = 1; av = Math.abs(ny_) }
    if (Math.abs(nz_) > av) { ax = 2; av = Math.abs(nz_) }
    const sgnv = [nx_, ny_, nz_][ax]
    const binid = ax * 2 + (sgnv < 0 ? 1 : 0)
    const e1x = P[i1] - P[i0], e1y = P[i1 + 1] - P[i0 + 1], e1z = P[i1 + 2] - P[i0 + 2]
    const e2x = P[i2] - P[i0], e2y = P[i2 + 1] - P[i0 + 1], e2z = P[i2 + 2] - P[i0 + 2]
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
    const cenx = (P[i0] + P[i1] + P[i2]) / 3, ceny = (P[i0 + 1] + P[i1 + 1] + P[i2 + 1]) / 3, cenz = (P[i0 + 2] + P[i1 + 2] + P[i2 + 2]) / 3
    const cu = (uv[i0] + uv[i1] + uv[i2]) / 3, cv = (uv[i0 + 1] + uv[i1 + 1] + uv[i2 + 1]) / 3
    sampleTex(cu, cv, rgb)
    const pi = quantizeIndex(rgb, PALC, W3)
    const cell = cellKey(clampIdx((cenx - lo[0]) / stud, NA), clampIdx((ceny - lo[1]) / stud, NB1), clampIdx((cenz - lo[2]) / stud, NC1))
    surface[cell] = 1
    const key = (cell * 6 + binid) * 64 + pi
    acc.set(key, (acc.get(key) || 0) + area)
    // 7 点采样标记 surface（vox.py 的 CF→Ssurf）
    for (let s = 0; s < 7; s++) {
      const [b0, b1_, b2] = BC[s]
      const ga = clampIdx((b0 * P[i0] + b1_ * P[i1] + b2 * P[i2] - lo[0]) / stud, NA)
      const gb = clampIdx((b0 * P[i0 + 1] + b1_ * P[i1 + 1] + b2 * P[i2 + 1] - lo[1]) / stud, NB1)
      const gd = clampIdx((b0 * P[i0 + 2] + b1_ * P[i1 + 2] + b2 * P[i2 + 2] - lo[2]) / stud, NC1)
      surface[cellKey(ga, gb, gd)] = 1
    }
  }
  log(`tris=${triCount} samples=${triCount * 7} areaEntries=${acc.size}`)

  // acc → 每格每面（cf=cell*6+bin）：主色（面积最大）/ 面积和 / 颜色种类数
  let maxCf = 0
  for (const key of acc.keys()) { const cf = key >> 6; if (cf > maxCf) maxCf = cf }
  const ncf = maxCf + 1
  const facePal = new Int16Array(ncf).fill(-1)
  const faceArea = new Float32Array(ncf)
  const faceVotes = new Int32Array(ncf)
  const bestPi = new Int16Array(ncf).fill(-1)
  const bestArea = new Float64Array(ncf)
  for (const [key, area] of acc) {
    const cf = key >> 6
    const pi = key & 63
    faceArea[cf] += area
    faceVotes[cf]++
    if (area > bestArea[cf]) { bestArea[cf] = area; bestPi[cf] = pi }
  }
  for (let cf = 0; cf < ncf; cf++) if (bestPi[cf] >= 0) facePal[cf] = bestPi[cf] // 修正①：面积最大

  // ── 步骤 1b：暗细节保底（黑色覆盖占比 ≥ darkdetail 且主色偏浅 → 取最暗色）
  if (darkdetail > 0) {
    const darkA = new Float64Array(ncf)
    const darkest = new Int16Array(ncf).fill(-1)
    for (const [key, area] of acc) {
      const cf = key >> 6
      const pi = key & 63
      if (pi === BLACKI && LUM[facePal[cf]] > 95) darkA[cf] += area
      if (darkest[cf] === -1 || LUM[pi] < LUM[darkest[cf]]) darkest[cf] = pi
    }
    let hits = 0
    for (let cf = 0; cf < ncf; cf++) {
      if (facePal[cf] < 0) continue
      if (darkA[cf] / Math.max(faceArea[cf], 1e-9) >= darkdetail && darkest[cf] >= 0) { facePal[cf] = darkest[cf]; hits++ }
    }
    log(`detail rescue: ${hits} faces`)
  }
  acc.clear()

  // ── 步骤 2：三维洪泛判内外（dilate×2 封缝 → BFS 外部空气 → ~out 腐蚀×2 回收）
  const Sb = morph(surface, ns, 2, 'dilate')
  const outside = floodOutside(Sb, ns)
  const insideTrue = morph(notOf(outside), ns, 2, 'erode') // vox.py: inside = erode(erode(~out))
  const solid = new Uint8Array(cells3)
  let solidCount = 0
  for (let i = 0; i < cells3; i++) {
    const v = surface[i] | insideTrue[i]
    solid[i] = v
    if (v) solidCount++
  }
  log(`solid cells ${solidCount} (surface ${countOnes(surface)} / open air ${countOnes(outside)})`)

  // ── 步骤 2b：反填 carve——可见面朝外那格必须为空（浅槽五官不被洪泛封死）
  {
    const targets = new Set()
    for (let cf = 0; cf < ncf; cf++) {
      if (faceArea[cf] <= 0) continue
      const cell = Math.floor(cf / 6), bin = cf % 6
      const a = Math.floor(cell / (NB1 * NC1)), b = Math.floor(cell / NC1) % NB1, d = cell % NC1
      const ta = a + NB[bin][0], tb = b + NB[bin][1], td = d + NB[bin][2]
      if (ta >= 0 && ta < NA && tb >= 0 && tb < NB1 && td >= 0 && td < NC1) targets.add(cellKey(ta, tb, td))
    }
    for (let it = 0; it < 8; it++) {
      let n = 0
      for (const k of targets) {
        if (solid[k] && !surface[k]) { solid[k] = 0; n++ }
      }
      if (!n) break
      log(`carve ${it}: ${n}`)
    }
  }

  // ── 步骤 3：表面格取「朝外面面积最大」的颜色（朝外 = 邻格越界或非实体）
  const colmap = new Map()
  {
    const cand = new Map()
    for (let cf = 0; cf < ncf; cf++) {
      if (faceVotes[cf] <= 0 || facePal[cf] < 0) continue
      const cell = Math.floor(cf / 6), bin = cf % 6
      const a = Math.floor(cell / (NB1 * NC1)), b = Math.floor(cell / NC1) % NB1, d = cell % NC1
      const na = a + NB[bin][0], nb = b + NB[bin][1], nd = d + NB[bin][2]
      const oob = na < 0 || na >= NA || nb < 0 || nb >= NB1 || nd < 0 || nd >= NC1
      if (!oob && solid[cellKey(na, nb, nd)]) continue
      const cur = cand.get(cell)
      if (!cur || faceArea[cf] > cur.area) cand.set(cell, { cf, area: faceArea[cf] })
    }
    for (const [cell, v] of cand) colmap.set(cell, PALS[facePal[v.cf]])
    log(`coloured surface cells ${colmap.size}`)
  }

  // ── 步骤 3b：按区域归并颜色（同族连通分量统一成区域主色；成片明暗分区保留）
  if (opts.merge !== 'none') {
    const mm = opts.merge && opts.merge !== 'default' ? opts.merge : MERGE_DEFAULT
    const fam = new Map()
    for (const [t, lst] of Object.entries(mm)) {
      fam.set(t, t)
      for (const src of lst) fam.set(src, t)
    }
    const family = (c) => fam.get(c) || c
    const seen = new Set()
    let merged = 0
    for (const k0 of colmap.keys()) {
      if (seen.has(k0)) continue
      const f = family(colmap.get(k0))
      const comp = [k0]
      seen.add(k0)
      const q = [k0]
      while (q.length) {
        const cur = q.pop()
        const a = Math.floor(cur / (NB1 * NC1)), b = Math.floor(cur / NC1) % NB1, d = cur % NC1
        for (const [dx, dy, dz] of NB) {
          const na = a + dx, nb = b + dy, nd = d + dz
          if (na < 0 || na >= NA || nb < 0 || nb >= NB1 || nd < 0 || nd >= NC1) continue
          const nk = cellKey(na, nb, nd)
          if (!seen.has(nk) && colmap.has(nk) && family(colmap.get(nk)) === f) {
            seen.add(nk)
            q.push(nk)
            comp.push(nk)
          }
        }
      }
      const tally = new Map()
      for (const p of comp) tally.set(colmap.get(p), (tally.get(colmap.get(p)) || 0) + 1)
      let target
      if (tally.has(f)) target = f
      else {
        let bn = -1
        for (const [c, n] of tally) if (n > bn) { bn = n; target = c }
      }
      if (tally.size > 1 || target !== f) {
        for (const p of comp) colmap.set(p, target)
        merged += comp.length
      }
    }
    log(`merge: ${merged} cells unified into ${new Set([...colmap.values()].map(family)).size} colours`)
  }

  // ── 步骤 3c：孤立小色块并进邻域主色（≤absorb 格；保护色不动）
  if (absorb > 0) {
    const protect = new Set(String(opts.protect || 'Black,White').split(',').map((s) => s.trim()).filter(Boolean))
    const seen = new Set()
    let changed = 0
    for (const k0 of colmap.keys()) {
      if (seen.has(k0)) continue
      const c = colmap.get(k0)
      const comp = [k0]
      seen.add(k0)
      const q = [k0]
      while (q.length) {
        const cur = q.pop()
        const a = Math.floor(cur / (NB1 * NC1)), b = Math.floor(cur / NC1) % NB1, d = cur % NC1
        for (const [dx, dy, dz] of NB) {
          const na = a + dx, nb = b + dy, nd = d + dz
          if (na < 0 || na >= NA || nb < 0 || nb >= NB1 || nd < 0 || nd >= NC1) continue
          const nk = cellKey(na, nb, nd)
          if (!seen.has(nk) && colmap.get(nk) === c) {
            seen.add(nk)
            q.push(nk)
            comp.push(nk)
          }
        }
      }
      if (comp.length > absorb || protect.has(c)) continue
      const tally = new Map()
      for (const cur of comp) {
        const a = Math.floor(cur / (NB1 * NC1)), b = Math.floor(cur / NC1) % NB1, d = cur % NC1
        for (const [dx, dy, dz] of NB) {
          const c2 = colmap.get(cellKey(a + dx, b + dy, d + dz))
          if (c2 !== undefined && c2 !== c) tally.set(c2, (tally.get(c2) || 0) + 1)
        }
      }
      if (!tally.size) continue
      let top = null, bn = -1
      for (const [cc, n] of tally) if (n > bn) { bn = n; top = cc }
      for (const p of comp) colmap.set(p, top)
      changed += comp.length
    }
    log(`absorb: ${changed} cells`)
  }

  // ── 步骤 4：内部格 BFS 从外表面向内传播最近颜色
  const filled = new Map(colmap)
  {
    const q = [...colmap.keys()]
    let head = 0
    while (head < q.length) {
      const cur = q[head++]
      const c = filled.get(cur)
      const a = Math.floor(cur / (NB1 * NC1)), b = Math.floor(cur / NC1) % NB1, d = cur % NC1
      for (const [dx, dy, dz] of NB) {
        const na = a + dx, nb = b + dy, nd = d + dz
        if (na < 0 || na >= NA || nb < 0 || nb >= NB1 || nd < 0 || nd >= NC1) continue
        const nk = cellKey(na, nb, nd)
        if (solid[nk] && !filled.has(nk)) {
          filled.set(nk, c)
          q.push(nk)
        }
      }
    }
    log(`filled cells ${filled.size} of ${solidCount}`)
  }

  // ── 步骤 5：3×3×3 去噪（同色邻格 <3 的孤立点并入邻域主色；会吃 1 格宽细线，可关）
  if (denoise > 0) {
    for (let round = 0; round < denoise; round++) {
      let changed = 0
      for (const [k, own] of [...filled.entries()]) {
        const a = Math.floor(k / (NB1 * NC1)), b = Math.floor(k / NC1) % NB1, d = k % NC1
        const tally = new Map()
        let same = 0
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              if (!dx && !dy && !dz) continue
              const c = filled.get(cellKey(a + dx, b + dy, d + dz))
              if (c === undefined) continue
              tally.set(c, (tally.get(c) || 0) + 1)
              if (c === own) same++
            }
          }
        }
        if (same >= 3) continue
        let top = null, bn = -1
        for (const [cc, n] of tally) if (n > bn) { bn = n; top = cc }
        if (top && top !== own) { filled.set(k, top); changed++ }
      }
      log(`denoise ${changed}`)
      if (!changed) break
    }
  }

  const cells = []
  for (const [k, c] of filled) {
    cells.push([Math.floor(k / (NB1 * NC1)), Math.floor(k / NC1) % NB1, k % NC1, c])
  }
  cells.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]))
  return { nx: NA, ny: NB1, nz: NC1, up, front, cam, cells }
}

/** GLB 文件一键切片（工具/面板入口）。 */
export function voxelizeGlbFile(glbPath, opts = {}) {
  const { json, bin } = loadGlb(glbPath)
  const mesh = extractMesh(json, bin)
  const sceneIdx = json.scene ?? 0
  const nodeIdx = json.scenes?.[sceneIdx]?.nodes?.[0] ?? 0
  const rotation = json.nodes?.[nodeIdx]?.rotation
  return voxelize(mesh, { ...opts, rotation })
}

// ── 形态学与洪泛（体素 3D 网格，6 邻域，按 stride 位移）──────────────────────

function morph(a, ns, times, kind) {
  const [NA, NB1, NC1] = ns
  const sa = NB1 * NC1, sb = NC1, sc = 1
  let cur = a
  for (let t = 0; t < times; t++) {
    const src = kind === 'dilate' ? cur : cur
    const g = new Uint8Array(cur.length)
    if (kind === 'dilate') {
      g.set(src)
      for (let i = 0; i < src.length; i++) {
        if (!src[i]) continue
        if (i + sc < src.length) g[i + sc] = 1
        if (i - sc >= 0) g[i - sc] = 1
        if (i + sb < src.length) g[i + sb] = 1
        if (i - sb >= 0) g[i - sb] = 1
        if (i + sa < src.length) g[i + sa] = 1
        if (i - sa >= 0) g[i - sa] = 1
      }
    } else {
      // erode：g = src 六邻域全 1；边界置 0
      for (let i = 0; i < src.length; i++) {
        const d = i % NC1, b = Math.floor(i / NC1) % NB1, a2 = Math.floor(i / sa)
        if (a2 === 0 || a2 === NA - 1 || b === 0 || b === NB1 - 1 || d === 0 || d === NC1 - 1) continue
        g[i] = src[i] && src[i + sc] && src[i - sc] && src[i + sb] && src[i - sb] && src[i + sa] && src[i - sa] ? 1 : 0
      }
    }
    cur = g
  }
  return cur
}

function notOf(a) {
  const g = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) g[i] = a[i] ? 0 : 1
  return g
}

/** 从网格边界 BFS 外部空气（不可穿过 Sb）；返回 outside Uint8Array。 */
function floodOutside(block, ns) {
  const [NA, NB1, NC1] = ns
  const sa = NB1 * NC1, sb = NC1
  const out = new Uint8Array(block.length)
  const queue = new Int32Array(block.length)
  let qh = 0, qt = 0
  const seed = (i) => {
    if (!out[i] && !block[i]) { out[i] = 1; queue[qt++] = i }
  }
  for (let b = 0; b < NB1; b++) {
    for (let d = 0; d < NC1; d++) {
      seed(b * sb + d)
      seed((NA - 1) * sa + b * sb + d)
    }
  }
  for (let a = 0; a < NA; a++) {
    for (let d = 0; d < NC1; d++) {
      seed(a * sa + d)
      seed(a * sa + (NB1 - 1) * sb + d)
    }
    for (let b = 0; b < NB1; b++) {
      seed(a * sa + b * sb)
      seed(a * sa + b * sb + NC1 - 1)
    }
  }
  while (qh < qt) {
    const i = queue[qh++]
    const d = i % NC1, b = Math.floor(i / NC1) % NB1, a2 = Math.floor(i / sa)
    const push = (j) => { if (!out[j] && !block[j]) { out[j] = 1; queue[qt++] = j } }
    if (d > 0) push(i - 1)
    if (d < NC1 - 1) push(i + 1)
    if (b > 0) push(i - sb)
    if (b < NB1 - 1) push(i + sb)
    if (a2 > 0) push(i - sa)
    if (a2 < NA - 1) push(i + sa)
  }
  return out
}

function clampIdx(v, max) {
  const i = Math.floor(v)
  if (i < 0) return 0
  if (i >= max) return max - 1
  return i
}

function countOnes(a) {
  let n = 0
  for (let i = 0; i < a.length; i++) n += a[i]
  return n
}
