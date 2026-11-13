// 体素切片工坊 · 面板逻辑。
// 上传 3D 文件入口（拖拽/点选 → base64 → /api/models/upload）→ 模型库卡片 →
// 模型详情（切片参数 / 验收图 / 3D + 体素对照 / BOM / 报告 / 时间线）→ 装配与缩放直调。
(() => {
  const $app = document.getElementById('app')
  const $toast = document.getElementById('toast')
  const EMBEDDED = (() => { try { return window.parent !== window } catch { return false } })()

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  let toastTimer
  function toast(msg, isErr = false) {
    $toast.textContent = msg
    $toast.className = 'toast' + (isErr ? ' err' : '')
    $toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { $toast.hidden = true }, isErr ? 5200 : 2800)
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/voxel-forge${path}`, opts)
    const ct = res.headers.get('content-type') || ''
    const body = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text()
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return body
  }
  const apiPost = (path, payload) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) })

  // ── 路由
  const routes = []
  const route = (re, fn) => routes.push([re, fn])
  function navigate() {
    const hash = location.hash || '#/'
    window.scrollTo(0, 0)
    for (const [re, fn] of routes) {
      const m = hash.match(re)
      if (m) return fn(...m.slice(1))
    }
    $app.innerHTML = '<div class="empty">404</div>'
  }
  addEventListener('hashchange', navigate)

  const busyBtn = (btn, label) => {
    if (!btn) return () => {}
    const old = btn.textContent
    btn.disabled = true
    btn.innerHTML = `<span class="spin"></span> ${label}`
    return () => { btn.disabled = false; btn.textContent = old }
  }

  // ── 上传 / 模型库
  route(/^#\/$/, renderHome)
  async function renderHome() {
    let catalog
    try { catalog = await api('/api/catalog') } catch (e) { $app.innerHTML = `<div class="empty">面板服务连接失败：${esc(e.message)}</div>`; return }
    document.getElementById('rail-version').textContent = 'v' + (catalog.version || '0.1.0')

    const modelsHtml = catalog.models.length
      ? `<div class="grid cols2">` + catalog.models.map((m) => `
        <div class="card model-card">
          <div class="head">
            <span class="title">${esc(m.title)}</span>
            <span class="tag ${m.source === 'glb' ? '' : 'gray'}">${m.source === 'glb' ? 'GLB 切片' : m.source === 'image' ? '图片参考' : m.source === 'scene' ? '程序化' : '空'}</span>
          </div>
          <div class="stats">
            ${m.has_volume ? `<span><b>${m.cells}</b> 格</span><span><b>${m.courses}</b> 层</span>` : '<span>未切片</span>'}
            ${m.versions ? `<span><b>v${m.versions}</b> 装配</span>` : ''}
          </div>
          <div class="row">
            <a class="btn small" href="#/m/${encodeURIComponent(m.name)}">打开</a>
            <button class="danger small" data-del="${esc(m.name)}">删除</button>
          </div>
        </div>`).join('') + '</div>'
      : '<div class="empty">还没有模型——上传一个 GLB（真切片），或上传一张体素风/像素风参考图（agent 看图写场景），也可以在对话里让 agent 用 voxel_forge 的 action=upload / scene。</div>'

    $app.innerHTML = `
      <h1>上传文件</h1>
      <p class="lead">两条路线：<b>GLB / GLTF</b>（≤ ${catalog.maxUploadMb} MB）→ agent 真切片，一格一砖、洪泛保空腔、贴图面积加权取色；<b>普通图片</b>（.jpg / .png / .webp）→ 存为参考图，agent 先看图判断体素风，再写场景程序化生成积木。</p>
      <div class="dropzone" id="dropzone">
        <div class="big">🧱</div>
        <div><b>点击选择或拖入 .glb / .gltf，或 .jpg / .png / .webp 参考图</b></div>
        <p>3D 文件默认取文件名建模型；图片会用 agent 视觉读图（体素风最准，写实照片会先跟你对齐预期）</p>
        <input type="file" id="fileinput" accept=".glb,.gltf,.jpg,.jpeg,.png,.webp">
      </div>
      <h2>模型库（${catalog.models.length}）</h2>
      ${modelsHtml}
      <p class="lead" style="margin-top:18px">数据目录：<span class="mono">${esc(catalog.modelsRoot)}</span></p>
    `

    const dz = document.getElementById('dropzone')
    const fi = document.getElementById('fileinput')
    dz.addEventListener('click', () => fi.click())
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over') })
    dz.addEventListener('dragleave', () => dz.classList.remove('over'))
    dz.addEventListener('drop', (e) => {
      e.preventDefault()
      dz.classList.remove('over')
      if (e.dataTransfer.files?.[0]) uploadFile(e.dataTransfer.files[0])
    })
    fi.addEventListener('change', () => { if (fi.files?.[0]) uploadFile(fi.files[0]) })

    $app.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`删除模型「${btn.dataset.del}」？（切片、装配产物全部删除）`)) return
        try {
          await api(`/api/models/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' })
          toast('已删除')
          renderHome()
        } catch (e) { toast(e.message, true) }
      })
    })

    async function uploadFile(file) {
      const isImage = /\.(jpe?g|png|webp)$/i.test(file.name)
      const isGlb = /\.(glb|gltf)$/i.test(file.name)
      if (!isImage && !isGlb) return toast('只支持 .glb / .gltf，或 .jpg / .jpeg / .png / .webp 参考图', true)
      if (file.size > (catalog.maxUploadMb || 80) * 1024 * 1024) return toast(`超过 ${catalog.maxUploadMb} MB 上限`, true)
      toast(`上传中：${file.name}（${(file.size / 1024).toFixed(0)} KB）…`)
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
        r.onerror = reject
        r.readAsDataURL(file)
      })
      const name = file.name.replace(/\.(glb|gltf|jpe?g|png|webp)$/i, '')
      try {
        const r = await apiPost('/api/models/upload', { name, filename: file.name, base64 })
        toast(r.kind === 'image'
          ? `参考图已存入「${r.name}」。点「打开」→「按参考图生成」，或在对话里说「按这张图生成积木模型」`
          : `已上传：${r.name}。切片建议找 agent，或点「打开」调参数`)
        location.hash = `#/m/${encodeURIComponent(r.name)}`
      } catch (e) { toast(e.message, true) }
    }
  }

  // ── 模型详情
  route(/^#\/m\/(.+)$/, (name0) => renderModel(decodeURIComponent(name0)))
  async function renderModel(name, activeVersion, voxMode = false) {
    let d
    try { d = await api(`/api/models/${encodeURIComponent(name)}`) } catch (e) { $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    const vol = d.volume
    const has3d = d.versions.length > 0

    const previewsHtml = d.previews ? `
      <h2>验收图</h2>
      <div class="gal">
        ${['front', 'back', 'side'].map((k) => `<figure><img src="/voxel-forge/api/models/${encodeURIComponent(name)}/file?p=previews/view_${k}.png" data-zoom><figcaption>${{ front: '正视图', back: '背视图', side: '侧视图' }[k]}</figcaption></figure>`).join('')}
        <figure><img src="/voxel-forge/api/models/${encodeURIComponent(name)}/file?p=previews/layers.png" data-zoom><figcaption>分层图</figcaption></figure>
      </div>`
      : d.has_ref && !d.has_glb
        ? `<h2>验收图</h2><div class="empty">还没有体素——点上方「按参考图生成积木」，agent 看图写场景后会生成验收图</div>`
        : '<h2>验收图</h2><div class="empty">还没切片——下方调参数后点「开始切片」</div>'

    const colorsHtml = vol ? `
      <h2>颜色分布（${vol.colors.length} 色）</h2>
      <div class="card">${vol.colors.slice(0, 12).map(([c, n]) => `<span class="tag gray" style="margin:2px">${esc(c)} × ${n}</span>`).join(' ')}</div>` : ''

    const refHtml = d.has_ref ? `
      <h2>参考图</h2>
      <div class="card">
        <div class="row" style="align-items:flex-start;gap:16px">
          <figure style="margin:0;max-width:min(100%,420px)">
            <img src="/voxel-forge/api/models/${encodeURIComponent(name)}/file?p=${encodeURIComponent(d.ref.rel)}"
                 alt="参考图" data-zoom style="width:100%;border-radius:8px;border:1px solid var(--line);cursor:zoom-in">
            <figcaption class="muted" style="font-size:12px;margin-top:6px">${esc(d.ref.source_file || d.ref.rel)}（${d.ref.bytes ? (d.ref.bytes / 1024).toFixed(0) + ' KB' : '—'}）</figcaption>
          </figure>
          <div style="flex:1;min-width:220px">
            <p class="lead" style="margin:0 0 10px">图片路线：agent 先用视觉读这张图，判断是不是体素风/像素风（块面清楚、色块分明）。是 → 照块面写场景文件再生成体素；写实照片会先跟你对齐预期。</p>
            <button id="btn-from-ref" class="ghost">按参考图生成积木</button>
          </div>
        </div>
      </div>` : ''

    $app.innerHTML = `
      <a href="#/" class="muted" style="font-size:12px">← 模型库</a>
      <h1>${esc(d.meta?.title || name)}</h1>
      <p class="lead">来源：${d.has_glb ? 'GLB 文件' : d.has_ref ? '参考图片' : d.has_scene ? '程序化场景' : '空'} ·
        ${vol ? `<b>${vol.cells}</b> 格 / <b>${vol.nx}×${vol.ny}×${vol.nz}</b>（${vol.ny} 层）` : '未切片'} ·
        ${d.versions.length ? `装配 <b>v${d.versions[0].v}</b>（${d.versions[0].ok ? 'PASS' : 'FAIL'}，${d.versions[0].parts} 件）` : '未装配'}
      </p>

      ${refHtml}

      <div class="card">
        <div class="row" style="align-items:end">
          <div><label>砖层数 courses</label><input type="number" id="in-courses" value="${vol ? vol.ny : 96}" min="8" max="256"></div>
          <div><label>颜色归并 merge</label><select id="in-merge"><option value="default">default（内置材质表）</option><option value="none">none（原始贴图）</option></select></div>
          <div><label>吸收 absorb</label><input type="number" id="in-absorb" value="3" min="0" max="10"></div>
          <div><label>去噪 denoise</label><input type="number" id="in-denoise" value="2" min="0" max="3"></div>
          <div style="flex:0">
            <label>&nbsp;</label>
            <button id="btn-slice" ${d.has_glb ? '' : 'disabled'}>开始切片</button>
          </div>
        </div>
        <div class="toolbar">
          <button id="btn-build" class="ghost" ${vol ? '' : 'disabled'}>装配（出 set.html / LDraw / BOM）</button>
          <button id="btn-preview" class="ghost" ${vol ? '' : 'disabled'}>重出验收图</button>
          <button id="btn-downscale" class="ghost" ${vol && vol.ny >= 16 ? '' : 'disabled'}>缩放减半</button>
          <button id="btn-chat" class="ghost">让 agent 处理这个模型</button>
          <span class="muted" style="font-size:12px">切片纪律：先看验收图确认朝向/比例/空腔，再装配</span>
        </div>
      </div>

      ${previewsHtml}
      ${colorsHtml}

      ${has3d ? `
      <h2>3D 模型</h2>
      <div class="toolbar">
        <label style="margin:0;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font-size:13px">
          <input type="checkbox" id="in-vox" style="width:auto" ${voxMode ? 'checked' : ''}> 看体素（设计意图）
        </label>
        ${d.versions.length > 1 ? `<select id="in-ver" style="width:auto">${d.versions.map((v) => `<option value="${v.v}" ${activeVersion === v.v ? 'selected' : ''}>v${v.v}（${v.ok ? 'PASS' : 'FAIL'} · ${v.parts} 件）</option>`).join('')}</select>` : ''}
        <a class="btn small" href="/voxel-forge/api/models/${encodeURIComponent(name)}/file?p=out/set.html" target="_blank" rel="noreferrer">全屏打开</a>
        <a class="btn small ghost" href="/voxel-forge/api/models/${encodeURIComponent(name)}/file?p=out/parts.csv" download="parts.csv">⬇ BOM (CSV)</a>
        <a class="btn small ghost" href="/voxel-forge/api/models/${encodeURIComponent(name)}/file?p=out/model.ldr" download="model.ldr">⬇ LDraw</a>
      </div>
      <div class="frame3d"><iframe id="frame3d" src="/voxel-forge/view.html?set=${encodeURIComponent(name)}${activeVersion ? `&v=${activeVersion}` : ''}&embed=1${voxMode ? '&data=vox' : ''}" loading="lazy"></iframe></div>
      ` : ''}

      <div class="grid cols2" style="margin-top:26px">
        <div>
          <h2 style="margin-top:0">检查报告</h2>
          ${d.out ? `<div id="report-box" class="card"><span class="spin"></span></div>` : '<div class="empty">装配后出报告</div>'}
        </div>
        <div>
          <h2 style="margin-top:0">时间线</h2>
          <div class="card timeline">${d.journal.slice().reverse().slice(0, 30).map((j) => `
            <div class="tl-item ${j.ok ? 'ok' : 'fail'}">
              <span class="ts mono">${esc((j.ts || '').slice(5, 19))}</span>
              <b>${esc(j.action)}</b> — ${esc(j.summary || '')}
            </div>`).join('') || '<div class="empty">暂无</div>'}</div>
        </div>
      </div>
    `

    // 操作绑定
    document.getElementById('btn-slice')?.addEventListener('click', async (e) => {
      const done = busyBtn(e.target, '切片中…')
      try {
        const r = await apiPost(`/api/models/${encodeURIComponent(name)}/slice`, {
          courses: Number(document.getElementById('in-courses').value) || 96,
          merge: document.getElementById('in-merge').value,
          absorb: Number(document.getElementById('in-absorb').value) || 0,
          denoise: Number(document.getElementById('in-denoise').value),
        })
        toast(r.summary)
        renderModel(name)
      } catch (err) { toast(err.message, true); done() }
    })
    document.getElementById('btn-build')?.addEventListener('click', async (e) => {
      const done = busyBtn(e.target, '装配中…')
      try {
        const r = await apiPost(`/api/models/${encodeURIComponent(name)}/build`)
        toast(r.summary)
        renderModel(name)
      } catch (err) { toast(err.message, true); done() }
    })
    document.getElementById('btn-preview')?.addEventListener('click', async (e) => {
      const done = busyBtn(e.target, '出图中…')
      try {
        await apiPost(`/api/models/${encodeURIComponent(name)}/preview`, { px: 9 })
        toast('验收图已更新')
        renderModel(name)
      } catch (err) { toast(err.message, true); done() }
    })
    document.getElementById('btn-downscale')?.addEventListener('click', async (e) => {
      if (!confirm('缩放减半：1 格宽细结构会变粗或断开（自动备份当前 volume.json）。继续？')) return
      const done = busyBtn(e.target, '缩放中…')
      try {
        const r = await apiPost(`/api/models/${encodeURIComponent(name)}/downscale`, { factor: 2 })
        toast(r.summary)
        renderModel(name)
      } catch (err) { toast(err.message, true); done() }
    })
    document.getElementById('in-vox')?.addEventListener('change', (e) => renderModel(name, activeVersion, e.target.checked))
    document.getElementById('in-ver')?.addEventListener('change', (e) => renderModel(name, Number(e.target.value), voxMode))
    document.getElementById('btn-chat')?.addEventListener('click', () => {
      const prompt = `处理体素模型「${name}」：用 voxel_forge 检查当前状态，切片/生成的验收问题（朝向、比例、空腔、颜色分区）先看 probe 与验收图再改；需要装配交付就 build 并汇报检查报告结论。`
      try { parent.postMessage({ type: 'voxel-forge:refresh', prompt }, location.origin) } catch {}
      toast('已发送到对话（若侧栏无反应请在对话里直接 @）')
    })
    document.getElementById('btn-from-ref')?.addEventListener('click', () => {
      const prompt = `按参考图生成积木模型「${name}」：先用 voxel_forge(action="read", name="${name}", what="ref") 拿参考图路径，用 read_image 看这张图，判断它是不是体素风/像素风（块面清楚、色块分明）。` +
        `是 → 照块面写场景文件（action="scene", name="${name}", code=<JS 模块，export function build(v)，用 v.put/box/ellipsoid/revolve/tube/repaint>），再 action="gen" 出体素、给我看验收图；` +
        `若是写实照片 → 先跟我对齐预期，说明照片取色会形状失真、颜色全错，建议换 GLB 模型。`
      try { parent.postMessage({ type: 'voxel-forge:refresh', prompt }, location.origin) } catch {}
      toast('已发送到对话（若侧栏无反应请在对话里直接 @）')
    })
    addEventListener('message', (e) => {
      if (e.data?.type === 'voxel-forge:start-ok') toast('已开新对话并填入草稿')
      if (e.data?.type === 'voxel-forge:start-failed') toast('开新对话失败：' + (e.data.message || ''), true)
    })

    // 报告 + BOM
    if (d.out) {
      api(`/api/models/${encodeURIComponent(name)}/file?p=out/report.txt`).then((txt) => {
        document.getElementById('report-box').innerHTML = `<pre class="report">${esc(txt)}</pre>`
      }).catch(() => { document.getElementById('report-box').textContent = '报告读取失败' })
    }

    // 验收图灯箱
    $app.querySelectorAll('[data-zoom]').forEach((img) => {
      img.addEventListener('click', () => {
        const lb = document.getElementById('lightbox')
        lb.querySelector('img').src = img.src
        lb.hidden = false
      })
    })
    document.getElementById('lightbox').addEventListener('click', (e) => { e.currentTarget.hidden = true })
  }

  // ── 设置
  route(/^#\/settings$/, renderSettings)
  async function renderSettings() {
    let catalog
    try { catalog = await api('/api/catalog') } catch (e) { $app.innerHTML = `<div class="empty">面板服务连接失败：${esc(e.message)}</div>`; return }
    $app.innerHTML = `
      <h1>设置</h1>
      <p class="lead">体素切片工坊的配置在 dsh 插件配置里改（config：setsRoot / keepVersions / maxUploadMb）；本页只读展示。</p>
      <div class="card">
        <label>模型根目录</label>
        <div class="mono" style="font-size:12px">${esc(catalog.modelsRoot)}</div>
        <label>上传大小上限</label>
        <div class="mono" style="font-size:12px">${catalog.maxUploadMb} MB</div>
        <label>插件版本</label>
        <div class="mono" style="font-size:12px">v${esc(catalog.version)}</div>
      </div>
      <h2>切片参数速查</h2>
      <div class="card" style="line-height:1.9;font-size:13px">
        <b>courses</b> 砖层数：人像/细节 128，小物件 64~96，96 层五官会糊成一块<br>
        <b>merge</b> 颜色归并：default 按材质归并治贴图噪点；none 看原始贴图<br>
        <b>absorb</b> ≤N 格孤立色块并入邻域主色：4~6 治脏，太大会吃细节（保护 Black/White）<br>
        <b>denoise</b> 3×3×3 去噪轮数：会吃 1 格宽细线（闭眼/刻线），查特征丢失时设 0 对照<br>
        <b>darkdetail</b> 细黑线保底占比（默认 0.32）：闭眼、嘴缝、刻线<br>
        <b>缩放</b> 先按高分辨率切再归并减半，不要直接降 courses 重切；细结构会变粗或断开，交付时主动说明
      </div>
    `
  }

  // 深链：#/m/<name>
  navigate()
})()
