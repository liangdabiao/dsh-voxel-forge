// ============================================================================
// 体素切片工坊 · Host 半边（Node 主进程，纯 ESM）。
// 工具：voxel_forge（slice/gen/scene/build/preview/probe/downscale/ball/read/list/delete）。
// webServer 前缀路由：面板数据面（上传 GLB 入口在面板；工具与面板共用 lib/ops.js 一份逻辑）。
// 两条路线：有模型就真切片（voxelize 六步管线），体素风参考图就程序化生成（scene.mjs 基本形）。
// ============================================================================
import Schema from '@deepseek-ai/schemastery'
import {
  sliceModel, genModel, saveScene, buildModel, previewModel, probeModel,
  downscaleModel, modelDetail, readOut, listModels, deleteModel,
  uploadModel, uploadRefImage, refFile, makeBall,
} from '../lib/ops.js'
import { modelDir } from '../lib/store.js'
import { writeJsonAtomic } from '../lib/util.js'
import { registerApi } from '../lib/api.js'
import { join } from 'node:path'

export const name = 'voxel-forge' // = cordis.patch.yml 的 id

export const inject = ['tools', 'webServer']
// systemPrompt 不列入 inject：缺席时只跳过提示词段落（家族既定模式，见 apply）。

export const Config = Schema.object({
  setsRoot: Schema.string().default('').description('模型存放根目录（留空 = $DSH_HOME/voxel-forge）'),
  keepVersions: Schema.number().min(3).max(60).default(12).description('保留最近多少个装配版本'),
  maxUploadMb: Schema.number().min(1).max(200).default(80).description('面板上传 GLB 大小上限（MB）'),
})

const configRef = { config: Config }

function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`voxel_forge 参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：报告/ASCII/版本历史等结构化文本' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

const COURSES_HINT = 'courses：人像/细节要 128；小物件 64~96；96 层五官会糊成一块'

export const voxelForgeTool = {
  name: 'voxel_forge',
  description:
    '把 3D 模型（GLB/GLTF，用户在面板上传，或给出本机绝对路径）真切片成逐层可拼的 LEGO 体素模型（一格一砖、洪泛保空腔、贴图面积加权取色），' +
    '也能吃普通图片：上传体素风/像素风参考图后 agent 用 read_image 看图、写场景文件程序化生成；再装配成 set.html 3D / model.ldr / parts.csv 交付物。' +
    '用户想「把模型拼成积木/切片成体素/乐高化/逐层积木」或「按这张图做积木」时使用。' +
    '工作目录 $DSH_HOME/voxel-forge/<模型名>/。路线判定：GLB → slice；图片 → 先 read_image 判定是不是体素风，是则 scene+gen，写实照片先跟用户对齐预期。' +
    '验收纪律：切片后必须让用户看面板三视图（或 probe ASCII）再装配；几何/颜色问题分开修，一次只改一个假设。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('slice 切片 GLB；scene 保存程序化场景；gen 跑场景生成体素；build 装配出交付物；preview 重出验收图；probe 体检（颜色分布/ASCII/剖面）；downscale 缩放；ball 验证球；read 读产物（含 ref 参考图路径）；list 列模型；delete 删模型；upload 从本机路径导入 GLB 或参考图（按扩展名自动分流）', { enum: ['slice', 'scene', 'gen', 'build', 'preview', 'probe', 'downscale', 'ball', 'read', 'list', 'delete', 'upload'] }),
      name: str('模型名（可中文）'),
      path: str('upload 必填：GLB 或参考图（jpg/png/webp）的本机绝对路径'),
      code: str('scene 必填：场景文件内容（JS 模块，export function build(v)，用 v.put/box/ellipsoid/revolve/tube/repaint 逐格写）'),
      courses: num(`slice 可选：砖层数（默认 96；${COURSES_HINT}）`),
      merge: str('slice 可选：颜色归并表 default=内置材质表 / none=关闭（看原始贴图）'),
      absorb: num('slice 可选：≤N 格孤立色块并进邻域主色（默认 3；4~6 治脏，太大会吃细节）'),
      denoise: num('slice 可选：3×3×3 去噪轮数（默认 2；0=关闭——查细线丢失时用）'),
      darkdetail: num('slice 可选：细黑线保底占比（默认 0.32；闭眼/嘴缝/刻线）'),
      factor: num('downscale 可选：归并边长 N（2=减半，4=四分之一；默认 2）'),
      px: num('preview 可选：验收图每格像素（默认 9）'),
      floors: num('preview 可选：分层图抽几层（默认 8）'),
      stats: str('probe 可选：true 输出颜色分布', { enum: ['true', 'false'] }),
      layers: str('probe 可选：层范围 b0:b1（配 cols 出正面 ASCII）'),
      cols: str('probe 可选：列范围 a0:a1'),
      profile: str('probe 可选：列,层 —— 打印该格从远到近的颜色剖面'),
      what: str('read 必填：report 检查报告 / ldr LDraw / csv BOM / check 结构化检查 / scene 场景文件 / versions 版本历史 / meta 模型详情 / ref 参考图路径', { enum: ['report', 'ldr', 'csv', 'check', 'scene', 'versions', 'meta', 'ref'] }),
      title: str('upload/scene 可选：展示标题'),
    },
  },
  timeoutMs: 300_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const cfg = configRef.config
    try {
      const name = args.name
      if (args.action === 'list') {
        const models = listModels(cfg)
        if (!models.length) return result(true, `还没有模型。上传入口：侧栏「体素切片工坊」面板 →「上传 3D 文件」（.glb/.gltf）；或 voxel_forge(action="upload", path=<本机GLB绝对路径>)。`)
        return result(true, `共 ${models.length} 个模型（新→旧）`, models.map((m) => {
          const kind = m.source === 'glb' ? 'GLB切片' : m.source === 'scene' ? '程序化' : m.source === 'image' ? (m.has_volume ? '图片参考→已生成' : '图片参考') : '空'
          const bits = [`${m.name}｜${kind}｜${m.has_volume ? `${m.cells} 格 / ${m.courses} 层` : '未切片'}`, m.versions ? `v${m.versions}` : '']
          return bits.filter(Boolean).join('｜')
        }).join('\n'))
      }

      if (args.action === 'upload') {
        const { readFileSync } = await import('node:fs')
        const buf = readFileSync(args.path)
        const filename = args.path.split(/[\\/]/).pop()
        if (/\.(jpe?g|png|webp)$/i.test(filename)) {
          const r = uploadRefImage(cfg, name, filename, buf, { title: args.title })
          const size = buf.length >= 1024 ? `${(buf.length / 1024).toFixed(0)} KB` : `${buf.length} B`
          return result(true, `参考图已导入为模型「${r.name}」（${size}）。` +
            `下一步必须先用 read_image 看这张图：${r.refPath} —— 判断它是不是体素风/像素风（块面清楚、色块分明）。` +
            `是 → 按图写场景文件存进 action="scene"（name="${r.name}"），再 action="gen" 出体素、看验收图；` +
            `若只是写实照片，先跟用户对齐预期（照片取色会形状失真+颜色全错，实测被否决），别硬做。`,
          `参考图路径：${r.refPath}\n模型目录：${r.dir}`)
        }
        const r = uploadModel(cfg, name, filename, buf, { title: args.title })
        return result(true, `已导入 ${filename}（${(r.bytes / 1024).toFixed(0)} KB）为模型「${r.name}」。下一步：voxel_forge(action="slice", name="${r.name}")，${COURSES_HINT}。`)
      }

      if (args.action === 'slice') {
        const r = sliceModel(cfg, name, args)
        return result(true, `${r.summary} 纪律：先看面板三视图/验收图确认朝向、比例、空腔、五官，再 build。参数备忘：merge/absorb 治脏色，denoise=0 对照细线丢失，${COURSES_HINT}。`)
      }

      if (args.action === 'scene') {
        const r = saveScene(cfg, name, args.code, { title: args.title })
        return result(true, `场景已存为「${r.name}」/scene.mjs。下一步：voxel_forge(action="gen", name="${r.name}") 生成体素，然后看验收图。场景纪律：形体问题必须看 3D 渲染图（正视图会骗人）；附件按主视角放（别被主体挡住）；1 格厚斜向体至少 3 格。`)
      }

      if (args.action === 'gen') {
        const r = await genModel(cfg, name, args)
        return result(true, `${r.summary} 先看验收图/面板 3D，形体对齐参考图后再 build。`)
      }

      if (args.action === 'build') {
        const r = await buildModel(cfg, name)
        const detail = `产物：${r.dir}\\out\\（set.html 3D / model.ldr / parts.csv / report.txt）。面板可看 3D 与版本对比。`
        return result(r.ok, `${r.summary}（${r.seconds}s）。${detail}${r.ok ? '' : ' 检查报告用 action="read", what="report"——体素模型允许少量 not connected（异色同层不连接、悬挑），如实告知用户即可。'}`)
      }

      if (args.action === 'preview') {
        const r = previewModel(cfg, name, args)
        return result(true, r.summary + ' 验收标准：正视图轮廓与模型一致（不是竖直柱子）；悬垂下方透白底；脸要凑近单独看（眉/眼/胡子三层分开）。')
      }

      if (args.action === 'probe') {
        const r = probeModel(cfg, name, { stats: args.stats, layers: args.layers, cols: args.cols, profile: args.profile })
        return result(true, r.summary, r.text)
      }

      if (args.action === 'downscale') {
        const r = downscaleModel(cfg, name, { factor: args.factor, px: args.px })
        return result(true, r.summary)
      }

      if (args.action === 'ball') {
        const dir = modelDir(cfg, name || 'ball-check')
        const { mkdirSync } = await import('node:fs')
        mkdirSync(dir, { recursive: true })
        writeJsonAtomic(join(dir, 'volume.json'), makeBall())
        const r = previewModel(cfg, name || 'ball-check', { px: args.px })
        return result(true, `验证球已生成（24 层每层一色）+ 验收图。球错了就停下修管线，别做复杂模型。`)
      }

      if (args.action === 'read') {
        if (args.what === 'ref') {
          const file = refFile(cfg, name)
          if (!file) return result(false, `模型「${name}」没有参考图（面板上传图片，或 action="upload", path=<图片绝对路径>）`)
          return result(true, `「${name}」参考图路径（用 read_image 看图，再决定按图写场景还是提醒用户换 GLB）`, file)
        }
        if (args.what === 'versions') {
          const detail = modelDetail(cfg, name)
          if (!detail) return result(false, `模型不存在：${name}`)
          return result(true, `「${name}」共 ${detail.versions.length} 个装配版本`, detail.versions.map((v) => `v${v.v}｜${v.ok ? 'PASS' : 'FAIL'}｜${v.parts} 件｜${v.ts}`).join('\n'))
        }
        if (args.what === 'meta') {
          const detail = modelDetail(cfg, name)
          if (!detail) return result(false, `模型不存在：${name}`)
          return result(true, `「${name}」详情`, JSON.stringify({ meta: detail.meta, volume: detail.volume, versions: detail.versions.length, previews: Boolean(detail.previews), out: detail.out }, null, 2))
        }
        const content = readOut(cfg, name, args.what)
        return result(true, `「${name}」${args.what}（${content.split('\n').length} 行）`, content.length > 8000 ? content.slice(0, 8000) + `\n…（截断，完整文件 ${join(modelDir(cfg, name), 'out')}）` : content)
      }

      if (args.action === 'delete') {
        const r = deleteModel(cfg, name)
        return r.ok ? result(true, `已删除模型「${name}」`) : result(false, r.error)
      }

      throw new Error(`未知 action：${args.action}`)
    } catch (err) {
      return result(false, `voxel_forge ${args.action} 失败：${err?.message || err}`)
    }
  },
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  configRef.config = config
  ctx.tools.register(voxelForgeTool)
  ctx.effect(() => registerApi(ctx, configRef), `${name}: routes`)
}
