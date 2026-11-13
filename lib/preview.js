// volume.json → 三视图 + 分层图 PNG（preview.py 移植，PIL → pngjs）。
// 验收标准：正视图轮廓不是竖直柱子；悬垂空处透白底；各层切片逐层变化。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'

// 渲染色表（preview.py 的 PAL；缺色渲染成洋红提醒补表）
export const RENDER_PAL = {
  Red: [200, 30, 25], DarkRed: [110, 20, 22], BrightLightOrange: [248, 180, 60],
  Yellow: [245, 205, 60], Orange: [250, 125, 20], DarkOrange: [170, 85, 10],
  Green: [35, 120, 60], BrightGreen: [90, 170, 80], Black: [30, 33, 36],
  White: [245, 245, 245], Tan: [225, 200, 150], LightNougat: [245, 215, 180],
  ReddishBrown: [95, 45, 25], DarkTan: [150, 140, 118], DarkBrown: [60, 40, 28],
  MediumAzure: [70, 170, 200], LightBluishGray: [160, 165, 169],
  MediumNougat: [170, 125, 85], Nougat: [208, 145, 104],
  MediumTan: [204, 163, 115], BrightLightYellow: [255, 240, 58],
  DarkGreen: [24, 70, 50], SandGreen: [160, 188, 172],
  DarkBluishGray: [108, 110, 104], PearlGold: [170, 127, 46],
  Blue: [0, 85, 191], MediumBlue: [90, 147, 219], DarkBlue: [10, 52, 99], Lime: [187, 233, 11],
}
// 色名归一（'Bright Light Orange' → BrightLightOrange 键）
const normKey = (s) => String(s).replace(/[^a-zA-Z]/g, '')
const col = (c) => RENDER_PAL[normKey(c)] || [255, 0, 255]

function makePng(w, h, fill = [255, 255, 255]) {
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = fill[0]; png.data[i * 4 + 1] = fill[1]; png.data[i * 4 + 2] = fill[2]; png.data[i * 4 + 3] = 255
  }
  return png
}

function rect(png, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue
      const i = png.width * y + x
      png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b
    }
  }
}

/**
 * 生成三视图 + 分层图。
 * @returns { files: {view_front,view_back,view_side,layers}, floors }
 */
export function renderPreview(vol, outdir, { px = 9, floors = 8 } = {}) {
  mkdirSync(outdir, { recursive: true })
  const { nx, ny, nz } = vol
  const cells = vol.cells

  // 投影：front[(a,b)] = 最前的 (d,c)；back 取最浅；side[(d,b)] 取最右
  const front = new Map()
  const back = new Map()
  const side = new Map()
  for (const [a, b, d, c] of cells) {
    const f = front.get(a + ',' + b)
    if (!f || d > f[0]) front.set(a + ',' + b, [d, c])
    const k = back.get(a + ',' + b)
    if (!k || d < k[0]) back.set(a + ',' + b, [d, c])
    const s = side.get(d + ',' + b)
    if (!s || a > s[0]) side.set(d + ',' + b, [a, c])
  }

  const files = {}
  const views = [
    ['front', front, nx, false], ['back', back, nx, true], ['side', side, nz, false],
  ]
  for (const [name, mp, w, flip] of views) {
    const im = makePng(w * px, ny * px)
    for (const [key, [, c]] of mp) {
      const [a, b] = key.split(',').map(Number)
      const x = (flip ? w - 1 - a : a) * px
      const y = (ny - 1 - b) * px
      rect(im, x, y, px, px, col(c))
    }
    const file = join(outdir, `view_${name}.png`)
    writeFileSync(file, PNG.sync.write(im))
    files[`view_${name}`] = file
  }

  // 分层图：从下往上等距抽层俯视
  const fl = []
  for (let i = 0; i < floors; i++) fl.push(Math.round((i * (ny - 1)) / Math.max(1, floors - 1)))
  const per = new Map()
  for (const [a, b, d, c] of cells) {
    if (!per.has(b)) per.set(b, new Map())
    per.get(b).set(a + ',' + d, c)
  }
  const LAB = 14
  const sheet = makePng(nx * px * fl.length, nz * px + LAB)
  fl.forEach((b, i) => {
    const m = per.get(b)
    if (m) {
      for (const [key, c] of m) {
        const [a, d] = key.split(',').map(Number)
        rect(sheet, i * nx * px + a * px, d * px + LAB, px, px, col(c))
      }
    }
  })
  const layersFile = join(outdir, 'layers.png')
  writeFileSync(layersFile, PNG.sync.write(sheet))
  files.layers = layersFile
  return { files, floors: fl }
}
