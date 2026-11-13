// 体素工坊 · 数据层。
//   $DSH_HOME/voxel-forge/
//   └── <name>/
//       ├── model.glb        上传的 3D 文件（切片路线）
//       ├── ref/ref.<ext>    上传的参考图（体素风/像素风图 → agent 看图写场景，程序化路线）
//       ├── scene.mjs        程序化场景（生成路线）
//       ├── volume.json      体素数据 {nx,ny,nz,up,front,cam,cells}
//       ├── project.json     元数据（标题/来源/最近操作/最近版本）
//       ├── previews/        view_front/back/side.png + layers.png（验收图）
//       ├── out/             set.html / model.ldr / parts.csv / report.txt / check.json
//       ├── vox.json         体素快照（面板 3D 对照）
//       ├── versions/        每次装配的版本快照
//       └── journal.jsonl    过程时间线
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeName, writeJsonAtomic, journal, readJournal } from './util.js'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'voxel-forge')

export function modelsRoot(config) {
  const root = config?.setsRoot || DATA_DIR
  mkdirSync(root, { recursive: true })
  return root
}

export function modelDir(config, name) {
  const safe = sanitizeName(name)
  return join(modelsRoot(config), safe)
}

export function readMeta(config, name) {
  const file = join(modelDir(config, name), 'project.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export function saveMeta(config, name, patch) {
  const dir = modelDir(config, name)
  mkdirSync(dir, { recursive: true })
  const next = { name, ...(readMeta(config, name) || {}), ...patch, updated_at: new Date().toISOString() }
  writeJsonAtomic(join(dir, 'project.json'), next)
  return next
}

export function listModels(config) {
  const root = modelsRoot(config)
  const out = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (!statSync(dir).isDirectory()) continue
    const meta = readMeta(config, name)
    const hasGlb = existsSync(join(dir, 'model.glb'))
    const hasVol = existsSync(join(dir, 'volume.json'))
    const versions = existsSync(join(dir, 'versions')) ? readdirSync(join(dir, 'versions')).filter((f) => /^v\d+\.json$/.test(f)).length : 0
    out.push({
      name,
      title: meta?.title || name,
      source: meta?.source || (hasGlb ? 'glb' : hasVol ? 'volume' : 'empty'),
      courses: meta?.courses || (hasVol ? safeCourses(dir) : null),
      cells: meta?.cells || null,
      versions,
      has_glb: hasGlb,
      has_volume: hasVol,
      has_scene: existsSync(join(dir, 'scene.mjs')),
      has_ref: Boolean(meta?.ref_file) && existsSync(join(dir, 'ref', meta.ref_file)),
      ref_file: meta?.ref_file || null,
      updated_at: meta?.updated_at || null,
    })
  }
  return out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
}

function safeCourses(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'volume.json'), 'utf8')).ny } catch { return null }
}

export function createModel(config, name, { title, source } = {}) {
  const clean = sanitizeName(name)
  const dir = modelDir(config, clean)
  mkdirSync(dir, { recursive: true })
  const meta = saveMeta(config, clean, { name: clean, title: title || clean, source: source || 'manual' })
  journal(dir, { action: 'new', ok: true, summary: `创建模型「${meta.title}」` })
  return { name: clean, dir, meta }
}

export function saveUpload(config, name, buffer) {
  const dir = modelDir(config, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'model.glb')
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, buffer)
  renameSync(tmp, file)
  return file
}

/** 参考图落盘：ref/ref.<ext>（同名覆盖，重传即换参考）。返回 {rel, file}。 */
export function saveRefImage(config, name, filename, buffer) {
  const dir = modelDir(config, name)
  const ext = (String(filename || '').match(/\.(jpe?g|png|webp)$/i) || [])[0]
  if (!ext) throw new Error('参考图只支持 .jpg / .jpeg / .png / .webp')
  const refDir = join(dir, 'ref')
  mkdirSync(refDir, { recursive: true })
  const rel = `ref/ref${ext.toLowerCase()}`
  const file = join(refDir, `ref${ext.toLowerCase()}`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, buffer)
  renameSync(tmp, file)
  return { rel, file }
}

export function deleteModel(config, name) {
  const dir = modelDir(config, name)
  if (!existsSync(dir)) return { ok: false, error: `模型不存在: ${name}` }
  rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}

export { writeJsonAtomic, journal, readJournal, sanitizeName }
