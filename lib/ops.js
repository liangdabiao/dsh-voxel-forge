// 业务操作：切片 / 程序化生成 / 装配 / 预览 / 体检 / 缩放 / 降采样 / 读产物。
// 工具（src/host.js）与面板（lib/api.js）共用这一层，保证对话与面板是同一份数据。
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelDir, readMeta, saveMeta, journal, readJournal, listModels, createModel, deleteModel, saveUpload, saveRefImage } from './store.js'
import { voxelizeGlbFile, makeBall } from './voxelize.js'
import { renderPreview } from './preview.js'
import { probeStats, probeLayers, probeProfile } from './probe.js'
import { downscale } from './downscale.js'
import { generateScene, runScene } from './genvox.js'
import { assembleVolume, listVersions, readVersion } from './assemble.js'
import { writeJsonAtomic, sanitizeName } from './util.js'

export { listModels, createModel, deleteModel, readMeta, saveMeta, journal, readJournal, listVersions, readVersion, modelDir, makeBall }

const readVolume = (dir) => JSON.parse(readFileSync(join(dir, 'volume.json'), 'utf8'))
const writeVolume = (dir, volume) => writeJsonAtomic(join(dir, 'volume.json'), volume)

function sliceOpts(opts = {}) {
  const o = {}
  if (opts.courses !== undefined) o.courses = Number(opts.courses)
  if (opts.ratio !== undefined) o.ratio = Number(opts.ratio)
  if (opts.denoise !== undefined) o.denoise = Number(opts.denoise)
  if (opts.absorb !== undefined) o.absorb = Number(opts.absorb)
  if (opts.darkdetail !== undefined) o.darkdetail = Number(opts.darkdetail)
  if (opts.merge !== undefined) o.merge = opts.merge
  if (opts.palette !== undefined && opts.palette && typeof opts.palette === 'object') o.palette = opts.palette
  return o
}

/** 上传 GLB → 建模型目录（面板上传入口 / 工具入口共用）。 */
export function uploadModel(config, name, filename, buffer, { title } = {}) {
  if (!/\.(glb|gltf)$/i.test(String(filename || ''))) throw new Error('只支持 .glb / .gltf 文件（其他格式请先转 GLB）')
  const created = createModel(config, name, { title: title || sanitizeName(name), source: 'glb' })
  saveUpload(config, created.name, buffer)
  saveMeta(config, created.name, { source_file: filename, source: 'glb', glb_bytes: buffer.length })
  journal(created.dir, { action: 'upload', ok: true, summary: `上传 ${filename}（${(buffer.length / 1024).toFixed(0)} KB）` })
  return { ok: true, name: created.name, bytes: buffer.length, dir: created.dir }
}

/** 上传参考图 → 建模型目录（体素风/像素风参考图路线；由 agent 看图写 scene）。 */
export function uploadRefImage(config, name, filename, buffer, { title } = {}) {
  const created = createModel(config, name, { title: title || sanitizeName(name), source: 'image' })
  const saved = saveRefImage(config, created.name, filename, buffer)
  saveMeta(config, created.name, {
    source: 'image', source_file: filename, ref_file: saved.rel.split('/').pop(),
    ref_bytes: buffer.length,
  })
  journal(created.dir, { action: 'upload-ref', ok: true, summary: `上传参考图 ${filename}（${(buffer.length / 1024).toFixed(0)} KB）` })
  return { ok: true, name: created.name, bytes: buffer.length, dir: created.dir, refPath: saved.file, refRel: saved.rel }
}

/** 参考图绝对路径（没有就返回 null）。 */
export function refFile(config, name) {
  const dir = modelDir(config, name)
  const meta = readMeta(config, name)
  if (!meta?.ref_file) return null
  const file = join(dir, 'ref', meta.ref_file)
  return existsSync(file) ? file : null
}

/** 切片：model.glb → volume.json → 验收图。返回 summary 文本。 */
export function sliceModel(config, name, opts = {}) {
  const dir = modelDir(config, name)
  const glb = join(dir, 'model.glb')
  if (!existsSync(glb)) throw new Error(`模型「${name}」还没有 model.glb（先在面板上传，或把文件放 ${glb}）`)
  const o = sliceOpts(opts)
  const logs = []
  const t0 = Date.now()
  const volume = voxelizeGlbFile(glb, { ...o, log: (m) => logs.push(m) })
  writeVolume(dir, volume)
  const prev = renderPreview(volume, join(dir, 'previews'), { px: opts.px || Math.max(4, Math.floor(160 / Math.max(volume.nx, volume.ny, volume.nz)) * 2), floors: opts.floors || 8 })
  saveMeta(config, name, { courses: volume.ny, cells: volume.cells.length, sliced_at: new Date().toISOString(), slice_opts: o })
  journal(dir, { action: 'slice', ok: true, summary: `切片 ${volume.cells.length} 格（${volume.nx}×${volume.ny}×${volume.nz}，${volume.ny} 层），用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` })
  return {
    ok: true, volume,
    summary: `切片完成：${volume.nx}×${volume.ny}×${volume.nz}（${volume.ny} 层），${volume.cells.length} 格，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s。验收图已生成（previews/view_front|back|side.png + layers.png）。`,
    logs,
    previews: prev.files,
  }
}

/** 程序化生成：scene.mjs → volume.json → 验收图。 */
export async function genModel(config, name, opts = {}) {
  const dir = modelDir(config, name)
  const scene = join(dir, 'scene.mjs')
  if (!existsSync(scene)) throw new Error(`模型「${name}」还没有 scene.mjs（程序化路线先让 agent 写场景文件，或 action=scene 保存）`)
  const t0 = Date.now()
  const volume = await runScene(scene, opts)
  writeVolume(dir, volume)
  const prev = renderPreview(volume, join(dir, 'previews'), { px: opts.px || Math.max(4, Math.floor(160 / Math.max(volume.nx, volume.ny, volume.nz)) * 2), floors: opts.floors || 8 })
  saveMeta(config, name, { courses: volume.ny, cells: volume.cells.length, generated_at: new Date().toISOString() })
  journal(dir, { action: 'gen', ok: true, summary: `程序化生成 ${volume.cells.length} 格（${volume.nx}×${volume.ny}×${volume.nz}）` })
  return { ok: true, volume, previews: prev.files, summary: `生成完成：${volume.nx}×${volume.ny}×${volume.nz}（${volume.ny} 层），${volume.cells.length} 格。` }
}

/** 保存场景文件（程序化路线）。有参考图的模型保留 source='image'，面板才能继续标「图片参考」。 */
export function saveScene(config, name, code, { title } = {}) {
  const dir = modelDir(config, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scene.mjs'), code, 'utf8')
  const prevSource = readMeta(config, name)?.ref_file ? 'image' : 'scene'
  const created = saveMeta(config, name, { title: title || name, source: prevSource })
  journal(dir, { action: 'scene', ok: true, summary: `保存场景文件（${code.split('\n').length} 行）` })
  return { ok: true, name: created.name, dir }
}

/** 装配：volume.json → out/（set.html/ldr/csv/report）+ 版本快照。 */
export async function buildModel(config, name, opts = {}) {
  const dir = modelDir(config, name)
  if (!existsSync(join(dir, 'volume.json'))) throw new Error(`模型「${name}」还没有 volume.json（先切片或生成）`)
  const volume = readVolume(dir)
  const meta = readMeta(config, name)
  const t0 = Date.now()
  const result = await assembleVolume(dir, volume, { title: meta?.title || name, keepVersions: config?.keepVersions })
  saveMeta(config, name, { last_build: { v: result.v, ok: result.ok, stats: result.stats, at: new Date().toISOString() } })
  journal(dir, { action: 'build', ok: result.ok, summary: result.summary })
  return { ...result, seconds: ((Date.now() - t0) / 1000).toFixed(1), dir }
}

/** 重新生成验收图（px/floors 可调）。 */
export function previewModel(config, name, opts = {}) {
  const dir = modelDir(config, name)
  if (!existsSync(join(dir, 'volume.json'))) throw new Error(`模型「${name}」还没有 volume.json`)
  const volume = readVolume(dir)
  const prev = renderPreview(volume, join(dir, 'previews'), { px: opts.px || 9, floors: opts.floors || 8 })
  journal(dir, { action: 'preview', ok: true, summary: `重新出验收图（px=${opts.px || 9}）` })
  return { ok: true, files: prev.files, summary: '验收图已生成：三视图 + 分层图。' }
}

/** 体检：stats / ASCII 色图 / 深度剖面（文本）。 */
export function probeModel(config, name, opts = {}) {
  const dir = modelDir(config, name)
  if (!existsSync(join(dir, 'volume.json'))) throw new Error(`模型「${name}」还没有 volume.json`)
  const volume = readVolume(dir)
  const out = []
  if (opts.stats) out.push(probeStats(volume))
  if (opts.layers) {
    const [b0, b1] = String(opts.layers).split(':').map(Number)
    const cols = opts.cols ? String(opts.cols).split(':').map(Number) : [0, volume.nx]
    out.push(probeLayers(volume, [b0, b1], cols))
  }
  if (opts.profile) {
    const [a, b] = String(opts.profile).split(',').map(Number)
    out.push(probeProfile(volume, a, b))
  }
  if (!out.length) out.push(probeStats(volume))
  journal(dir, { action: 'probe', ok: true, summary: `体检（${opts.stats ? 'stats ' : ''}${opts.layers ? 'layers ' : ''}${opts.profile ? 'profile' : ''}）` })
  return { ok: true, text: out.join('\n\n'), summary: '体检完成（stats/layers/profile 见正文）' }
}

/** 缩放：N×N×N 归并。覆盖 volume.json 前先备份到 volume.<ny>layer.json（可回退）。 */
export function downscaleModel(config, name, opts = {}) {
  const dir = modelDir(config, name)
  const file = join(dir, 'volume.json')
  if (!existsSync(file)) throw new Error(`模型「${name}」还没有 volume.json`)
  const volume = readVolume(dir)
  const backup = join(dir, `volume.${volume.ny}layer.bak.json`)
  if (!existsSync(backup)) writeJsonAtomic(backup, volume)
  const scaled = downscale(volume, { factor: opts.factor || 2 })
  writeVolume(dir, scaled)
  const prev = renderPreview(scaled, join(dir, 'previews'), { px: opts.px || 9, floors: Math.min(8, scaled.ny) })
  saveMeta(config, name, { courses: scaled.ny, cells: scaled.cells.length })
  journal(dir, { action: 'downscale', ok: true, summary: `缩放 factor=${opts.factor || 2}：${volume.cells.length} → ${scaled.cells.length} 格（${scaled.ny} 层；备份 ${backup}）` })
  return {
    ok: true, volume: scaled, previews: prev.files,
    summary: `缩放完成：${volume.cells.length} → ${scaled.cells.length} 格（${scaled.nx}×${scaled.ny}×${scaled.nz}）。备份在 volume.${volume.ny}layer.bak.json。注意：1 格宽细结构会变粗或断开，交付时主动说明。`,
  }
}

/** 读模型详情（工具 read / 面板 detail 共用）。 */
export function modelDetail(config, name) {
  const dir = modelDir(config, name)
  if (!existsSync(dir)) return null
  const meta = readMeta(config, name)
  const volumeFile = join(dir, 'volume.json')
  const volume = existsSync(volumeFile) ? readVolume(dir) : null
  const versions = listVersions(dir).map((x) => {
    const head = readVersion(dir, x.v)
    return { v: x.v, ts: head?.ts, ok: head?.ok, parts: head?.stats?.parts ?? null, title: head?.title }
  }).reverse()
  const colors = volume ? [...volume.cells.reduce((m, c) => m.set(c[3], (m.get(c[3]) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1]) : []
  const ref = refFile(config, name)
  return {
    name, meta,
    has_glb: existsSync(join(dir, 'model.glb')),
    has_scene: existsSync(join(dir, 'scene.mjs')),
    has_ref: Boolean(ref),
    ref: ref ? { rel: join('ref', meta.ref_file).replace(/\\/g, '/'), path: ref, bytes: meta.ref_bytes || null, source_file: meta.source_file || null } : null,
    has_volume: Boolean(volume),
    has_vox: existsSync(join(dir, 'vox.json')),
    volume: volume ? { nx: volume.nx, ny: volume.ny, nz: volume.nz, cells: volume.cells.length, up: volume.up, front: volume.front, colors } : null,
    versions,
    journal: readJournal(dir, 60),
    out: existsSync(join(dir, 'out')) ? {
      set_html: join(dir, 'out', 'set.html'),
      ldr: join(dir, 'out', 'model.ldr'),
      csv: join(dir, 'out', 'parts.csv'),
      report: join(dir, 'out', 'report.txt'),
    } : null,
    previews: existsSync(join(dir, 'previews')) ? {
      front: join(dir, 'previews', 'view_front.png'),
      back: join(dir, 'previews', 'view_back.png'),
      side: join(dir, 'previews', 'view_side.png'),
      layers: join(dir, 'previews', 'layers.png'),
    } : null,
  }
}

/** 读文本产物（report/ldr/csv/scene 之一）。 */
export function readOut(config, name, which) {
  const dir = modelDir(config, name)
  const map = { report: 'out/report.txt', ldr: 'out/model.ldr', csv: 'out/parts.csv', check: 'out/check.json', scene: 'scene.mjs' }
  const rel = map[which]
  if (!rel) throw new Error(`which 只支持 ${Object.keys(map).join('/')}`)
  const file = join(dir, rel)
  if (!existsSync(file)) throw new Error(`模型「${name}」还没有 ${rel}（先跑对应步骤）`)
  return readFileSync(file, 'utf8')
}
