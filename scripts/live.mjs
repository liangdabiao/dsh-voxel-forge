// 真实冒烟：合成 GLB → 上传 → 切片 → 装配全链（真实文件、真实引擎，无网络依赖）。
//   node scripts/live.mjs [glb路径] [模型名]
// 缺省用内置合成 L 形（双色）；给一个真实 GLB 路径可以跑真模型。
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [, , glbArg, nameArg] = process.argv
const home = process.env.DSH_HOME || mkdtempSync(join(tmpdir(), 'vox-live-'))
process.env.DSH_HOME = home
console.log('DSH_HOME =', home)

const { synthGlb } = await import('../lib/glb.js')
const { uploadModel, sliceModel, buildModel, probeModel, modelDetail } = await import('../lib/ops.js')
const cfg = {}
const name = nameArg || 'live-check'

let glbPath = glbArg
if (!glbPath || !existsSync(glbPath)) {
  glbPath = join(home, 'synth.glb')
  writeFileSync(glbPath, synthGlb({
    texSize: 4,
    texFn: (u) => (u < 0.5 ? [200, 30, 25] : [35, 120, 60]),
    boxes: [
      { c: [0, 0.5, 0], s: [2, 1, 1], uvr: [0, 0, 0.4, 0.4], subdiv: 24 },
      { c: [0.5, 1.5, 0], s: [1, 1, 1], uvr: [0.6, 0.6, 1, 1], subdiv: 24 },
    ],
  }))
  console.log('（未给 GLB，使用内置合成 L 形）')
}

const t0 = Date.now()
const buf = await import('node:fs').then((m) => m.readFileSync(glbPath))
const up = uploadModel(cfg, name, glbPath.split(/[\\/]/).pop(), buf)
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 上传：${up.name}（${(up.bytes / 1024).toFixed(0)} KB）`)

const sl = sliceModel(cfg, name, { courses: 48 })
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${sl.summary}`)
console.log(probeModel(cfg, name, { stats: true }).text.split('\n')[1])

const bd = await buildModel(cfg, name)
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 装配：${bd.summary}`)
const det = modelDetail(cfg, name)
console.log('验收图:', det.previews ? 'yes' : 'no', '| out:', det.out ? 'yes' : 'no', '| vox.json:', det.has_vox ? 'yes' : 'no')
console.log(det.out?.report)
