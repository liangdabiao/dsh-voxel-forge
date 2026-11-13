# 体素切片工坊 · dsh-voxel-forge

DeepSeek Harness（[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)）插件：**上传一个 3D 模型（GLB/GLTF），真切片成逐层可拼的 LEGO 体素**——一格一砖、三维洪泛保空腔、贴图面积加权取色，装配出 set.html 3D、model.ldr、BOM 与可拼搭检查报告。参考图本身就是体素风时，也可以用基本形程序化生成。

引擎、零件几何与装配检查源自 [lego-forge](https://github.com/ericfu-tianchi/lego-forge)（MIT，与 [dsh-lego-forge](https://github.com/liangdabiao/dsh-lego-forge) 同源）；切片方法论源自 [lego-3d-voxel](https://github.com/liangdabiao/lego-3d-voxel)（Python → **Node 全量重写，零 Python 依赖**，numpy 向量化 → TypedArray + BFS）；LDraw 零件几何 © LDraw.org (CC BY 2.0)。

<img width="2379" height="1386" alt="image" src="https://github.com/user-attachments/assets/22b59991-e628-44a9-a9fd-1c91f9d32571" />

## 装上以后有什么

| 能力 | 说明 |
|---|---|
| **面板上传入口（GLB + 图片）** | 拖拽/点选 `.glb`/`.gltf`（≤80 MB）→ 上传即 64 层快速切片，立刻出验收图；`.jpg`/`.jpeg`/`.png`/`.webp` → 存为参考图，agent 用视觉读图后程序化生成 |
| `voxel_forge` 工具（12 个 action） | `upload` 本机导入 GLB 或参考图（按扩展名分流）· `slice` 切片（courses/merge/absorb/denoise/darkdetail）· `scene`+`gen` 程序化生成 · `build` 装配 · `preview` 验收图 · `probe` 体检（颜色分布/正面 ASCII/深度剖面）· `downscale` 缩放 · `ball` 验证球 · `read`（含 `what="ref"` 取参考图路径）/`list`/`delete` |
| **图片路线** | 上传图片即建模型并落盘 `ref/ref.<ext>`；agent `read_image` 看图判断是否体素风 → 写场景 → `gen` 出体素；写实照片会先跟用户对齐预期 |
| **切片管线**（vox.py 全量移植） | 7 点采样 + 面积加权投票 → 暗细节保底（闭眼/刻线）→ 三维洪泛判内外（保悬垂空腔）→ 反填 carve → 表面取色 → 材质归并/孤立色吸收 → 内部 BFS 传色 → 去噪 |
| 侧栏「体素切片工坊」面板 | 上传入口 + 模型库（GLB 切片 / 图片参考标签）/ 参考图展示与「按参考图生成」/ 切片参数表单 / 三视图+分层图（灯箱放大）/ 3D（砖块 ↔ 体素对照，框选批注继承自 forge viewer）/ 颜色分布 / 检查报告 / BOM+LDraw 下载 / 时间线 |
| 交付物 | set.html（独立 3D 页）、model.ldr、parts.csv、report.txt、check.json、验收图 PNG |

## 两条路线

| 手上有什么 | 走哪条 |
|---|---|
| `.glb`/`.gltf`（扫描件/雕刻/游戏资产，带贴图） | **切片**：形体忠实度最高，颜色来自模型贴图 |
| 体素风/像素风参考图（块面清楚） | **程序化**：面板上传图片（或 `action="upload", path=<图片路径>`）→ agent `read_image` 看图 → `action="scene"` 写基本形场景（ellipsoid/revolve/tube/repaint/hash01 确定性杂色）→ `gen` |
| 写实照片 | 都不成立——先对齐预期，不要硬做（取色会形状失真 + 颜色全错，实测被否决） |

## 使用

对话里直接说：

- 「我刚在面板传了个鹿模型，切成积木」——agent 走 `slice courses=128` → 看验收图 → `probe` 排查 → `build` → 汇报检查报告
- 「小一半」——`downscale`（归并而非重切；1 格宽细结构会变粗或断开，agent 会主动说明）
- 「参考这张像素图画个浮岛」——先传图（面板拖入图片，或给本机路径），agent `read_image` 看图 → `scene` 写场景 → `gen` → `build`
- 「按这张图做个积木」——同上；写实照片 agent 会先跟你确认（照片取色形状会失真）

或打开侧栏「体素切片工坊」：拖一个 GLB 进上传区，看三视图确认朝向/比例/空腔，点装配下载 LDraw 和 BOM。

## 切片参数速查

| 参数 | 默认 | 取值 |
|---|---|---|
| `courses` 砖层数 | 96 | 人像 128；小物件 64~96；96 层五官会糊 |
| `merge` 颜色归并 | default | 按材质分组（红袍的暗红阴影保留，碎条纹并入）；none 看原始贴图 |
| `absorb` 孤立色吸收 | 3 | 4~6 治脏；保护 Black/White |
| `denoise` 去噪 | 2 | 会吃 1 格宽细线；查特征丢失设 0 对照 |
| `darkdetail` 细黑线保底 | 0.32 | 黑覆盖占比达标就取黑（只对浅色格生效） |

## 已知边界（如实说明，不硬修）

- voxel 塑像通常有大量 `not connected`（底部悬空/异色同层/悬挑）——体素特性，可拼搭检查按报告如实汇报，**不为 0 错误补柱子**（会把空腔焊死）
- 眼睛/细刻线在 128 层仍可能不出（carve + darkdetail 已实装；上游财神件同样未解决）——用 `probe profile` 查是不是被埋，查不出就如实说
- 贴图串色（同材料近似色之外的大片异色）归并表治不了

## 开发

```bash
npm i
npm test           # 21 个单测（切片管线/空腔/双色分区/确定性/预览像素/基本形/工具全链）
npm run smoke      # 离线冒烟：工具直调 + 面板 API 全路由（上传入口/路径穿越拦截/viewer 数据契约）
npm run live       # 合成 GLB → 上传 → 切片 → 装配全链（真实文件+真实引擎，无网络）
npm run dev        # 面板独立预览：DSH_HOME=<目录> node scripts/devserver.mjs 5187
```

数据落在 `$DSH_HOME/voxel-forge/<模型名>/`：`model.glb` + `volume.json` + `previews/`（验收图）+ `out/`（交付物）+ `vox.json`（体素快照）+ `versions/`（装配版本）+ `journal.jsonl`（时间线），原子写。

## 结构

```
src/host.js            voxel_forge 工具（12 action）+ 装配
lib/glb.js             GLB 解析 + PNG/JPEG 贴图解码（pngjs/jpeg-js）+ 合成 GLB（测试/冒烟）
lib/voxelize.js        切片主管线（vox.py 全量移植；含一处上游注释/实现对齐修正——逐面主色取面积最大）
lib/preview.js         三视图 + 分层图 PNG（preview.py 移植）
lib/probe.js           体检：颜色分布 / 正面 ASCII / 深度剖面（probe.py 移植）
lib/downscale.js       N×N×N 桶归并缩放（downscale.py 移植，众数定色不插值）
lib/genvox.js          程序化基本形 + 确定性 hash01（gen.py 移植；场景=JS 模块零依赖）
lib/assemble.js        volume.json → 引擎 Model（一格一砖）→ pack/check/export + 版本快照 + 体素快照
lib/store.js / ops.js  $DSH_HOME 持久化 + 工具/面板共用业务层
lib/api.js             /voxel-forge 面板路由（上传/切片/装配/viewer 数据/白名单文件）
engine/ viewer/        lego-forge 引擎与 3D viewer（450 真零件几何 + 框选批注桥）
client.js / lab/       浏览器半边（侧栏入口 + iframe 面板，明暗跟随 dsh 主题）
skills/voxel-forge/    方法论技能（铁律/参数速查/验收标准；references/ 保留上游四篇完整复盘）
examples/island.mjs    鲸鱼浮岛场景示例（JS 版上游 whale-island）
```

## License

MIT（本插件代码）。装配引擎与零件几何源自 lego-forge（MIT）；切片方法论与上游脚本参考 lego-3d-voxel；LDraw 零件几何 © LDraw.org (CC BY 2.0)。
