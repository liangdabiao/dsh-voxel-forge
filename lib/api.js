// 面板数据面：/voxel-forge 前缀路由。
// 上传 3D 文件入口（base64 JSON）、模型列表/详情/删除、切片/装配/预览直调、
// viewer 数据（/api/version 组装 {meta,geo,inst}）、验收图与产物文件白名单直出、lab 静态文件。
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listModels, deleteModel, modelDetail, sliceModel, buildModel,
  previewModel, downscaleModel, uploadModel, uploadRefImage, readVersion,
} from './ops.js'

import { modelDir, modelsRoot } from './store.js'
import { loadEngine } from './assemble.js'

const BASE = '/voxel-forge'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))
const PLUGIN_ROOT = dirname(LAB)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.ldr': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return false
  return connection.requestRejection({ headers: req.headers })
}

function serveFile(req, res, file) {
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function readJson(req, max = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('type'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

/** 面板内嵌 3D viewer 数据：版本快照 inst + 现场补零件几何 → {meta, geo, inst}（与 set.html 内嵌 SET 同构） */
async function composeSet(name, data) {
  const { part } = await loadEngine()
  const geoDir = join(PLUGIN_ROOT, 'engine', 'parts', 'geo')
  const ids = [...new Set(data.inst.map((r) => r[0]))]
  const geo = {}
  for (const id of ids) {
    const file = join(geoDir, id + '.json')
    if (!existsSync(file)) continue
    try {
      const g = JSON.parse(readFileSync(file, 'utf8'))
      if (part(id)?.ds) g.ds = true
      geo[id] = g
    } catch { /* 缺几何的零件剔除该实例 */ }
  }
  const inst = data.inst.filter((r) => geo[r[0]])
  return {
    meta: {
      title: data.title ?? name,
      subtitle: `v${data.v} · ${data.ok ? 'PASS' : 'FAIL'} · ${new Date(data.ts).toLocaleString('zh-CN')}`,
      parts: inst.length, colors: data.stats?.colors ?? new Set(inst.map((r) => r[1])).size,
      focus: null, view: null,
    },
    geo, inst,
  }
}

export function registerApi(ctx, hooks = {}) {
  const configRef = hooks
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })

        const url = new URL(req.url, 'http://x')
        if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return json(res, 404, { error: 'not found' })
        const path = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'
        const config = configRef.config

        // ── 插件静态白名单：viewer 与 lab（杜绝任意读）
        if (path === '/view.html') return serveFile(req, res, join(PLUGIN_ROOT, 'viewer', 'view.html'))
        if (path === '/viewer.js') return serveFile(req, res, join(PLUGIN_ROOT, 'viewer', 'dist', 'viewer.js'))
        if ((req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) {
          const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
          const file = safeFile(LAB, rel)
          if (file) return serveFile(req, res, file)
        }

        if (path === '/api/catalog' && req.method === 'GET') {
          return json(res, 200, {
            version: readVersion0(),
            modelsRoot: modelsRoot(config),
            models: listModels(config),
            maxUploadMb: config?.maxUploadMb ?? 80,
          })
        }

        if (path === '/api/models' && req.method === 'GET') return json(res, 200, { models: listModels(config) })

        // 上传入口：GLB → 切片路线（上传即 64 层快切）；图片 → 参考图路线（agent 看图写场景）
        if (path === '/api/models/upload' && req.method === 'POST') {
          try {
            const body = await readJson(req, (config?.maxUploadMb ?? 80) * 1024 * 1024 * 1.4)
            const filename = String(body.filename || '')
            const isImage = /\.(jpe?g|png|webp)$/i.test(filename)
            const isGlb = /\.(glb|gltf)$/i.test(filename)
            if (!isImage && !isGlb) return json(res, 400, { ok: false, error: '只支持 .glb / .gltf，或 .jpg / .jpeg / .png / .webp 参考图' })
            const buf = Buffer.from(String(body.base64 || '').replace(/^data:[^,]*,/, ''), 'base64')
            if (!buf.length) return json(res, 400, { ok: false, error: '上传内容为空' })
            const maxBytes = (config?.maxUploadMb ?? 80) * 1024 * 1024
            if (buf.length > maxBytes) return json(res, 413, { ok: false, error: `文件超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 上限` })
            if (isImage) {
              const r = uploadRefImage(config, body.name, filename, buf, { title: body.title })
              return json(res, 200, {
                ok: true, kind: 'image', name: r.name, bytes: r.bytes, ref: r.refRel,
                hint: '参考图已存为 ref/' + r.refRel.split('/').pop() + '。下一步让 agent 看图生成：对话里说「按参考图生成积木模型」即可（agent 用 read_image 读图后写 scene）。',
              })
            }
            const r = uploadModel(config, body.name, filename, buf, { title: body.title })
            // 上传即切片（64 层快速预览）：面板上传后立刻有验收图可看；失败不阻塞上传（可在模型页调参重切）
            let sliceSummary = null
            try {
              const s = sliceModel(config, r.name, { courses: 64 })
              sliceSummary = s.summary
            } catch { /* 缺贴图等原因切片失败——详情页会显示未切片状态 */ }
            return json(res, 200, { ok: true, kind: 'glb', name: r.name, bytes: r.bytes, slice: sliceSummary })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }

        const mMatch = path.match(/^\/api\/models\/([^/]+)(\/.*)?$/)
        if (mMatch) {
          const name = mMatch[1]
          const sub = mMatch[2] || ''
          if (!sub && req.method === 'GET') {
            const detail = modelDetail(config, name)
            if (!detail) return json(res, 404, { error: `模型不存在: ${name}` })
            return json(res, 200, detail)
          }
          if (!sub && req.method === 'DELETE') return json(res, 200, deleteModel(config, name))
          if (sub === '/slice' && req.method === 'POST') {
            try {
              const body = await readJson(req).catch(() => ({}))
              const r = sliceModel(config, name, body)
              return json(res, 200, { ok: true, summary: r.summary, volume: { nx: r.volume.nx, ny: r.volume.ny, nz: r.volume.nz, cells: r.volume.cells.length }, previews: r.previews })
            } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
          }
          if (sub === '/build' && req.method === 'POST') {
            try {
              await readJson(req).catch(() => ({}))
              const r = await buildModel(config, name)
              return json(res, 200, { ok: r.ok, summary: r.summary, v: r.v, stats: r.stats })
            } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
          }
          if (sub === '/preview' && req.method === 'POST') {
            try {
              const body = await readJson(req).catch(() => ({}))
              const r = previewModel(config, name, body)
              return json(res, 200, { ok: true, files: r.files })
            } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
          }
          if (sub === '/downscale' && req.method === 'POST') {
            try {
              const body = await readJson(req).catch(() => ({}))
              const r = downscaleModel(config, name, body)
              return json(res, 200, { ok: true, summary: r.summary })
            } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
          }
          // 模型目录内白名单文件（验收图/out 产物/vox.json）
          if (sub === '/file' && (req.method === 'GET' || req.method === 'HEAD')) {
            const p = url.searchParams.get('p') || ''
            const dir = modelDir(config, name)
            const file = safeFile(dir, p)
            if (!file) return json(res, 404, { error: '文件不存在或不在白名单内' })
            return serveFile(req, res, file)
          }
          return json(res, 404, { error: 'not found' })
        }

        if (path === '/api/version' && req.method === 'GET') {
          const name = url.searchParams.get('name') || ''
          const v = url.searchParams.get('v')
          const dir = modelDir(config, name)
          let data = v ? readVersion(dir, Number(v)) : null
          if (!data) {
            const detail = modelDetail(config, name)
            const list = detail?.versions || []
            if (!list.length) return json(res, 404, { error: '还没有装配版本（先 build）' })
            data = readVersion(dir, list[0].v) // versions 已倒序，[0] 最新
          }
          if (url.searchParams.get('light')) return json(res, 200, data)
          return json(res, 200, await composeSet(name, data))
        }

        if (path === '/api/vox' && req.method === 'GET') {
          const dir = modelDir(config, url.searchParams.get('name') || '')
          const file = join(dir, 'vox.json')
          if (!existsSync(file)) return json(res, 404, { error: '没有体素快照' })
          return json(res, 200, JSON.parse(readFileSync(file, 'utf8')))
        }

        if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' })
        return json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, 500, { error: err?.message || '内部错误' })
      }
    },
  })
}

function readVersion0() {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version } catch { return '' }
}

function safeFile(dir, rel) {
  if (!dir || String(rel).split(/[\\/]/).some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(dir) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}
