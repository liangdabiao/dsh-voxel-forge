// ops + store + host 工具全链单测（离线）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { synthGlb } from '../lib/glb.js'
import { sanitizeName, writeJsonAtomic, journal, readJournal } from '../lib/util.js'

const tmp = mkdtempSync(join(tmpdir(), 'vox-ops-'))
process.env.DSH_HOME = tmp

test('util：名称净化 + journal 读写', () => {
  assert.equal(sanitizeName('我的 模型/v2?.glb'), '我的-模型-v2-glb')
  assert.equal(sanitizeName('///'), 'model')
  assert.equal(sanitizeName(''), 'model')
  const dir = join(tmp, 'j')
  writeJsonAtomic(join(dir, 'a.json'), { x: 1 })
  assert.equal(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).x, 1)
  journal(dir, { action: 't', ok: true, summary: 's' })
  journal(dir, { action: 't2', ok: false, summary: 's2' })
  assert.equal(readJournal(dir).length, 2)
})

test('ops：上传→切片→装配→详情全链', async () => {
  const { uploadModel, sliceModel, buildModel, modelDetail, listModels, downscaleModel, previewModel, probeModel, readOut } = await import('../lib/ops.js')
  const { DATA_DIR, modelDir } = await import('../lib/store.js')
  assert.ok(DATA_DIR.includes('voxel-forge'))
  const cfg = {}
  const glb = synthGlb({
    texSize: 4,
    texFn: (u) => (u < 0.5 ? [200, 30, 25] : [35, 120, 60]),
    boxes: [
      { c: [0, 0.5, 0], s: [2, 1, 1], uvr: [0, 0, 0.4, 0.4], subdiv: 12 },
      { c: [0.5, 1.5, 0], s: [1, 1, 1], uvr: [0.6, 0.6, 1, 1], subdiv: 12 },
    ],
  })
  const up = uploadModel(cfg, '链路模型', 'chain.glb', glb, { title: '链路模型标题' })
  assert.equal(up.name, '链路模型')
  const sl = sliceModel(cfg, '链路模型', { courses: 24 })
  assert.ok(sl.ok && sl.volume.cells.length > 500)
  assert.ok(existsSync(join(modelDir(cfg, '链路模型'), 'volume.json')))
  assert.ok(existsSync(join(modelDir(cfg, '链路模型'), 'previews', 'view_front.png')))
  const bd = await buildModel(cfg, '链路模型')
  assert.ok(bd.v >= 1 && bd.stats.parts > 50)
  assert.ok(existsSync(join(modelDir(cfg, '链路模型'), 'out', 'set.html')))
  assert.ok(existsSync(join(modelDir(cfg, '链路模型'), 'out', 'model.ldr')))
  assert.ok(existsSync(join(modelDir(cfg, '链路模型'), 'vox.json')))
  const det = modelDetail(cfg, '链路模型')
  assert.equal(det.meta.title, '链路模型标题')
  assert.equal(det.versions.length, 1)
  assert.equal(det.volume.colors.length, 2)
  const ds = downscaleModel(cfg, '链路模型', { factor: 2 })
  assert.ok(ds.ok)
  assert.ok(existsSync(join(modelDir(cfg, '链路模型'), `volume.${sl.volume.ny}layer.bak.json`)))
  const pv = previewModel(cfg, '链路模型', { px: 5 })
  assert.ok(pv.ok)
  const pb = probeModel(cfg, '链路模型', { layers: '0:5', cols: '0:10' })
  assert.ok(pb.text.includes('正面 ASCII'))
  const rep = readOut(cfg, '链路模型', 'report')
  assert.ok(rep.includes('parts'))
  assert.ok(listModels(cfg).some((m) => m.name === '链路模型'))
})

test('ops：错误路径', async () => {
  const { sliceModel, readOut, uploadModel } = await import('../lib/ops.js')
  assert.throws(() => sliceModel({}, '没有这个'), /model\.glb/)
  assert.throws(() => readOut({}, '没有这个', 'report'), /report\.txt/)
  assert.throws(() => uploadModel({}, 'x', 'a.obj', Buffer.from('xx')), /只支持/)
  assert.throws(() => readOut({}, '链路模型', '不存在的which'), /which 只支持/)
})

test('ops：参考图路线（上传图片 → 详情 has_ref → 工具 read ref）', async () => {
  const { uploadRefImage, refFile, modelDetail, listModels } = await import('../lib/ops.js')
  const { modelDir } = await import('../lib/store.js')
  const cfg = {}
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const r = uploadRefImage(cfg, '蓝鲸参考图', 'whale.png', png, { title: '蓝鲸浮岛' })
  assert.equal(r.name, '蓝鲸参考图')
  assert.ok(r.refPath.endsWith('ref.png'))
  assert.ok(existsSync(join(modelDir(cfg, '蓝鲸参考图'), 'ref', 'ref.png')))
  const det = modelDetail(cfg, '蓝鲸参考图')
  assert.equal(det.meta.source, 'image')
  assert.equal(det.has_ref, true)
  assert.equal(det.ref.rel, 'ref/ref.png')
  assert.equal(det.has_glb, false)
  assert.equal(refFile(cfg, '蓝鲸参考图'), r.refPath)
  const ls = listModels(cfg)
  const item = ls.find((m) => m.name === '蓝鲸参考图')
  assert.equal(item.source, 'image')
  assert.equal(item.has_ref, true)
  // 参考图扩展名校验 + 工具分流
  assert.throws(() => uploadRefImage(cfg, 'x', 'a.gif', png), /参考图只支持/)
  const { voxelForgeTool } = await import('../src/host.js')
  const call = (args) => voxelForgeTool.execute(args, {})
  const p = join(tmp, 'ref-tool.png')
  writeFileSync(p, png)
  const up = await call({ action: 'upload', name: '工具参考图', path: p })
  assert.ok(up.ok && up.summary.includes('read_image'), up.summary)
  const ref = await call({ action: 'read', name: '工具参考图', what: 'ref' })
  assert.ok(ref.ok && /ref\.png$/.test(ref.data.trim()), ref.data)
  const none = await call({ action: 'read', name: '链路模型', what: 'ref' })
  assert.equal(none.ok, false)
})

test('host 工具直调：upload/slice/build/read/list/delete', async () => {
  const glbFile = join(tmp, 't.glb')
  writeFileSync(glbFile, synthGlb({ size: 1.5, rgb: [245, 205, 60], subdiv: 12 }))
  const { voxelForgeTool } = await import('../src/host.js')
  const call = (args) => voxelForgeTool.execute(args, {})
  const up = await call({ action: 'upload', name: '工具模型', path: glbFile })
  assert.ok(up.ok && up.summary.includes('KB'))
  await assert.rejects(() => call({ action: 'slice', name: '工具模型', 未知参数: 1 }), /未知参数/)
  const sl = await call({ action: 'slice', name: '工具模型', courses: 20 })
  assert.ok(sl.ok && sl.summary.includes('层'))
  const bd = await call({ action: 'build', name: '工具模型' })
  assert.ok(bd.summary.includes('件'))
  const meta = await call({ action: 'read', name: '工具模型', what: 'meta' })
  assert.ok(meta.ok && meta.data.includes('volume'))
  const versions = await call({ action: 'read', name: '工具模型', what: 'versions' })
  assert.ok(versions.data.includes('v1'))
  const ls = await call({ action: 'list' })
  assert.ok(ls.data.includes('工具模型'))
  const del = await call({ action: 'delete', name: '工具模型' })
  assert.ok(del.ok)
  const after = await call({ action: 'list' })
  assert.ok(!after.data.includes('工具模型'))
})
