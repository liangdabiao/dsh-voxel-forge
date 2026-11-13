// 体素切片单测：L 形空腔/双色分区/确定性、验证球、去噪开关
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { synthGlb, loadGlb, extractMesh } from '../lib/glb.js'
import { voxelize, voxelizeGlbFile, makeBall, MERGE_DEFAULT } from '../lib/voxelize.js'

const tmp = mkdtempSync(join(tmpdir(), 'vox-vox-'))

const makeL = () => {
  const glb = synthGlb({
    texSize: 4,
    texFn: (u) => (u < 0.5 ? [200, 30, 25] : [35, 120, 60]), // 左红右绿
    boxes: [
      { c: [0, 0.5, 0], s: [2, 1, 1], uvr: [0, 0, 0.4, 0.4], subdiv: 16 },
      { c: [0.5, 1.5, 0], s: [1, 1, 1], uvr: [0.6, 0.6, 1, 1], subdiv: 16 },
    ],
  })
  const file = join(tmp, 'l.glb')
  writeFileSync(file, glb)
  return file
}

test('voxelize：L 形双色分区 + 空腔 + 确定性', () => {
  const file = makeL()
  const v1 = voxelizeGlbFile(file, { courses: 32, denoise: 0 })
  const colors = new Set(v1.cells.map((c) => c[3]))
  assert.equal(colors.size, 2)
  assert.ok(colors.has('Red') && colors.has('Green'))
  // 凹角空腔：顶盒只占 x 的右半（cx=0.5, sx=1 → x∈[0,1]），左上方（x<-0.5, y>1）必须是空的
  const grid = new Set(v1.cells.map((c) => `${c[0]},${c[1]},${c[2]}`))
  // 找一个左上区坐标：x∈[0, 0.2*nx)，y∈[0.75*ny, ny)，z 中部
  const zx = Math.floor(v1.nz / 2)
  let hollow = true
  for (let a = 0; a < Math.floor(v1.nx * 0.2); a++) {
    for (let b = Math.floor(v1.ny * 0.8); b < v1.ny; b++) {
      if (grid.has(`${a},${b},${zx}`)) hollow = false
    }
  }
  assert.ok(hollow, '凹角区域被填实（洪泛判内外失败）')
  // 确定性：重跑同参数同结果
  const v2 = voxelizeGlbFile(file, { courses: 32, denoise: 0 })
  assert.equal(v1.cells.length, v2.cells.length)
  assert.deepEqual(v1.cells[0], v2.cells[0])
})

test('voxelize：方向仓与 up/front 轴', () => {
  const file = makeL()
  const v = voxelizeGlbFile(file, { courses: 32 })
  // L 形 x/y ext 相等（并列 tie → 取先者），up 可能是 0 或 1；courses 落在 up 轴
  assert.ok(v.up === 0 || v.up === 1)
  const dims = [v.nx, v.ny, v.nz]
  assert.equal(dims[v.up], 32)
  assert.ok([0, 1, 2].includes(v.front))
})

test('makeBall：24 层（上下边缘层近似空）每层一色', () => {
  const b = makeBall()
  assert.equal(b.ny, 24)
  assert.equal(b.nx, 24)
  const layerColor = new Map()
  for (const [, y, , c] of b.cells) {
    if (!layerColor.has(y)) layerColor.set(y, c)
    assert.equal(layerColor.get(y), c) // 每层单色
  }
  assert.ok(layerColor.size >= 22 && layerColor.size <= 24)
  const keys = new Set(b.cells.map((c) => c.slice(0, 3).join(',')))
  assert.ok(keys.has('12,12,12'))
  assert.ok(!keys.has('0,0,0'))
})

test('voxelize：denoise=0 与 merge=none 参数通路', () => {
  const file = makeL()
  const v = voxelizeGlbFile(file, { courses: 24, denoise: 0, merge: 'none', absorb: 0 })
  assert.ok(v.cells.length > 100)
})

test('MERGE_DEFAULT 材质分组', () => {
  assert.deepEqual(MERGE_DEFAULT.Red, ['Dark Red', 'Orange', 'Dark Orange'])
  assert.ok(MERGE_DEFAULT['Bright Light Orange'].includes('Tan'))
})
