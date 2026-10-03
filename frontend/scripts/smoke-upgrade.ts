/**
 * v2 → v3 升级集成测试（需在 fake-indexeddb 环境运行）
 * 先构造 v2 旧库（无 returnedQuantity / requisitions / 定稿字段），
 * 再导入应用 db 触发 version(3).upgrade，校验：
 *  - 批次退货字段补齐；
 *  - 旧栽植 / 已补植补植计划回填领用登记（栽植 + 补植口径）；
 *  - 补量后挂起领用自动扣减并复算成活率；
 *  - 定稿验收结论留痕待复认、复认后刷新。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert';

const Dexie = (await import('/workspace/frontend/node_modules/dexie/dist/dexie.mjs')).default;

const DB_NAME = 'gbmangrove';

// ---------- 1. 构造 v2 旧库 ----------
{
  const old = new Dexie(DB_NAME);
  old.version(2).stores({
    plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
    seedlings: 'id, plotId, species, source, arrivalDate, quantity',
    plantings: 'id, plotId, seedlingId, plantDate, spacingM',
    surveys: 'id, plotId, [plotId+round], date, grade',
    replants: 'id, plotId, planDate, state, species',
  });
  const stamp = '2025-01-01T00:00:00.000Z';
  await old.plots.bulkPut([
    { id: 'p1', name: '旧地块', areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中', missingCount: 0, lastReplantDate: '', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.seedlings.bulkPut([
    { id: 's1', plotId: 'p1', species: '秋茄', source: '自育苗', spec: '50cm', quantity: 1000, arrivalDate: '2025-01-01', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.plantings.bulkPut([
    { id: 'pl1', plotId: 'p1', seedlingId: 's1', plantDate: '2025-01-02', spacingM: 1, count: 800, operator: '一班', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.surveys.bulkPut([
    { id: 'sv1', plotId: 'p1', round: 1, date: '2025-02-01', aliveCount: 720, avgHeightCm: 50, survivalRate: 90, grade: 'excellent', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.replants.bulkPut([
    { id: 'rp1', plotId: 'p1', missingCount: 80, planDate: '2025-03-01', species: '秋茄', state: '已复核', createdAt: stamp, updatedAt: stamp, revision: 2 },
  ]);
  await old.close();
}

// ---------- 2. 打开应用数据库，触发 v3 迁移 ----------
process.env.VITE ??= '';
const { db, initDatabase, saveSeedlingBatch, retryRequisition, finalizeSurvey, reconfirmSurvey } = await import(
  '/workspace/frontend/src/utils/db.ts'
);
await initDatabase();

const seedling = await db.seedlings.get('s1');
assert.strictEqual(seedling.returnedQuantity, 0, '批次应补齐退货字段');

const reqs = await db.requisitions.toArray();
const plantingReq = reqs.find((r) => r.plantingId === 'pl1');
assert.ok(plantingReq, '栽植记录应回填领用');
assert.strictEqual(plantingReq.status, '已扣减');
assert.strictEqual(plantingReq.count, 800);
const replantReq = reqs.find((r) => r.replantId === 'rp1');
assert.ok(replantReq, '已补植 / 已复核补植计划应回填补植领用');
assert.strictEqual(replantReq.status, '已扣减');
assert.strictEqual(replantReq.count, 80);
assert.strictEqual(replantReq.writebackApplied, true, '回填的补植领用应标记回写已完成，避免重复回写');
assert.strictEqual(replantReq.seedlingId, 's1', '补植计划应按同地块匹配领用批次');

const replant = await db.replants.get('rp1');
assert.strictEqual(replant.seedlingId, 's1', '补植计划应补齐领用批次');

const survey = await db.surveys.get('sv1');
assert.strictEqual(survey.finalized, false);
assert.strictEqual(survey.recalculatedRate, 90);

// ---------- 3. 班组超量领用 → 挂起；苗圃补量 → 自动扣减 + 复算 ----------
const { createPlantingWithRequisition } = await import('/workspace/frontend/src/utils/db.ts');
const { nowIso, uuid } = await import('/workspace/frontend/src/utils/id.ts');
const stamp2 = nowIso();
await createPlantingWithRequisition({
  id: uuid('planting'),
  plotId: 'p1',
  seedlingId: 's1',
  plantDate: '2025-04-01',
  spacingM: 1,
  count: 300,
  operator: '二班',
  createdAt: stamp2,
  updatedAt: stamp2,
  revision: 3,
});
// 余量：1000 - 800(栽植) - 80(补植) = 120，领用 300 → 挂起
let pending = (await db.requisitions.where('plotId').equals('p1').toArray()).filter((r) => r.status === '挂起');
assert.strictEqual(pending.length, 1);
assert.strictEqual(pending[0].count, 300);

// 有效栽植仍为 800；成活率维持 90%
{
  const { effectivePlantedTotal } = await import('/workspace/frontend/src/utils/inventory.ts');
  const [plantings, requisitions] = await Promise.all([db.plantings.toArray(), db.requisitions.toArray()]);
  assert.strictEqual(effectivePlantedTotal('p1', plantings, requisitions), 800);
}

// 人工先在挂起台「批准扣减」——余量仍不足，应保持挂起
const failed = await retryRequisition(pending[0].id);
assert.strictEqual(failed.deducted, false);

// 苗圃追加进场：1000 → 1300，保存后自动重判
const result = await saveSeedlingBatch({ ...seedling, quantity: 1300 });
assert.strictEqual(result.autoDeducted, 1, '挂起领用应自动扣减');
assert.strictEqual(result.stillPending, 0);

// 有效栽植变为 800 + 300 = 1100；成活率 720/1100 ≈ 65.5%
{
  const { effectivePlantedTotal } = await import('/workspace/frontend/src/utils/inventory.ts');
  const [plantings, requisitions] = await Promise.all([db.plantings.toArray(), db.requisitions.toArray()]);
  assert.strictEqual(effectivePlantedTotal('p1', plantings, requisitions), 1100);
  const sv = await db.surveys.get('sv1');
  assert.strictEqual(sv.survivalRate, 65.5, '未定稿验收应自动复算');
  assert.strictEqual(sv.grade, 'fair');
}

// ---------- 4. 定稿后再补量触发复算 → 留痕待复认 → 复认 ----------
await finalizeSurvey('sv1');
{
  const sv = await db.surveys.get('sv1');
  assert.strictEqual(sv.finalized, true);
  assert.strictEqual(sv.finalizedRate, 65.5);
}
// 苗圃再追加 200 株进场，随后班组提交 200 株栽植领用并扣下，有效栽植 1100 → 1300
await saveSeedlingBatch({ ...(await db.seedlings.get('s1')), quantity: 1500 });
await createPlantingWithRequisition({
  id: uuid('planting'),
  plotId: 'p1',
  seedlingId: 's1',
  plantDate: '2025-05-01',
  spacingM: 1,
  count: 200,
  operator: '三班',
  createdAt: nowIso(),
  updatedAt: nowIso(),
  revision: 3,
});
{
  const sv = await db.surveys.get('sv1');
  assert.strictEqual(sv.finalized, true);
  assert.strictEqual(sv.survivalRate, 65.5, '定稿结论保留');
  assert.strictEqual(sv.finalizedRate, 65.5);
  assert.strictEqual(sv.recalculatedRate, 55.4, '复算值 720/1300 ≈ 55.4');
  assert.strictEqual(sv.pendingReconfirm, true, '应挂待复认');
}
await reconfirmSurvey('sv1');
{
  const sv = await db.surveys.get('sv1');
  assert.strictEqual(sv.finalized, true);
  assert.strictEqual(sv.finalizedRate, 55.4, '复认后定稿快照刷新');
  assert.strictEqual(sv.pendingReconfirm, false);
}

console.log('v2 → v3 upgrade + inventory lifecycle: all assertions passed');
process.exit(0);
