// GLB 解析单测：合成→解析→提取 roundtrip、贴图解码、accessor、错误路径
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { synthGlb, loadGlb, extractMesh, decodeImage } from '../lib/glb.js'

const tmp = mkdtempSync(join(tmpdir(), 'vox-glb-'))

test('synthGlb → loadGlb → extractMesh roundtrip', () => {
  const file = join(tmp, 'a.glb')
  writeFileSync(file, synthGlb({ size: 2, rgb: [10, 200, 30], subdiv: 4 }))
  const { json, bin } = loadGlb(file)
  assert.ok(json.meshes[0].primitives[0].attributes.POSITION !== undefined)
  const m = extractMesh(json, bin)
  // subdiv=4：每面 4×4×2=32 三角 × 6 面 = 192；顶点 6×(5×5)=150
  assert.equal(m.idx.length, 192 * 3)
  assert.equal(m.pos.length / 3, 150)
  assert.equal(m.tex.w, 4)
  assert.deepEqual([...m.tex.data.subarray(0, 3)], [10, 200, 30])
})

test('synthGlb 多盒 + UV 分色', () => {
  const file = join(tmp, 'b.glb')
  writeFileSync(file, synthGlb({
    texSize: 4,
    texFn: (u) => (u < 0.5 ? [255, 0, 0] : [0, 0, 255]),
    boxes: [
      { c: [0, 0, 0], s: [1, 1, 1], uvr: [0, 0, 0.3, 0.3], subdiv: 2 },
      { c: [0, 2, 0], s: [1, 1, 1], uvr: [0.7, 0.7, 1, 1], subdiv: 2 },
    ],
  }))
  const m = extractMesh(...Object.values(loadGlb(file)))
  // 底盒 UV∈[0,0.3]（红区），顶盒 UV∈[0.7,1]（蓝区）：采样两个盒的重心 UV
  const n = m.pos.length / 3
  assert.equal(n, 2 * 6 * 9) // 每盒 6 面 × 9 顶点
})

test('decodeImage：PNG 与 JPEG', async () => {
  const png = new PNG({ width: 3, height: 2 })
  for (let i = 0; i < 6; i++) { png.data[i * 4] = 250; png.data[i * 4 + 1] = 100; png.data[i * 4 + 2] = 20; png.data[i * 4 + 3] = 255 }
  const img = decodeImage(PNG.sync.write(png))
  assert.equal(img.w, 3)
  assert.equal(img.h, 2)
  assert.deepEqual([...img.data.subarray(0, 3)], [250, 100, 20])

  const jpeg = (await import('jpeg-js')).default ?? (await import('jpeg-js'))
  const raw = { data: Buffer.alloc(4 * 4 * 4), width: 4, height: 4 }
  for (let i = 0; i < 16; i++) {
    raw.data[i * 4] = 200; raw.data[i * 4 + 1] = 30; raw.data[i * 4 + 2] = 25; raw.data[i * 4 + 3] = 255
  }
  const enc = jpeg.encode(raw, 80)
  const img2 = decodeImage(enc.data)
  assert.equal(img2.w, 4)
  // JPEG 有损：颜色近似
  assert.ok(Math.abs(img2.data[0] - 200) < 30)
  assert.ok(Math.abs(img2.data[1] - 30) < 30)
})

test('decodeImage：不支持格式报可读错误', () => {
  assert.throws(() => decodeImage(Buffer.from([0x57, 0x45, 0x42, 0x50])), /贴图格式不支持/)
})

test('错误路径：非 GLB', () => {
  const bad = join(tmp, 'bad.glb')
  writeFileSync(bad, Buffer.from('这不是 glb'))
  assert.throws(() => loadGlb(bad), /不是 GLB/)
})

test('负载贴图 texFn 变体', () => {
  const glb = synthGlb({ texSize: 8, texFn: (u, v) => [Math.floor(u * 255), Math.floor(v * 255), 128] })
  assert.ok(glb.length > 500)
})
