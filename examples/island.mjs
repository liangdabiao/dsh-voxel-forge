// 体素场景示例：鲸鱼浮岛（上游 examples/whale-island.py 的 JS 精简版）。
// 用法：voxel_forge(action="scene", name="鲸鱼岛", code=<本文件内容>)，再 action="gen"。
// 演示全部基本形：revolve（浮岛剖面）/ ellipsoid（鲸身）/ tube（尾茎，≥3 格粗防渲染断）/ repaint（肚皮）/ v.hash01（草皮杂色）。
// 场景文件零 import：hash01 由 v.hash01 提供（确定性伪随机，同坐标永远同值）。
export function build(v) {
  // 浮岛：由上往下半径剖面（顶面草皮 → 岩层收尖），色回调按深度分层
  v.revolve(0, 0, [8, 7, 6, 5, 3.5, 2, 1], 0, (x, y, z, d, r, i) => {
    if (i === 0) return v.hash01(x, y, z, 7) < 0.85 ? 'Green' : 'Bright Green' // 草皮杂色（确定性）
    if (i <= 2) return 'Dark Tan'
    return y < -4 ? 'Reddish Brown' : 'Dark Brown'
  })
  // 鲸身：椭球浮在草皮上方
  v.ellipsoid(0, 5, 0, 6, 3.5, 3.2, 'Medium Blue')
  // 肚皮换色不改几何
  v.repaint((x, y) => y <= 4, 'Dark Blue', ['Medium Blue'])
  // 尾茎：斜向细长体至少 3 格粗（1 格厚在渲染里会断）
  v.tube([[5, 5, 0], [7, 6, 0], [9, 7, 0], [11, 7.5, 0]], 1, 'Medium Blue')
  // 尾鳍：两片展开
  v.tube([[11, 7.5, -2], [12, 7.5, -3]], 0, 'Dark Blue')
  v.tube([[11, 7.5, 2], [12, 7.5, 3]], 0, 'Dark Blue')
  // 眼睛：单点小件
  v.put(4, 6, -3, 'White')
  v.put(4, 6, 3, 'White')
}
