# Relic Route Forge — 多区探险关卡任务落位工具

输入：剧情步骤、可并行支线、需要到达的区域、一个已给定的三维场景（区域、连接通道、道具、门、钥匙、交互半径、距离/区域/顺序条件）。

输出：每个任务对象与钥匙的实际场景坐标、朝向站位、交互距离与视线结论、一条逐站步行通关证明（含钥匙拾取顺序与开门时刻）、可复现的验证轨迹；求解失败时给出可定位的冲突。

## 图形入口（主入口）

```bash
npm install
npm run dev
# 打开 http://localhost:5173/
```

界面布局：

- 中间是 **3D 关卡编辑视窗**。左侧任务卡片选中一个任务点，点击场景地面即可移动它；右侧结果区实时重算。滚轮缩放、左键拖动旋转视角，`拖动视角不会误触落位`。
- 左栏列出剧情步骤、钥匙、约束（硬/软标签）与场景说明。
- 右侧五个页签：
  - **空间落位**：每个对象的区域、对象格、站位格、交互距离、视线、候选数、小地图。
  - **任务路线**：`ENTRY → …` 逐站通关证明，每站写明走了多少米、站位距对象多远、拾取/开门时刻；可逐段播放并导出 JSON。
  - **落位依据**：选中任一任务后，这里说明它为什么落在该格——区域类型是否命中、对象格/站位格、交互半径与视线、在哪些可达状态下可达、评分项、相关约束、被拒绝的候选原因。
  - **异常**：按硬/软/警告分组；每条冲突有代码、消息、建议与涉及对象，手动落位被拒绝时点名原因。
  - **多种子**：8 个种子的成立与否、软代价、路线长度、落位签名；点一行即切换到该种子。

顶栏按钮：

- **生成落位**：重新求解（含手动调整）。
- **清除手动调整**：回到纯求解器结果。
- **载入故意不合法配置**：切换到内置的故障场景（依赖环、min>max、钥匙落在自己的门后、seal 被硬性要求放在不存在的 `hall` 区域、硬距离冲突），异常页逐条说明；再点一次返回合法场景。

## 命令行（辅助）

命令行只用于 CI 与无头取证，不是主要入口。

```bash
npm run place -- --seeds 8          # 合法场景
npm run place -- --invalid          # 故意不合法配置
npm run place -- --out artifacts/run.txt
```

输出包含落位、钥匙可达状态、逐站通关证明、每一段路线的米数与格点、冲突、种子表。成立时退出码 0，否则 1。

## 验证方式

```bash
npm test          # 21 个核心测试
npm run build     # vite 生产构建
```

无头界面检查（需要本机 Chromium；仓库另附 `scripts/ui-smoke.mjs`、`scripts/ui-interactions.mjs`，截图写入 `artifacts/`）。

## 为什么不是“钥匙迷宫换皮”

- 依赖表无环并不等于可完成。注册后仍会在地图上按状态空间实际搜索：`(已完成步骤, 已捡钥匙, 最后站位)` 的 Dijkstra，所有转移都是逐格步行路径，没有飞行、传送或“先假设能到”的边缘。
- 钥匙藏点是否安全由**可达状态**决定：某格只有在“该钥匙尚未被捡起”的某个门状态下可达，才算合法藏点。出口直线距离会显示，但明确不作为安全判据。
- 门的守卫是真实占格：关门时格不可走；区域矩形之间留有空隙，连通性只经由显式通道（门/楼梯/坡/舱口），因此绕不过门。
- 高度差用 `maxStep` 约束，上崖必须走楼梯，下谷必须走坡道；路线证明中的每段都是 4 邻接、满足高度差的格点序列。
- 失败时不会静默丢支线：冲突页按对象点名（`DEPENDENCY_CYCLE`、`ROUTE_STATE`、`KEY_BEHIND_GATE`、`KEY_SELF_LOCKED`、`HARD_MAX_DISTANCE`、`MANUAL_CELL_REJECTED`、`MANUAL_APPROACH_BLOCKED` 等）。

## 硬条件与偏好

| 类别 | 硬条件 | 偏好（软） |
| --- | --- | --- |
| 区域 | `requiredKind`（如 seal 必须在 vault）、对象必须落在可行走区域格 | `zoneHint` / `preferredZone` 命中加分 |
| 距离 | 约束里 `hard: true` 的 `minDist` / `maxDist`；失败即不成立 | `hard: false` 的同类约束，按权重折算为软代价 |
| 顺序 | `requires` 依赖必须真正可达后才可完成 | `seq` 只影响评分，不直接判死；顺序倒置给 `STORY_ORDER` 警告 |
| 交互 | 站位必须在半径内、需要视线时必须有视线、站位不能是门格或被别的对象占用 | 靠近半径边缘、站位跨区、狭窄站位会加软代价 |

求解器按软代价 + 硬惩罚在多候选中挑选；只要有一条硬冲突，结果就是“未成立”，并在异常页列出。

## 场景与故障注入

内置场景 **Amber Reach**：plaza、gallery、shrine（下沉 -1.2 m）、garden、tunnel、cliff（+2.4 m）、vault（-1.2 m，单向出口）；三条支线（sun-shard、hermit/herb、cache）。区域之间留空，所有连通走 `arch-west`、`arch-east`、`gallery-stair`、`garden-stair`、`vault-ramp`（门 `vault-gate`）、`tunnel-hatch`（门 `tunnel-gate`）。钥匙 `sun-key` 开 vault 门，`vine-key` 开 tunnel 门。

故障场景在 `src/core/demoLevel.ts` 的 `makeInvalidLevel()` 中构造，故意注入的每一条都可在异常页对上。

## 代码结构

```
src/core/types.ts            关卡、落位、证明、冲突的数据模型
src/core/nav.ts              高度感知 4 邻接导航网格、道具腐蚀、门格、视线、寻路
src/core/demoLevel.ts        合法场景 + 故意不合法场景
src/core/staticAnalysis.ts   Tarjan 环检测、拓扑序、静态冲突（距离窗口、门可解锁性等）
src/core/placement.ts        候选空间、钥匙安全格、多种子落位、软/硬目标、手动重算
src/core/route.ts            精确状态空间规划器 + 逐站证明 + 不可达定位
src/viewport.ts              Three.js 视窗、投影 HTML 标签、路线与标记、点选/拖放
src/render.ts                五个结果页签
src/ui.ts                    卡片与小地图
src/main.ts                  应用装配、手动调整、种子切换、异常联动
scripts/place.mjs            辅助 CLI
tests/core.test.mjs          核心验证
```

## 验证轨迹（示例）

合法场景（`npm run place -- --seeds 4`）：12 站、159.6 m、walk-only；先取 `vine-key`（garden）再进 tunnel 取 `sun-key`，再回到 cliff 取 `sun-shard`，最后进 vault 完成 `seal` 与 `escape`。路线段显示真实爬升（0 → 2.4 m → -1.2 m）。

不合法场景（`npm run place -- --invalid`）：8 条硬冲突，分别定位到依赖环、空距离窗口、钥匙在自己的门后、以及因此无法完成的 `hermit` / `herb` / `escape` / `sun-key`，另有 `seal ↔ exit` 硬距离冲突；没有静默删掉任何支线。
