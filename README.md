# Relic Route Forge

多区探险关卡的任务落位工具：把剧情步骤、并行支线和区域条件实际放进给定三维场景，并产出一条逐站步行通关证明。

## 图形入口（主入口）

```bash
npm install
npm run dev
```

浏览器打开 **http://localhost:5173/**。这是任务落位的关卡编辑视窗：

1. 左栏选中一个任务点，在中间 3D 场景点地面即可移动它，右侧结果区自动重算。
2. 使用右侧页签查看 **空间落位 / 任务路线 / 落位依据 / 异常 / 多种子**。
3. 选中任务后，“落位依据”会说明该落位为何成立（区域类型、对象格与站位格、交互半径与视线、可达状态、评分）。
4. 顶栏“载入故意不合法配置”演示可定位的失败；再点一次返回合法场景。
5. 顶栏“载入先后约束案例”载入最小多区场景（hub → 单格长廊 → 门控 vault → 单向出口），可在编辑视窗里选中任务点、点 vault 地面重新布置，右侧“空间落位/任务路线”自动用修补后的内核重算；点到 vault 以外的格子会被拒绝并在“异常”页点名原因，同时保留上一版落位供对照。再点一次返回合法场景。
6. “清除手动调整”回到纯求解器结果。

命令行仅作辅助（CI / 取证）：

```bash
npm run place -- --seeds 8
npm run place -- --invalid
npm test
npm run build
```

界面回归（需先 `npm run dev`）：

```bash
node scripts/ui-ordering.mjs   # 先后约束案例：布置、生成、拒绝反馈
node scripts/ui-smoke.mjs      # 截图巡检
```

详细说明：见 [`docs/README.md`](docs/README.md)。先后约束（门带全宽、钥匙↔通道互相依赖、先拾取后通过 vs 永久对象封路）的最小复现与回归在 `tests/ordering.test.mjs`，用 `npm test` 复跑验证；界面侧的同一案例由 `scripts/ui-ordering.mjs` 驱动并断言。
