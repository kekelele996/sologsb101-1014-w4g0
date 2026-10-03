# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：**苗圃**按批次登记苗木进场、退货与余量；**现场班组**按地块
提交栽植与补植领用，系统按批次余量扣减，扣不下的领用照记但先挂起、交人定；按测次验收成活株数与
株高，批次数量一修改即重算相关地块成活率，定稿的验收结论留痕、等复算完人工复认。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移（v3 回填领用登记） |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts planting.ts survey.ts replant.ts requisition.ts
        ├── stores/             # plotStore.ts surveyStore.ts replantStore.ts crewStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含 RequisitionBoard 领用挂起台）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        ├── scripts/            # smoke-inventory.ts / smoke-upgrade.ts 纯函数与 v2→v3 升级校验
        └── utils/              # rate.ts inventory.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显有效栽植与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次台（苗圃侧）：批次进场、累计退货与余量；改数量即重判挂起领用并复算成活率 |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植领用（班组侧）：录株距与株数即提交领用，按批次余量扣减，扣不下照记挂起 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入、自动算成活率、定稿/复认、低于阈值告警、批量调整等级 |
| `/requisitions` | `pages/RequisitionBoard.tsx` | 领用挂起台：栽植/补植领用汇总，挂起领用人工「批准扣减」或「驳回」，处理后即复算 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核），推进时提交补植领用、行内草稿、JSON 导入导出 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`：
  * `version(1)` 建立全部表；`version(2)` 补齐索引并执行 `.upgrade()` 迁移（`updatedAt`、`[plotId+round]`
    复合索引、`spacingM` 索引、地块缺株回写字段、验收等级字段）；
  * **`version(3)` 苗圃 / 班组职责分离上线**，迁移内容：
    1. `seedlings` 增加 `returnedQuantity`（累计退货数量），批次余量 = 进场 − 退货 − 已扣减领用；
    2. `replants` 增加 `seedlingId`（补植领用批次，按同地块同树种回填匹配）；
    3. `surveys` 增加定稿留痕字段 `finalized / finalizedAt / finalizedTotalCount / finalizedRate /
       pendingReconfirm / recalculatedRate`；
    4. **旧数据没有领用登记，升级时按现有栽植与补植回填**：每条栽植回填一条「栽植 · 已扣减」领用；
       已补植 / 已复核的补植计划回填一条「补植 · 已扣减」领用（`writebackApplied = true`，不重复回写缺株数）。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade |
  | `replants` | id | plotId, planDate, state, species, seedlingId |
  | `requisitions` | id | plotId, seedlingId, purpose, status, plantingId, replantId, requestDate |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 栽植 + 领用 → 验收（含一条已定稿）→ 补植 + 补植领用**：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 6 个苗木批次（其中 1 批含退货 100 株）、6 条栽植记录与 8 条领用登记；
  * **西湾 A 区 `seedling-b2` 刻意只进场 1600 株、班组照记栽植 1800 株**：多出的 200 株领用挂起，
    苗圃把进场数量改到 1800 株后自动扣减，可直接演示「挂起 → 补量 → 自动扣减 → 复算」全链路；
  * 7 条验收记录（西湾 A 区第 2 测次已定稿），3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录、补植计划与领用登记（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **职责分离**：苗圃只在苗木批次台管进场数量、累计退货与批次余量；班组只在栽植页与补植计划页
  提交栽植 / 补植领用。两边各管各的，领用登记（`requisitions`）是唯一的扣减凭据。
* **批次余量** = 进场数量 − 累计退货数量 − 已扣减领用株数；挂起 / 已驳回领用不占余量。
  退货保存时若会使可领数量小于已扣减领用，系统拒绝并提示先由班组撤销相关领用。
* **领用扣减与挂起**：每笔栽植 / 补植都生成领用登记，按批次余量实时扣减；**扣不下的照记为「挂起」，
  交人工裁定**——苗圃在批次台补量 / 调退货保存后按领用先后（FIFO）自动重判，也可在「领用挂起台」
  人工「批准扣减」或「驳回（不占余量）」。
* **成活率** = 成活株数 ÷ **有效栽植总株数**（只统计领用「已扣减」的栽植；挂起 / 驳回对应的株数不计入）
  × 100%（`src/utils/rate.ts` / `src/utils/inventory.ts` 统一口径）。
* **批次数量一修改就复算**：保存批次（进场 / 退货）、领用被批准或驳回、栽植新增 / 改删后，同一 Dexie
  事务内自动重判挂起领用并重算该地块全部测次的成活率。
* **定稿与复认**：验收结论可「定稿」并固化当时成活率快照；之后批次数量变动触发复算时，**定稿结论
  （成活率与等级）保留不动**，只登记复算值并标「定稿待复认」，等人工「复认」后才刷新定稿快照。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时提交补植领用；余量足则扣减并回写地块缺株数、写入最近补植
  日期、按补植后口径重算最新验收成活率；**扣不下则领用挂起，缺株 / 成活率回写顺延到批准扣减时补做**。
* **旧数据升级**：v2 → v3 时按现有栽植与补植回填领用登记（栽植全部回填；已补植 / 已复核补植回填且
  标记回写完成）；导入旧版 JSON 存档同样自动补齐 v3 字段并回填。
* **本地校验脚本**（不依赖浏览器）：
  * `npx esbuild scripts/smoke-inventory.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs`
    校验余量扣减、挂起重判、有效栽植、复算与定稿留痕纯函数；
  * `scripts/smoke-upgrade.ts` 配合 `fake-indexeddb` 校验 v2 → v3 迁移回填与全链路。
