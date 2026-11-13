// preview/probe/downscale/genvox 单测
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { makeBall } from '../lib/voxelize.js'
import { renderPreview } from '../lib/preview.js'
import { probeStats, probeLayers, probeProfile } from '../lib/probe.js'
import { downscale } from '../lib/downscale.js'
import { Vox, runScene, generateScene, hash01 } from '../lib/genvox.js'

const tmp = mkdtempSync(join(tmpdir(), 'vox-pipe-'))

test('renderPreview：三视图 + 分层图 PNG 落盘且尺寸正确', () => {
  const vol = makeBall()
  const out = join(tmp, 'prev')
  const r = renderPreview(vol, out, { px: 4, floors: 4 })
  for (const key of ['view_front', 'view_back', 'view_side', 'layers']) {
    assert.ok(existsSync(r.files[key]), key + ' 缺失')
  }
  const png = PNG.sync.read(readFileSync(r.files.view_front))
  assert.equal(png.width, 24 * 4)
  assert.equal(png.height, 24 * 4)
  // 有非白像素（球画上去了）
  let colored = 0
  for (let i = 0; i < png.width * png.height; i++) {
    if (png.data[i * 4] !== 255 || png.data[i * 4 + 1] !== 255) colored++
  }
  assert.ok(colored > 100)
})

test('probe：stats/layers/profile', () => {
  const vol = makeBall()
  const stats = probeStats(vol)
  assert.ok(stats.includes('grid 24 x 24 x 24'))
  assert.ok(stats.includes('整体颜色'))
  assert.ok(stats.includes('layer'))
  const layers = probeLayers(vol, [10, 14], [8, 18])
  assert.ok(layers.includes('正面 ASCII'))
  assert.ok(layers.split('\n').length > 4)
  const profile = probeProfile(vol, 12, 12)
  assert.ok(profile.includes('深度剖面 a=12 b=12'))
  assert.ok(profile.includes('最前 = z='))
})

test('downscale：2× 归并，众数定色，尺寸 ceil', () => {
  const vol = makeBall()
  const s = downscale(vol, { factor: 2 })
  assert.equal(s.nx, 12)
  assert.equal(s.ny, 12)
  assert.equal(s.nz, 12)
  assert.ok(s.cells.length < vol.cells.length / 2)
  // 无 1 格宽断层的坐标越界
  for (const [x, y, z] of s.cells) {
    assert.ok(x < 12 && y < 12 && z < 12)
  }
  const s4 = downscale(vol, { factor: 4 })
  assert.equal(s4.nx, 6)
})

test('genvox：基本形 + hash01 确定性 + 场景文件', () => {
  const v = new Vox()
  v.box(0, 0, 0, 3, 3, 3, 'Red')
  v.ellipsoid(1.5, 6, 1.5, 2, 2, 2, 'Green')
  v.revolve(1.5, 1.5, [3, 2], 2, () => 'Tan')
  v.tube([[1, 6, 1], [1, 9, 1]], 0, 'Blue')
  v.repaint((x, y) => y === 0, 'Dark Tan')
  assert.equal(hash01(1, 2, 3), hash01(1, 2, 3))
  assert.notEqual(hash01(1, 2, 3), hash01(1, 2, 4))
  const vol = v.toVolume()
  assert.equal(vol.ny, 10) // tube 到 y=9
  const colors = new Set(vol.cells.map((c) => c[3]))
  assert.ok(colors.has('Dark Tan')) // repaint 生效
  assert.ok(colors.has('Blue'))
})

test('genvox：场景模块运行 + 落盘', async () => {
  const scene = join(tmp, 'scene.mjs')
  writeFileSync(scene, `export function build(v) {
  v.box(0, 0, 0, 5, 2, 5, 'Green')
  v.put(2, 3, 2, 'Red')
}
`)
  const out = join(tmp, 'gen', 'volume.json')
  const r = await generateScene(scene, out)
  assert.equal(r.volume.cells.length, 6 * 3 * 6 + 1)
  assert.ok(existsSync(out))
  const back = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(back.nx, 6)
  const viaRun = await runScene(scene)
  assert.equal(viaRun.cells.length, r.volume.cells.length)
})

test('genvox：空场景报错、非 build 导出报错', async () => {
  const empty = join(tmp, 'empty.mjs')
  writeFileSync(empty, 'export function build(v) {}\n')
  await assert.rejects(() => runScene(empty), /没有产出任何格子/)
  const noBuild = join(tmp, 'nobuild.mjs')
  writeFileSync(noBuild, 'export const x = 1\n')
  await assert.rejects(() => runScene(noBuild), /export function build/)
})
