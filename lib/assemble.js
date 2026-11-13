// 装配：volume.json → 引擎 Model（一格一颗 1×1×3 砖）→ pack/check/export → out/ + 版本快照。
// 铁律（上游 SKILL 第 3 条）：这里不做任何"智能修补"（不补柱、不改色、不剪格子）——
// 几何与颜色的所有决策都在 voxelize 里做完，装配只负责 m.box(x, y*3, z, 1, 1, 3, color)。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeJsonAtomic } from './util.js'

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine')

let lazy = { ready: false, Model: null, check: null, report: null, exp: null, colorInfo: null, part: null }

async function engine() {
  if (!lazy.ready) {
    const [{ Model }, { check, report }, exp, { colorInfo }, { part }] = await Promise.all([
      import(pathToFileURL(join(ENGINE_ROOT, 'model.mjs')).href),
      import(pathToFileURL(join(ENGINE_ROOT, 'check.mjs')).href),
      import(pathToFileURL(join(ENGINE_ROOT, 'export.mjs')).href),
      import(pathToFileURL(join(ENGINE_ROOT, 'colors.mjs')).href),
      import(pathToFileURL(join(ENGINE_ROOT, 'catalog.mjs')).href),
    ])
    lazy = { ready: true, Model, check, report, exp, colorInfo, part }
  }
  return lazy
}

const VoxCap = 120000

/** 体素快照：一格一颗 1×1 砖（3005），按真实砖比例 y*1.2。面板「体素对照」用。 */
async function voxSnapshot(volume, title) {
  if (!volume.cells.length || volume.cells.length > VoxCap) return null
  const geoId = '3005'
  let geo
  try {
    geo = JSON.parse(readFileSync(join(ENGINE_ROOT, 'parts/geo', geoId + '.json'), 'utf8'))
  } catch { return null }
  const { colorInfo } = await engine()
  const inst = []
  for (const [x, y, z, c] of volume.cells) {
    const info = colorInfo(c)
    inst.push([geoId, info?.hex ?? '#b7b7a7', 1, x + 0.5, y * 1.2, z + 0.5, 1, 0, 0, 0, 1, 0, 0, 0, 1, ''])
  }
  return { meta: { title, parts: inst.length, colors: new Set(inst.map((r) => r[1])).size, voxels: true }, geo: { [geoId]: geo }, inst }
}

export function versionsDir(dir) { return join(dir, 'versions') }

export function listVersions(dir) {
  const vd = versionsDir(dir)
  if (!existsSync(vd)) return []
  return readdirSync(vd).filter((f) => /^v\d+\.json$/.test(f))
    .map((f) => ({ v: Number(f.slice(1, -5)) }))
    .sort((a, b) => a.v - b.v)
}

export function readVersion(dir, v) {
  try { return JSON.parse(readFileSync(join(versionsDir(dir), `v${v}.json`), 'utf8')) } catch { return null }
}

export function pruneVersions(dir, keep = 12) {
  const list = listVersions(dir)
  if (list.length <= keep) return []
  const dropped = list.slice(0, list.length - keep)
  for (const { v } of dropped) {
    try { rmSync(join(versionsDir(dir), `v${v}.json`)) } catch { /* ignore */ }
  }
  return dropped.map((d) => d.v)
}

function nextVersion(dir) {
  const list = listVersions(dir)
  return (list.length ? list[list.length - 1].v : 0) + 1
}

/**
 * volume 对象 → 完整装配。写入 dir/out/（set.html/model.ldr/parts.csv/report.txt/check.json）
 * 与 dir/vox.json（体素快照）、dir/versions/vN.json。
 * @returns { ok, v, stats, errors, warnings, summary }
 */
export async function assembleVolume(dir, volume, { title = '体素模型', keepVersions = 12 } = {}) {
  const e = await engine()
  const out = join(dir, 'out')
  mkdirSync(out, { recursive: true })

  const m = new e.Model({
    title,
    subtitle: `${volume.ny} courses · one brick per cell（体素切片）`,
    budget: [100, 400000],
  })
  for (const [a, b, d, c] of volume.cells) m.box(a, b * 3, d, 1, 1, 3, c)

  // 体素快照（pack 前的"设计意图"）
  const vox = await voxSnapshot(volume, title)
  if (vox) writeJsonAtomic(join(dir, 'vox.json'), vox)

  m.pack()
  const res = e.check(m)
  const text = e.report(res)
  writeFileSync(join(out, 'report.txt'), text + '\n')
  writeFileSync(join(out, 'set.html'), e.exp.html(m, res.stats))
  writeFileSync(join(out, 'model.ldr'), e.exp.ldr(m))
  writeFileSync(join(out, 'parts.csv'), e.exp.bom(m))
  writeJsonAtomic(join(out, 'check.json'), res)

  const bomRows = readFileSync(join(out, 'parts.csv'), 'utf8').split('\n').filter(Boolean).slice(1)
    .map((line) => { const mm = line.match(/^([^,]+),"([^"]*)",([^,]+),(\d+)$/); return mm ? { id: mm[1], name: mm[2], color: mm[3], qty: Number(mm[4]) } : null }).filter(Boolean)
  const v = nextVersion(dir)
  writeJsonAtomic(join(versionsDir(dir), `v${v}.json`), {
    v, ts: new Date().toISOString(), title, ok: res.ok,
    stats: res.stats, errors: res.errors, warningCount: res.warnings,
    issues: res.issues.slice(0, 20), bom: bomRows, inst: e.exp.instances(m),
  })
  const pruned = pruneVersions(dir, keepVersions)
  return {
    ok: res.ok, v, stats: res.stats, errors: res.errors, warnings: res.warnings,
    issues: res.issues.slice(0, 10), pruned,
    summary: `${res.ok ? 'PASS' : 'FAIL'} · ${res.stats.parts} 件 · ${res.stats.types} 种 · ${res.stats.colors} 个主色 · ${res.errors} 错误 ${res.warnings} 警告（版本 v${v}）`,
  }
}

export { engine as loadEngine }
