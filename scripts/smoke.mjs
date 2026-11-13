// 冒烟测试（离线，零网络）：工具直调全链 + 面板 API 全路由 + 上传入口 + viewer 数据契约。
// 运行：npm run smoke
const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-vox-smoke-'))
process.env.DSH_HOME = tmp

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failed++
}

// 合成 L 形 GLB（红底座+绿顶盒，边界留空气给洪泛）
const { synthGlb } = await import('../lib/glb.js')
const glb = synthGlb({
  texSize: 4,
  texFn: (u) => (u < 0.5 ? [200, 30, 25] : [35, 120, 60]),
  boxes: [
    { c: [0, 0.5, 0], s: [2, 1, 1], uvr: [0, 0, 0.4, 0.4], subdiv: 16 },
    { c: [0.5, 1.5, 0], s: [1, 1, 1], uvr: [0.6, 0.6, 1, 1], subdiv: 16 },
  ],
})
const glbFile = join(tmp, 'l.glb')
writeFileSync(glbFile, glb)

// ── 工具直调 ──
const { voxelForgeTool } = await import('../src/host.js')
const call = async (args) => {
  try { return await voxelForgeTool.execute(args, {}) } catch (e) { return { ok: false, summary: String(e?.message || e) } }
}
const MODEL = '冒烟测试'
{
  const r = await call({ action: 'list' })
  check('list 空态引导', r.ok && r.summary.includes('面板'), r.summary.slice(0, 40))
}
{
  const r = await call({ action: 'upload', name: MODEL, path: glbFile })
  check('upload 导入 GLB', r.ok && r.summary.includes('KB'), r.summary.slice(0, 60))
}
{
  const bad = await call({ action: 'upload', name: 'x1', path: join(tmp, 'nope.glb') })
  check('upload 缺文件报错', !bad.ok && bad.summary.includes('失败'), '')
}
{
  const r = await call({ action: 'slice', name: MODEL, courses: 32 })
  check('slice 切片', r.ok && r.summary.includes('格'), r.summary.slice(0, 70))
}
{
  const r = await call({ action: 'ball', name: 'ball-check' })
  check('ball 验证球', r.ok && r.summary.includes('24 层'), r.summary.slice(0, 50))
}
{
  const r = await call({ action: 'scene', name: 'proc-岛', code: 'export function build(v) {\n  v.revolve(0, 0, [6, 5, 3], 5, () => "Green")\n  v.ellipsoid(0, 8, 0, 3, 2, 2, "Blue")\n}\n' })
  check('scene 保存场景', r.ok && r.summary.includes('scene.mjs'), r.summary.slice(0, 50))
  const g = await call({ action: 'gen', name: 'proc-岛' })
  check('gen 程序化生成', g.ok && g.summary.includes('层'), g.summary.slice(0, 60))
}
{
  const r = await call({ action: 'probe', name: MODEL, stats: 'true' })
  check('probe 颜色分布', r.ok && r.data.includes('整体颜色') && r.data.includes('Red') && r.data.includes('Green'), '')
  const p2 = await call({ action: 'probe', name: MODEL, profile: '1,1' })
  check('probe 深度剖面', p2.ok && p2.data.includes('深度剖面'), '')
}
{
  const r = await call({ action: 'build', name: MODEL })
  check('build 装配出产物', r.ok !== undefined && r.summary.includes('件'), r.summary.slice(0, 80))
  const read = await call({ action: 'read', name: MODEL, what: 'report' })
  check('read report', read.ok && read.data.includes('parts'), '')
  const bom = await call({ action: 'read', name: MODEL, what: 'csv' })
  check('read BOM csv', bom.ok && bom.data.split('\n')[0].includes('part'), bom.data.split('\n')[0].slice(0, 40))
  const meta = await call({ action: 'read', name: MODEL, what: 'meta' })
  check('read meta', meta.ok && meta.data.includes('volume'), '')
}
{
  const r = await call({ action: 'downscale', name: MODEL, factor: 2 })
  check('downscale 减半', r.ok && r.summary.includes('备份'), r.summary.slice(0, 60))
}
{
  const r = await call({ action: 'preview', name: MODEL, px: 6 })
  check('preview 重出验收图', r.ok && r.summary.includes('验收图'), '')
  const bad = await call({ action: 'read', name: '不存在', what: 'meta' })
  check('read 不存在拦截', !bad.ok, '')
}
{
  const del = await call({ action: 'delete', name: 'proc-岛' })
  check('delete 模型', del.ok, '')
  const bad = await call({ action: 'slice', name: '不存在', courses: 32 })
  check('slice 缺 glb 拦截', !bad.ok && bad.summary.includes('model.glb'), bad.summary.slice(0, 50))
}

// ── 面板 API ──
const { registerApi } = await import('../lib/api.js')
const { Writable } = await import('node:stream')
const { EventEmitter } = await import('node:events')
const routes = {}
registerApi({ get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }, { config: { maxUploadMb: 40 } })
const req = async (method, path, body, raw = false) => {
  const reqObj = new EventEmitter()
  reqObj.method = method
  reqObj.url = `/voxel-forge${path}`
  reqObj.headers = body ? { 'content-type': 'application/json', host: 'x', origin: 'http://x' } : { host: 'x' }
  const chunks = []
  const resObj = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  resObj.statusCode = 0
  resObj.writeHead = (code) => { resObj.statusCode = code }
  const done = new Promise((resolve) => {
    const origEnd = resObj.end.bind(resObj)
    resObj.end = (...args) => { origEnd(...args); resolve({ status: resObj.statusCode, text: () => Buffer.concat(chunks).toString('utf8'), json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null } })() }) }
  })
  const p = routes['/voxel-forge'](reqObj, resObj)
  if (body) reqObj.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  reqObj.emit('end')
  await p
  return done
}
{
  const cat = await req('GET', '/api/catalog')
  check('catalog 模型列表', cat.status === 200 && cat.json.models.length >= 1 && cat.json.modelsRoot, '')
  // 上传入口：base64 GLB
  const up = await req('POST', '/api/models/upload', { name: '面板上传', filename: 'panel.glb', base64: glb.toString('base64') })
  check('面板上传入口', up.status === 200 && up.json.ok && up.json.bytes === glb.length, `bytes=${up.json?.bytes}`)
  const upBad = await req('POST', '/api/models/upload', { name: 'x', filename: 'a.obj', base64: 'aGk=' })
  check('面板上传非 glb 拒绝', upBad.status === 400, upBad.json?.error?.slice(0, 30))
  const nameEnc = encodeURIComponent('面板上传')
  const detail = await req('GET', `/api/models/${nameEnc}`)
  check('模型详情（上传即切片）', detail.status === 200 && detail.json.has_glb && detail.json.has_volume, `cells=${detail.json?.volume?.cells}`)
  // 验收图直出（上传自动切片后就有）
  const img = await req('GET', `/api/models/${nameEnc}/file?p=previews/view_front.png`)
  check('验收图直出 PNG', img.status === 200 && img.json === null, '')
  const escape = await req('GET', `/api/models/${nameEnc}/file?p=../model.glb`)
  check('路径穿越拦截', escape.status === 404, '')
  // 装配直调（viewer 数据依赖版本快照，先装配）
  const bd = await req('POST', `/api/models/${nameEnc}/build`, {})
  check('面板装配', bd.status === 200 && typeof bd.json.summary === 'string', bd.json?.summary?.slice(0, 50))
  // viewer 数据契约
  const ver = await req('GET', `/api/version?name=${nameEnc}`)
  check('viewer version 数据', ver.status === 200 && ver.json.meta?.title && ver.json.inst?.length > 0 && Object.keys(ver.json.geo).length > 0, `inst=${ver.json?.inst?.length}`)
  const vox = await req('GET', `/api/vox?name=${nameEnc}`)
  check('viewer vox 数据', vox.status === 200 && vox.json.meta?.voxels === true, '')
  // 静态白名单
  const lab = await req('GET', '/')
  check('lab index', lab.status === 200 && lab.text().includes('app.js'), '')
  const vh = await req('GET', '/view.html')
  check('view.html 白名单', vh.status === 200 && vh.text().includes('voxel-forge/api/version'), '')
  const vj = await req('GET', '/viewer.js')
  check('viewer.js 白名单', vj.status === 200 && vj.text().length > 10000, '')
  const sneaky = await req('GET', '/..%2f..%2fpackage.json')
  check('静态任意读拦截', sneaky.status === 404, '')
}
{
  const idx = readFileSync(new URL('../lab/index.html', import.meta.url), 'utf8')
  const appjs = readFileSync(new URL('../lab/app.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const vh = readFileSync(new URL('../viewer/view.html', import.meta.url), 'utf8')
  check('lab 上传入口存在', appjs.includes('api/models/upload') && appjs.includes('dropzone'), '')
  check('lab 消息类型与 client 对齐', appjs.includes('voxel-forge:refresh') && client.includes('voxel-forge:refresh') && client.includes('voxel-forge:start-ok'), '')
  check('scheme 消息对齐', readFileSync(new URL('../lab/scheme.js', import.meta.url), 'utf8').includes('voxel-forge:scheme') && client.includes('voxel-forge:scheme'), '')
  check('viewer 路径已改 voxel-forge', vh.includes('/voxel-forge/api/version') && vh.includes('/voxel-forge/viewer.js') && !vh.includes('lego-forge'), '')
  check('引擎零件库在包内', existsSync(new URL('../engine/parts/geo/3005.json', import.meta.url)), '')
  check('模板 set.html 引擎链在包内', existsSync(new URL('../engine/export.mjs', import.meta.url)), '')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
