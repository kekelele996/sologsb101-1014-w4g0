/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling, SeedlingSpecies } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Requisition, RequisitionStatus } from '../types/requisition';
import { calcSurvivalRate, rateLevel } from './rate';
import { nowIso, today, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  requisitions!: Table<Requisition, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：领用登记（批次核销）+ 退货 + 定稿验收，并按现有栽植与补植回填领用 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity, returnedQuantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade, finalized',
        replants: 'id, plotId, planDate, state, species',
        // 领用表：按批次与状态索引，便于核销与挂起处理
        requisitions: 'id, plotId, seedlingId, kind, status, date, refId',
      })
      .upgrade(async (tx) => {
        // 迁移 4：苗木批次补「退货数量」
        await tx.table('seedlings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.returnedQuantity !== 'number') row.returnedQuantity = 0;
        });
        // 迁移 5：验收记录补「定稿 / 待复算」标记
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.finalized !== 'boolean') row.finalized = false;
          if (row.recalcRate === undefined) row.recalcRate = null;
        });
        // 迁移 6：按现有栽植与补植回填领用登记（旧数据原本没有领用记录）
        await backfillRequisitions(tx);
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 保存苗木批次（新增 / 编辑进场数量或退货数量）。
 * 保存后按 FIFO 重新核销该批次下的领用，并重算相关地块的成活率。
 */
export async function saveSeedling(row: Seedling): Promise<void> {
  await db.transaction('rw', db.seedlings, db.requisitions, db.surveys, async (tx) => {
    await tx.table('seedlings').put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    const affected = await reevaluateBatches(tx, [row.id]);
    await recalcPlotSurvival(tx, affected);
  });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, db.requisitions, db.surveys, async (tx) => {
    // 该批次已被栽植记录 / 领用记录引用时一并清理，避免出现悬空引用
    const reqs = await tx.table('requisitions').where('seedlingId').equals(id).toArray();
    const plotIds = new Set(reqs.map((row) => row.plotId));
    await tx.table('requisitions').where('seedlingId').equals(id).delete();
    await tx.table('plantings').where('seedlingId').equals(id).delete();
    await tx.table('seedlings').delete(id);
    await recalcPlotSurvival(tx, plotIds);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 保存栽植记录并同步生成「栽植领用」：
 * 一条栽植记录对应一条领用，按批次余量 FIFO 核销，扣不下的挂起；
 * 保存后重算相关地块成活率。
 */
export async function savePlantingWithRequisition(row: Planting): Promise<{ status: RequisitionStatus }> {
  return db.transaction('rw', db.plantings, db.requisitions, db.seedlings, db.surveys, async (tx) => {
    const existing = (await tx.table('plantings').get(row.id)) as Planting | undefined;
    await tx.table('plantings').put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    // 先清掉该栽植记录旧的领用（编辑时批次 / 株数可能变化），再重建
    await tx.table('requisitions').where('refId').equals(row.id).delete();
    await tx.table('requisitions').put({
      id: uuid('requisition'),
      plotId: row.plotId,
      seedlingId: row.seedlingId,
      kind: '栽植',
      refId: row.id,
      quantity: row.count,
      operator: row.operator,
      date: row.plantDate,
      status: '挂起',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    } as Requisition);
    const batchIds = [existing?.seedlingId, row.seedlingId].filter((v): v is string => Boolean(v));
    const affected = await reevaluateBatches(tx, batchIds);
    await recalcPlotSurvival(tx, affected);
    const created = await tx.table('requisitions').where('refId').equals(row.id).first();
    return { status: (created?.status ?? '挂起') as RequisitionStatus };
  });
}

/** 删除栽植记录时一并删除其领用，并重算相关地块成活率 */
export async function deletePlantingWithRequisition(id: string): Promise<void> {
  await db.transaction('rw', db.plantings, db.requisitions, db.seedlings, db.surveys, async (tx) => {
    const existing = (await tx.table('plantings').get(id)) as Planting | undefined;
    await tx.table('requisitions').where('refId').equals(id).delete();
    await tx.table('plantings').delete(id);
    if (existing) {
      const affected = await reevaluateBatches(tx, [existing.seedlingId]);
      await recalcPlotSurvival(tx, affected);
    }
  });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写（内部事务）：
 * 1）生成「补植领用」并按批次余量 FIFO 核销（扣不下挂起）；
 * 2）扣减地块缺株数、写入最近补植日期；
 * 3）按补植后的成活株数重算成活率（定稿验收挂起等复算，非定稿自动改写）。
 * 已完成过的补植（已补植 / 已复核）不重复回写成活株数。
 */
async function applyReplantCompletionTx(
  tx: Transaction,
  replant: Replant,
  plot: Plot,
): Promise<void> {
  // 1）补植领用：按同树种余量自动匹配批次
  let batchId = replant.seedlingId;
  if (!batchId) {
    const [seedlings, reqs] = await Promise.all([
      tx.table('seedlings').where('plotId').equals(plot.id).toArray(),
      tx.table('requisitions').where('plotId').equals(plot.id).toArray(),
    ]);
    batchId = pickBatchForSpecies(seedlings as Seedling[], reqs as Requisition[], plot.id, replant.species) ?? undefined;
  }
  if (batchId) {
    await tx.table('replants').update(replant.id, { seedlingId: batchId, updatedAt: nowIso() });
    // 幂等：先清掉该补植计划旧的领用，再重建
    await tx.table('requisitions').where('refId').equals(replant.id).delete();
    await tx.table('requisitions').put({
      id: uuid('requisition'),
      plotId: plot.id,
      seedlingId: batchId,
      kind: '补植',
      refId: replant.id,
      quantity: replant.missingCount,
      operator: '补植班组',
      date: replant.planDate,
      status: '挂起',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    } as Requisition);
    await reevaluateBatches(tx, [batchId]);
  }

  // 2）扣减地块缺株数、写入最近补植日期
  const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
  await tx.table('plots').update(plot.id, {
    missingCount: nextMissing,
    lastReplantDate: today(),
    updatedAt: nowIso(),
  });

  // 3）按补植后的成活株数重算成活率
  const surveys = (await tx.table('surveys').where('plotId').equals(plot.id).toArray()) as Survey[];
  if (surveys.length > 0) {
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    const aliveAfter = latest.aliveCount + replant.missingCount;
    await tx.table('surveys').update(latest.id, { aliveCount: aliveAfter, updatedAt: nowIso() });
  }
  await recalcPlotSurvival(tx, new Set([plot.id]));
}

/** 推进补植状态（待补植 → 已补植 → 已复核）；首次进入「已补植 / 已复核」时触发回写与领用核销 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  await db.transaction('rw', db.replants, db.seedlings, db.requisitions, db.plots, db.surveys, async (tx) => {
    const replant = (await tx.table('replants').get(replantId)) as Replant | undefined;
    if (!replant) return;
    const wasCompleted = replant.state === '已补植' || replant.state === '已复核';
    await tx.table('replants').update(replantId, { state: next, updatedAt: nowIso() });
    if (!wasCompleted && (next === '已补植' || next === '已复核')) {
      const plot = (await tx.table('plots').get(replant.plotId)) as Plot | undefined;
      if (plot) await applyReplantCompletionTx(tx, replant, plot);
    }
  });
}

/* ------------------------------ 领用核销（苗圃管批次、班组管领用） ------------------------------ */

/** 批次余量 = 进场数量 - 退货数量 - 已扣领用合计（株） */
export function batchRemaining(seedling: Seedling, requisitions: Requisition[]): number {
  const deducted = requisitions
    .filter((row) => row.seedlingId === seedling.id && row.status === '已扣')
    .reduce((acc, row) => acc + row.quantity, 0);
  return seedling.quantity - (seedling.returnedQuantity ?? 0) - deducted;
}

/** 按同树种挑一个余量最大的批次（用于补植领用自动匹配），无批次返回 null */
function pickBatchForSpecies(
  seedlings: Seedling[],
  requisitions: Requisition[],
  plotId: string,
  species: SeedlingSpecies,
): string | null {
  let bestId: string | null = null;
  let bestRemaining = 0;
  for (const seedling of seedlings) {
    if (seedling.plotId !== plotId || seedling.species !== species) continue;
    const remaining = batchRemaining(seedling, requisitions.filter((row) => row.seedlingId === seedling.id));
    if (bestId === null || remaining > bestRemaining) {
      bestId = seedling.id;
      bestRemaining = remaining;
    }
  }
  return bestId;
}

/**
 * 重新评估指定批次下所有领用的核销状态（FIFO：先发生的领用优先扣余量，扣不下的挂起）。
 * 已驳回的领用不再参与核销。返回受影响的地块 id 集合。
 */
async function reevaluateBatches(tx: Transaction, seedlingIds: string[]): Promise<Set<string>> {
  const affectedPlots = new Set<string>();
  for (const seedlingId of seedlingIds) {
    const seedling = (await tx.table('seedlings').get(seedlingId)) as Seedling | undefined;
    if (!seedling) continue;
    const rows = (await tx.table('requisitions').where('seedlingId').equals(seedlingId).toArray()) as Requisition[];
    const available = seedling.quantity - (seedling.returnedQuantity ?? 0);
    const ordered = rows
      .filter((row) => row.status !== '已驳回')
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    let cum = 0;
    for (const row of ordered) {
      affectedPlots.add(row.plotId);
      const next: RequisitionStatus = cum + row.quantity <= available ? '已扣' : '挂起';
      if (next === '已扣') cum += row.quantity;
      if (row.status !== next) {
        await tx.table('requisitions').update(row.id, { status: next, updatedAt: nowIso() });
      }
    }
  }
  return affectedPlots;
}

/**
 * 批次数量变动后重算地块成活率：
 * - 非定稿验收：按「已扣栽植领用」合计作为栽植总株数自动改写成活率；
 * - 定稿验收：不立即改写，把复算后的成活率挂起（recalcRate），等人工复算确认。
 */
async function recalcPlotSurvival(tx: Transaction, plotIds: Set<string>): Promise<void> {
  for (const plotId of plotIds) {
    const reqs = (await tx.table('requisitions').where('plotId').equals(plotId).toArray()) as Requisition[];
    const confirmedPlantTotal = reqs
      .filter((row) => row.kind === '栽植' && row.status === '已扣')
      .reduce((acc, row) => acc + row.quantity, 0);
    const surveys = (await tx.table('surveys').where('plotId').equals(plotId).toArray()) as Survey[];
    for (const survey of surveys) {
      const newRate = calcSurvivalRate(survey.aliveCount, confirmedPlantTotal);
      if (survey.finalized) {
        await tx.table('surveys').update(survey.id, {
          recalcRate: survey.survivalRate === newRate ? null : newRate,
          updatedAt: nowIso(),
        });
      } else {
        await tx.table('surveys').update(survey.id, {
          survivalRate: newRate,
          recalcRate: null,
          grade: survey.gradeManual ? survey.grade : rateLevel(newRate),
          updatedAt: nowIso(),
        });
      }
    }
  }
}

/**
 * 升级回填：按现有栽植与补植生成领用登记（旧数据原本没有领用记录）。
 * 一条栽植记录对应一条「栽植领用」；已完成的补植计划（已补植 / 已复核）对应一条「补植领用」。
 * 回填后按批次 FIFO 统一核销一遍。
 */
export async function backfillRequisitions(tx: Transaction): Promise<void> {
  const [plantings, replants, seedlings] = (await Promise.all([
    tx.table('plantings').toArray(),
    tx.table('replants').toArray(),
    tx.table('seedlings').toArray(),
  ])) as [Planting[], Replant[], Seedling[]];

  const rows: Requisition[] = [];
  for (const planting of plantings) {
    rows.push({
      id: uuid('requisition'),
      plotId: planting.plotId,
      seedlingId: planting.seedlingId,
      kind: '栽植',
      refId: planting.id,
      quantity: planting.count,
      operator: planting.operator,
      date: planting.plantDate,
      status: '挂起',
      createdAt: planting.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  }
  for (const replant of replants) {
    if (replant.state !== '已补植' && replant.state !== '已复核') continue;
    const batchId =
      replant.seedlingId ?? pickBatchForSpecies(seedlings, rows, replant.plotId, replant.species) ?? undefined;
    if (!batchId) continue;
    rows.push({
      id: uuid('requisition'),
      plotId: replant.plotId,
      seedlingId: batchId,
      kind: '补植',
      refId: replant.id,
      quantity: replant.missingCount,
      operator: '补植班组',
      date: replant.planDate,
      status: '挂起',
      createdAt: replant.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  }

  if (rows.length > 0) await tx.table('requisitions').bulkPut(rows);
  const batchIds = new Set(rows.map((row) => row.seedlingId));
  await reevaluateBatches(tx, [...batchIds]);
  // 回填后按已扣栽植领用口径重算一遍成活率（非定稿自动改写）
  const plotIds = new Set(rows.map((row) => row.plotId));
  await recalcPlotSurvival(tx, plotIds);
}

export async function listRequisitions(): Promise<Requisition[]> {
  const rows = await db.requisitions.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function listRequisitionsByPlot(plotId: string): Promise<Requisition[]> {
  const rows = await db.requisitions.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function listRequisitionsBySeedling(seedlingId: string): Promise<Requisition[]> {
  const rows = await db.requisitions.where('seedlingId').equals(seedlingId).toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 登记批次退货（苗圃侧）：追加退货数量后重新核销领用并重算成活率。
 * 返回该批次最新余量。
 */
export async function recordSeedlingReturn(seedlingId: string, addQuantity: number): Promise<number> {
  let remaining = 0;
  await db.transaction('rw', db.seedlings, db.requisitions, db.surveys, async (tx) => {
    const seedling = (await tx.table('seedlings').get(seedlingId)) as Seedling | undefined;
    if (!seedling) return;
    const returned = Math.max(0, (seedling.returnedQuantity ?? 0) + addQuantity);
    await tx.table('seedlings').update(seedlingId, { returnedQuantity: returned, updatedAt: nowIso() });
    const affected = await reevaluateBatches(tx, [seedlingId]);
    await recalcPlotSurvival(tx, affected);
    const reqs = (await tx.table('requisitions').where('seedlingId').equals(seedlingId).toArray()) as Requisition[];
    remaining = batchRemaining({ ...seedling, returnedQuantity: returned }, reqs);
  });
  return remaining;
}

/**
 * 驳回挂起的领用（交人定）：驳回后该笔领用不再占用批次余量，
 * 重新核销并重算相关地块成活率。
 */
export async function rejectRequisition(requisitionId: string): Promise<void> {
  await db.transaction('rw', db.requisitions, db.seedlings, db.surveys, async (tx) => {
    const req = (await tx.table('requisitions').get(requisitionId)) as Requisition | undefined;
    if (!req || req.status !== '挂起') return;
    await tx.table('requisitions').update(requisitionId, { status: '已驳回', updatedAt: nowIso() });
    const affected = await reevaluateBatches(tx, [req.seedlingId]);
    await recalcPlotSurvival(tx, affected);
  });
}

/** 验收定稿 / 取消定稿；取消定稿时若存在待复算值则直接采用 */
export async function setSurveyFinalized(surveyId: string, finalized: boolean): Promise<void> {
  await db.transaction('rw', db.surveys, async (tx) => {
    const survey = (await tx.table('surveys').get(surveyId)) as Survey | undefined;
    if (!survey) return;
    if (!finalized && survey.recalcRate !== null) {
      await tx.table('surveys').update(surveyId, {
        finalized: false,
        survivalRate: survey.recalcRate,
        recalcRate: null,
        grade: survey.gradeManual ? survey.grade : rateLevel(survey.recalcRate),
        updatedAt: nowIso(),
      });
    } else {
      await tx.table('surveys').update(surveyId, { finalized, updatedAt: nowIso() });
    }
  });
}

/** 人工确认复算结论：把定稿验收的成活率改写为复算后的新口径值 */
export async function confirmSurveyRecalc(surveyId: string): Promise<void> {
  await db.transaction('rw', db.surveys, async (tx) => {
    const survey = (await tx.table('surveys').get(surveyId)) as Survey | undefined;
    if (!survey || survey.recalcRate === null) return;
    await tx.table('surveys').update(surveyId, {
      survivalRate: survey.recalcRate,
      recalcRate: null,
      grade: survey.gradeManual ? survey.grade : rateLevel(survey.recalcRate),
      updatedAt: nowIso(),
    });
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  requisitions: Requisition[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, requisitions] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.requisitions.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    requisitions,
  };
}

/** 用快照覆盖整库（导入存档）；缺领用登记时按现有栽植与补植回填 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.requisitions],
    async (tx) => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.requisitions.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      if (Array.isArray(snapshot.requisitions) && snapshot.requisitions.length > 0) {
        await db.requisitions.bulkPut(snapshot.requisitions.map((row) => ({ ...row, revision: ROW_REVISION })));
      } else {
        // 旧存档没有领用登记：按现有栽植与补植回填
        await backfillRequisitions(tx);
      }
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.requisitions],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.requisitions.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, requisitions] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.requisitions.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, requisitions };
}
