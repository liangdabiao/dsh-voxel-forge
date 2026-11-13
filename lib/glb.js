// GLB/GLTF 解析：JSON chunk + BIN chunk → 顶点/法线/UV/索引 + baseColor 贴图（RGB 像素阵）。
// 移植自 lego-3d-voxel scripts/vox.py 的 load_glb/accessor/贴图读取（numpy → TypedArray）。
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

const CT = { 5120: { t: 'b', s: 1 }, 5121: { t: 'b', s: 1 }, 5122: { t: 'h', s: 2 }, 5123: { t: 'h', s: 2 }, 5125: { t: 'I', s: 4 }, 5126: { t: 'f', s: 4 } }
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/** 解析 GLB 容器 → { json, bin:Buffer } */
export function loadGlb(path) {
  const data = readFileSync(path)
  if (data.length < 20 || data.readUInt32LE(0) !== 0x46546C67) throw new Error('不是 GLB 文件（magic 不对）——目前只支持 .glb（.gltf 请先转 glb）')
  let off = 12
  let json = null
  let bin = null
  while (off + 8 <= data.length) {
    const clen = data.readUInt32LE(off)
    const ctype = data.readUInt32LE(off + 4)
    off += 8
    const chunk = data.subarray(off, off + clen)
    if (ctype === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8').replace(/[\0\s]+$/, ''))
    else if (ctype === 0x004E4942) bin = chunk
    off += clen
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk')
  if (!bin) throw new Error('GLB 缺少 BIN chunk')
  return { json, bin }
}

/** accessor → { data:TypedArray, count, nc }；支持 byteStride 非紧凑排布 */
export function accessor(js, bin, idx) {
  const a = js.accessors?.[idx]
  if (!a) throw new Error(`accessor ${idx} 不存在`)
  const spec = CT[a.componentType]
  const n = NC[a.type]
  const bv = js.bufferViews[a.bufferView]
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0)
  const stride = bv.byteStride || spec.s * n
  const count = a.count
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  if (a.componentType === 5126) {
    // 浮点：紧凑时零拷贝视图，非紧凑逐元素拷
    if (stride === 4 * n) return { data: new Float32Array(bin.buffer, bin.byteOffset + start, count * n), count, nc: n }
    const out = new Float32Array(count * n)
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) out[i * n + k] = dv.getFloat32(start + i * stride + k * 4, true)
    return { data: out, count, nc: n }
  }
  const out = new Uint32Array(count * n)
  const rd = spec.s === 4 ? (p) => dv.getUint32(p, true) : (p) => dv.getUint16(p, true)
  for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) out[i * n + k] = rd(start + i * stride + k * spec.s)
  return { data: out, count, nc: n }
}

/** 解码贴图 buffer（PNG/JPEG）→ { w, h, data:Uint8ClampedArray RGB }；其他格式报可读错误 */
export function decodeImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf)
    return toRgb(png.width, png.height, png.data) // RGBA → RGB
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true })
    return toRgb(j.width, j.height, j.data)
  }
  throw new Error(`贴图格式不支持（目前 PNG/JPEG；WebP 等请先转 PNG）。头部 ${[...buf.subarray(0, 4)]}`)
}

function toRgb(w, h, rgba) {
  const n = w * h
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4]
    out[i * 3 + 1] = rgba[i * 4 + 1]
    out[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return { w, h, data: out }
}

/**
 * 从 GLB 提取第一个 mesh 的几何与第一张 baseColor 贴图。
 * 返回 { pos, nrm, uv, idx, tex }（pos/nrm: Float32Array xyz；uv: Float32Array xy；idx: Uint32Array；tex: {w,h,data}）
 */
export function extractMesh(js, bin) {
  const mesh = js.meshes?.[0]
  if (!mesh?.primitives?.length) throw new Error('GLB 没有 mesh primitives')
  const prim = mesh.primitives[0]
  const attr = prim.attributes || {}
  for (const k of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
    if (attr[k] === undefined) throw new Error(`GLB 缺少 ${k} 属性（切片需要顶点/法线/UV 三件套）`)
  }
  const pos = accessor(js, bin, attr.POSITION)
  const nrm = accessor(js, bin, attr.NORMAL)
  const uvv = accessor(js, bin, attr.TEXCOORD_0)
  const idxA = accessor(js, bin, prim.indices)
  const texRef = js.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture
  if (!texRef) throw new Error('GLB 材质缺 baseColorTexture（切片颜色来自贴图，没有贴图就取不了色）')
  const texIdx = js.textures[texRef.index]?.source
  const img = js.images[texIdx]
  const bv = js.bufferViews[img.bufferView]
  const bo = bv.byteOffset || 0
  const tex = decodeImage(bin.subarray(bo, bo + bv.byteLength))
  return {
    pos: pos.data instanceof Float32Array ? pos.data : Float32Array.from(pos.data),
    nrm: nrm.data instanceof Float32Array ? nrm.data : Float32Array.from(nrm.data),
    uv: uvv.data instanceof Float32Array ? uvv.data : Float32Array.from(uvv.data),
    idx: Uint32Array.from(idxA.data),
    tex,
  }
}

/**
 * 生成合成 GLB（测试/验证链路用）：若干细分实心盒 + PNG 贴图。
 * boxes: [{ c:[cx,cy,cz] 中心, s:[sx,sy,sz] 尺寸, uvr:[u0,v0,u1,v1] UV 区间, subdiv }]
 * 简写：{ size, rgb, subdiv } = 单盒。
 */
export function synthGlb(opts = {}) {
  const boxes = opts.boxes || [{ c: [0, 0, 0], s: [opts.size || 1, opts.size || 1, opts.size || 1], uvr: [0, 0, 1, 1], subdiv: opts.subdiv || 16 }]
  const texSize = opts.texSize || 4
  const texFn = opts.texFn || (() => opts.rgb || [200, 30, 25])
  const png = new PNG({ width: texSize, height: texSize })
  for (let y = 0; y < texSize; y++) {
    for (let x = 0; x < texSize; x++) {
      const i = y * texSize + x
      const c = texFn(x / (texSize - 1), y / (texSize - 1))
      png.data[i * 4] = c[0]; png.data[i * 4 + 1] = c[1]; png.data[i * 4 + 2] = c[2]; png.data[i * 4 + 3] = 255
    }
  }
  const pngBuf = PNG.sync.write(png)
  const faceN = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
  const faceGen = [
    (u, v) => [u - 0.5, v - 0.5, -0.5], (u, v) => [u - 0.5, v - 0.5, 0.5],
    (u, v) => [-0.5, u - 0.5, v - 0.5], (u, v) => [0.5, u - 0.5, v - 0.5],
    (u, v) => [u - 0.5, -0.5, v - 0.5], (u, v) => [u - 0.5, 0.5, v - 0.5],
  ]
  const posList = []
  const nrmList = []
  const uvList = []
  const idxList = []
  for (const bx of boxes) {
    const n = Math.max(1, bx.subdiv || 16)
    const [sx, sy, sz] = bx.s
    const [cx, cy, cz] = bx.c
    const [u0, v0, u1, v1] = bx.uvr || [0, 0, 1, 1]
    for (let f = 0; f < 6; f++) {
      const base = posList.length / 3
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          let [x, y, z] = faceGen[f](i / n, j / n)
          x = x * sx + cx; y = y * sy + cy; z = z * sz + cz
          posList.push(x, y, z)
          nrmList.push(...faceN[f])
          uvList.push(u0 + (u1 - u0) * (i / n), v0 + (v1 - v0) * (j / n))
        }
      }
      const row = n + 1
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const v0i = base + j * row + i
          idxList.push(v0i, v0i + 1, v0i + row + 1, v0i, v0i + row + 1, v0i + row)
        }
      }
    }
  }
  const pos = Float32Array.from(posList)
  const nrm = Float32Array.from(nrmList)
  const uv = Float32Array.from(uvList)
  const idx = Uint32Array.from(idxList)

  // BIN 布局：pos/nrm/uv/idx/tex 依次 4 字节对齐
  const chunks = [
    { b: Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength) },
    { b: Buffer.from(nrm.buffer, nrm.byteOffset, nrm.byteLength) },
    { b: Buffer.from(uv.buffer, uv.byteOffset, uv.byteLength) },
    { b: Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength) },
    { b: pngBuf },
  ]
  const bufferViews = []
  const byteOffsets = []
  let off = 0
  for (const c of chunks) {
    const pad = (4 - (off % 4)) % 4
    off += pad
    bufferViews.push({ buffer: 0, byteOffset: off, byteLength: c.b.length })
    byteOffsets.push(off)
    off += c.b.length
  }
  const binBuf = Buffer.alloc(off)
  chunks.forEach((c, i) => c.b.copy(binBuf, byteOffsets[i]))
  const gltf = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 4, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, type: 'VEC3', count: pos.length / 3 },
      { bufferView: 1, componentType: 5126, type: 'VEC3', count: nrm.length / 3 },
      { bufferView: 2, componentType: 5126, type: 'VEC2', count: uv.length / 2 },
      { bufferView: 3, componentType: 5125, type: 'SCALAR', count: idx.length },
    ],
    bufferViews,
    buffers: [{ byteLength: binBuf.length }],
  }
  return packGlb(gltf, binBuf)
}

function packGlb(gltf, binBuf) {
  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8')
  const padJ = (4 - (jsonBuf.length % 4)) % 4
  const padB = (4 - (binBuf.length % 4)) % 4
  const total = 12 + 8 + jsonBuf.length + padJ + 8 + binBuf.length + padB
  const out = Buffer.alloc(total, 0x20) // JSON chunk 规范用空格补齐；BIN 段随后精确覆写
  out.writeUInt32LE(0x46546C67, 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length + padJ, 12)
  out.writeUInt32LE(0x4E4F534A, 16)
  jsonBuf.copy(out, 20)
  const binHead = 20 + jsonBuf.length + padJ
  out.writeUInt32LE(binBuf.length + padB, binHead)
  out.writeUInt32LE(0x004E4942, binHead + 4)
  binBuf.copy(out, binHead + 8)
  return out
}
