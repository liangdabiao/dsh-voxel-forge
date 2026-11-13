// 程序化体素生成（gen.py 移植）：没有模型文件、参考图本身是体素/像素风时，用基本形逐格写场景。
// 场景 = 普通 JS 模块 export function build(v)，方法与上游一致：put/box/ellipsoid/revolve/tube/repaint。
// 不用随机数：hash01 是坐标的确定函数，同场景重跑必然同结果（改一处验一次的流程才成立）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function hash01(x, y, z, salt = 0) {
  let n = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(salt, 2654435761)) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0
  return ((n ^ (n >>> 16)) & 0xffff) / 65535
}

export class Vox {
  constructor() {
    this.cells = new Map()
    // hash01 挂在实例上：场景文件保持零 import（场景经动态 import 加载，相对路径解析在模型目录，够不到插件 lib）
    this.hash01 = hash01
  }

  put(x, y, z, c, overwrite = true) {
    const k = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
    if (overwrite || !this.cells.has(k)) this.cells.set(k, c)
  }

  /** 闭区间实心块 */
  box(x0, y0, z0, x1, y1, z1, c) {
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
      for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
        for (let z = Math.floor(z0); z <= Math.floor(z1); z++) this.put(x, y, z, c)
      }
    }
  }

  insideEllipsoid(x, y, z, cx, cy, cz, rx, ry, rz) {
    const px = x + 0.5, py = y + 0.5, pz = z + 0.5
    return ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 + ((pz - cz) / rz) ** 2 <= 1
  }

  ellipsoid(cx, cy, cz, rx, ry, rz, c) {
    for (let x = Math.floor(cx - rx) - 1; x <= Math.floor(cx + rx) + 2; x++) {
      for (let y = Math.floor(cy - ry) - 1; y <= Math.floor(cy + ry) + 2; y++) {
        for (let z = Math.floor(cz - rz) - 1; z <= Math.floor(cz + rz) + 2; z++) {
          if (this.insideEllipsoid(x, y, z, cx, cy, cz, rx, ry, rz)) this.put(x, y, z, c)
        }
      }
    }
  }

  /** 由上往下的半径剖面 → 旋转体。color(x,y,z,d,r,i) 回调返回色名，i=0 是顶面。 */
  revolve(cx, cz, radii, topY, color) {
    radii.forEach((r, i) => {
      const y = topY - i
      const rr = Math.ceil(r)
      for (let x = Math.floor(cx - rr); x <= Math.ceil(cx + rr) + 1; x++) {
        for (let z = Math.floor(cz - rr); z <= Math.ceil(cz + rr) + 1; z++) {
          const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz)
          if (d > r) continue
          this.put(x, y, z, typeof color === 'function' ? color(x, y, z, d, r, i) : color)
        }
      }
    })
  }

  /** 沿节点铺粗管（曼哈顿距离 ≤ radius）；radius=0 是逐格线。 */
  tube(path, radius, c) {
    for (const [px, py, pz] of path) {
      const x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz)
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= radius) this.put(x + dx, y + dy, z + dz, c)
          }
        }
      }
    }
  }

  /** 只换色不动几何。pred(x,y,z)；only 限定原色集合。 */
  repaint(pred, c, only = null) {
    for (const [k, old] of [...this.cells.entries()]) {
      if (only && !only.includes(old)) continue
      const [x, y, z] = k.split(',').map(Number)
      if (pred(x, y, z)) this.cells.set(k, c)
    }
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (const k of this.cells.keys()) {
      const [x, y, z] = k.split(',').map(Number)
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (z < z0) z0 = z
      if (x > x1) x1 = x
      if (y > y1) y1 = y
      if (z > z1) z1 = z
    }
    return [x0, y0, z0, x1, y1, z1]
  }

  /** 平移到非负坐标 → volume.json 形状（与 vox.py 同格式） */
  toVolume({ up = 1, front = 2, cam = 1 } = {}) {
    const [x0, y0, z0, x1, y1, z1] = this.bounds()
    if (!this.cells.size) throw new Error('场景没有产出任何格子')
    const cells = [...this.cells.entries()]
      .map(([k, c]) => {
        const [x, y, z] = k.split(',').map(Number)
        return [x - x0, y - y0, z - z0, c]
      })
      .sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]) || (p[2] - q[2]))
    return { nx: x1 - x0 + 1, ny: y1 - y0 + 1, nz: z1 - z0 + 1, up, front, cam, cells }
  }

  stats() {
    const colors = new Map()
    for (const c of this.cells.values()) colors.set(c, (colors.get(c) || 0) + 1)
    return { cells: this.cells.size, colors }
  }
}

/** 运行场景文件（JS 模块 export function build(v)）→ volume 对象。 */
export async function runScene(scenePath, opts = {}) {
  const mod = await import(pathToFileURL(scenePath).href)
  if (typeof mod.build !== 'function') throw new Error('场景文件必须 export function build(v)')
  const v = new Vox()
  await mod.build(v, opts)
  return v.toVolume(opts)
}

/** 生成并落盘（工具/面板入口）。返回 { volume, stats }。 */
export async function generateScene(scenePath, outPath, opts = {}) {
  const v = new Vox()
  const mod = await import(pathToFileURL(scenePath).href)
  if (typeof mod.build !== 'function') throw new Error('场景文件必须 export function build(v)')
  await mod.build(v, opts)
  const volume = v.toVolume(opts)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(volume))
  return { volume, stats: v.stats(), outPath }
}
