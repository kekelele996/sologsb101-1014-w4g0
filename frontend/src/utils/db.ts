/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑
 * - v3 起苗圃 / 班组职责分离：
 *   · 苗圃管批次进场数量、退货数量与余量（seedlings.returnedQuantity）；
 *   · 班组每笔栽植 / 补植都生成领用登记（requisitions），按批次余量扣减，扣不下先挂起交人定；
 *   · 批次数量一修改，挂起领用自动重判、相关地块成活率立即复算，定稿验收结论留痕待复认。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Requisition } from '../types/requisition';
import { rateLevel } from './rate';
import {
  classifyNewRequisition,
  effectivePlantedTotal,
  recomputeSurveyRates,
  reconfirmFinalizedSurvey,
  settleRequisitions,
} from './inventory';
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
    this.version(2).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
      seedlings: 'id, plotId, species, source, arrivalDate, quantity',
      plantings: 'id, plotId, seedlingId, plantDate, spacingM',
      // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
      surveys: 'id, plotId, [plotId+round], date, grade',
      replants: 'id, plotId, planDate, state, species',
    });

    // ---------- v3：苗圃 / 班组职责分离，领用登记上线 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species, seedlingId',
        requisitions: 'id, plotId, seedlingId, purpose, status, plantingId, replantId, requestDate',
      })
      .upgrade(async (tx) => {
        // 迁移 1（承接 v2）：补齐行修订时间
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
        // 迁移 2：批次补齐「累计退货数量」
        await tx.table('seedlings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.returnedQuantity !== 'number') row.returnedQuantity = 0;
        });
        // 迁移 3：补植计划补齐「补植领用批次」（同地块同树种优先，否则取地块第一批）
        const seedRows = (await tx.table('seedlings').toArray()) as Seedling[];
        await tx.table('replants').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.seedlingId !== 'string' || row.seedlingId === '') {
            const matched =
              seedRows.find((s) => s.plotId === row.plotId && s.species === row.species) ??
              seedRows.find((s) => s.plotId === row.plotId);
            row.seedlingId = matched?.id ?? '';
          }
        });
        // 迁移 4：验收记录补齐「定稿 / 复算留痕」字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.grade !== 'string') row.grade = rateLevel(Number(row.survivalRate ?? 0));
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.finalized !== 'boolean') row.finalized = false;
          if (typeof row.finalizedAt !== 'string') row.finalizedAt = '';
          if (typeof row.finalizedTotalCount !== 'number') row.finalizedTotalCount = 0;
          if (typeof row.finalizedRate !== 'number') row.finalizedRate = rate;
          if (typeof row.pendingReconfirm !== 'boolean') row.pendingReconfirm = false;
          if (typeof row.recalculatedRate !== 'number') row.recalculatedRate = rate;
        });
        // 迁移 5：旧数据没有领用登记——按现有栽植与补植回填，全部视为已扣减
        const plantRows = (await tx.table('plantings').toArray()) as Planting[];
        const replantRows = (await tx.table('replants').toArray()) as Replant[];
        const stamp = nowIso();
        const backfilled = buildBackfilledRequisitions(plantRows, replantRows, seedRows, stamp);
        if (backfilled.length > 0) await tx.table('requisitions').bulkPut(backfilled);
      });
  }
}

export const db = new MangroveDatabase();

/** 读写事务（Dexie 数组重载统一收口，支持任意张表） */
function rwTx<T>(tables: Table[], fn: () => Promise<T>): Promise<T> {
  return db.transaction('rw', tables, fn) as Promise<T>;
}

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

/* ---------------------- 旧数据领用登记回填（v3 迁移 / 存档导入共用） ---------------------- */

/**
 * 旧数据没有领用登记：升级时按现有栽植与补植回填。
 * - 每条栽植记录回填一条「栽植 · 已扣减」领用；
 * - 已补植 / 已复核的补植计划回填一条「补植 · 已扣减」领用，并标记回写已完成，避免重复回写缺株数。
 */
export function buildBackfilledRequisitions(
  plantings: Planting[],
  replants: Replant[],
  seedlings: Seedling[],
  stamp: string,
): Requisition[] {
  const rows: Requisition[] = plantings.map((planting) => ({
    id: `requisition-planting-${planting.id}`,
    plotId: planting.plotId,
    seedlingId: planting.seedlingId,
    purpose: '栽植',
    plantingId: planting.id,
    requestDate: planting.plantDate,
    count: planting.count,
    operator: planting.operator,
    status: '已扣减',
    note: '升级时按历史栽植记录回填',
    writebackApplied: false,
    lastRetryAt: stamp,
    createdAt: planting.createdAt || stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }));

  replants
    .filter((replant) => replant.state === '已补植' || replant.state === '已复核')
    .forEach((replant) => {
      const seedlingId =
        replant.seedlingId ||
        seedlings.find((s) => s.plotId === replant.plotId && s.species === replant.species)?.id ||
        seedlings.find((s) => s.plotId === replant.plotId)?.id ||
        '';
      rows.push({
        id: `requisition-replant-${replant.id}`,
        plotId: replant.plotId,
        seedlingId,
        purpose: '补植',
        replantId: replant.id,
        requestDate: replant.planDate,
        count: replant.missingCount,
        operator: '补植班组',
        status: '已扣减',
        note: '升级时按历史补植记录回填',
        writebackApplied: true,
        lastRetryAt: stamp,
        createdAt: replant.createdAt || stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      });
    });

  return rows;
}

/* -------------------- 事务内复算：有效栽植总株数 → 成活率 -------------------- */

/** 事务内按有效栽植总株数复算地块全部测次（定稿结论留痕待复认） */
async function recomputePlotSurveysInTx(plotId: string, tx?: typeof db): Promise<void> {
  const database = tx ?? db;
  const [plantings, surveys, requisitions] = await Promise.all([
    database.plantings.where('plotId').equals(plotId).toArray(),
    database.surveys.where('plotId').equals(plotId).toArray(),
    database.requisitions.where('plotId').equals(plotId).toArray(),
  ]);
  const total = effectivePlantedTotal(plotId, plantings, requisitions);
  const next = recomputeSurveyRates(surveys, total);
  const changed = next.filter((row) => {
    const old = surveys.find((item) => item.id === row.id);
    return old !== undefined && (old.survivalRate !== row.survivalRate || old.pendingReconfirm !== row.pendingReconfirm);
  });
  if (changed.length > 0) {
    const stamp = nowIso();
    await database.surveys.bulkPut(next.map((row) => ({ ...row, updatedAt: stamp, revision: ROW_REVISION })));
  }
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

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与领用登记 */
export async function removePlot(id: string): Promise<void> {
  await rwTx(
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.requisitions],
    async () => {
      await db.requisitions.where('plotId').equals(id).delete();
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 苗木批次（苗圃侧） ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({
    ...row,
    returnedQuantity: Math.min(row.returnedQuantity, row.quantity),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

/**
 * 苗圃保存批次（新建 / 修改进场数量或退货数量）。
 * 数量一修改：① 该批次挂起的领用按 FIFO 自动重判；② 重判可能释放有效栽植，
 * 因而立即复算相关地块（批次只归属一个地块）的成活率。
 */
export async function saveSeedlingBatch(row: Seedling): Promise<{ autoDeducted: number; stillPending: number }> {
  let autoDeducted = 0;
  let stillPending = 0;
  await db.transaction('rw', db.seedlings, db.requisitions, db.plantings, db.surveys, async () => {
    const normalized: Seedling = {
      ...row,
      returnedQuantity: Math.max(0, Math.min(row.returnedQuantity, row.quantity)),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    // 退货不能让「进场 - 退货」小于已扣减领用，否则已发苗的领用无着落；
    // 需要调整时先由班组撤销 / 驳回相关领用，再办退货。
    const alreadyDeducted = (await db.requisitions.where('seedlingId').equals(normalized.id).toArray())
      .filter((req) => req.status === '已扣减')
      .reduce((acc, req) => acc + req.count, 0);
    if (normalized.quantity - normalized.returnedQuantity < alreadyDeducted) {
      throw new Error(
        `退货数量过多：该批次已扣减领用 ${alreadyDeducted.toLocaleString('zh-CN')} 株，进场减退货后不能低于此数；请先由班组撤销相关栽植 / 补植领用。`,
      );
    }
    await db.seedlings.put(normalized);
    const requisitions = await db.requisitions.where('seedlingId').equals(normalized.id).toArray();
    const settled = settleRequisitions(normalized, requisitions, nowIso());
    if (settled.length > 0) {
      autoDeducted = settled.filter(({ changed }) => changed).length;
      stillPending = settled.length - autoDeducted;
      // 补植领用在余量补足后自动扣减，补植回写此时补做并登记回写标记，避免重复回写
      const writebackIds = new Set<string>();
      for (const { row: req, changed } of settled) {
        if (changed && req.purpose === '补植' && req.replantId && !req.writebackApplied) {
          const applied = await applyReplantWritebackInTx(req.replantId);
          if (applied) writebackIds.add(req.id);
        }
      }
      await db.requisitions.bulkPut(
        settled.map(({ row: req }) => ({
          ...req,
          writebackApplied: writebackIds.has(req.id) ? true : req.writebackApplied,
          updatedAt: nowIso(),
          revision: ROW_REVISION,
        })),
      );
    }
    await recomputePlotSurveysInTx(normalized.plotId);
  });
  return { autoDeducted, stillPending };
}

/** 删除批次：级联清理其领用与引用它的栽植记录，再复算地块成活率 */
export async function removeSeedling(id: string): Promise<{ plotId: string; removedPlantings: number }> {
  const seedling = await db.seedlings.get(id);
  let removedPlantings = 0;
  await rwTx(
    [db.seedlings, db.plantings, db.requisitions, db.surveys],
    async () => {
      const plantings = await db.plantings.where('seedlingId').equals(id).toArray();
      removedPlantings = plantings.length;
      await db.requisitions.where('seedlingId').equals(id).delete();
      await db.plantings.where('seedlingId').equals(id).delete();
      await db.seedlings.delete(id);
      if (seedling) await recomputePlotSurveysInTx(seedling.plotId);
    },
  );
  return { plotId: seedling?.plotId ?? '', removedPlantings };
}

/* ------------------------------- 栽植（班组侧） ------------------------------- */

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

export interface PlantingSubmitResult {
  requisition: Requisition;
}

/** 班组新增栽植：落栽植记录并同步提交领用，按批次余量扣减，扣不下先挂起 */
export async function createPlantingWithRequisition(row: Planting): Promise<PlantingSubmitResult> {
  let requisition!: Requisition;
  await rwTx(
    [db.plantings, db.seedlings, db.requisitions, db.surveys],
    async () => {
      const stamp = nowIso();
      const planting: Planting = { ...row, createdAt: row.createdAt || stamp, updatedAt: stamp, revision: ROW_REVISION };
      await db.plantings.put(planting);
      const [seedling, existing] = await Promise.all([
        db.seedlings.get(planting.seedlingId),
        db.requisitions.where('seedlingId').equals(planting.seedlingId).toArray(),
      ]);
      const draft: Requisition = {
        id: uuid('requisition'),
        plotId: planting.plotId,
        seedlingId: planting.seedlingId,
        purpose: '栽植',
        plantingId: planting.id,
        requestDate: planting.plantDate,
        count: planting.count,
        operator: planting.operator,
        status: '挂起',
        note: '',
        writebackApplied: false,
        lastRetryAt: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      requisition = classifyNewRequisition(draft, seedling, existing);
      await db.requisitions.put(requisition);
      await recomputePlotSurveysInTx(planting.plotId);
    },
  );
  return { requisition };
}

/** 班组修改栽植（株数 / 批次变化即重新领用：旧领用释放，按当前余量重判）并复算成活率 */
export async function updatePlantingWithRequisition(
  plantingId: string,
  patch: Partial<Planting>,
): Promise<PlantingSubmitResult | null> {
  let result: PlantingSubmitResult | null = null;
  await rwTx(
    [db.plantings, db.seedlings, db.requisitions, db.surveys],
    async () => {
      const existingPlanting = await db.plantings.get(plantingId);
      if (!existingPlanting) return;
      const stamp = nowIso();
      const next: Planting = { ...existingPlanting, ...patch, updatedAt: stamp, revision: ROW_REVISION };
      await db.plantings.put(next);
      // 旧的栽植领用作废重提（释放原批次余量）
      const oldReqs = await db.requisitions.where('plantingId').equals(plantingId).toArray();
      if (oldReqs.length > 0) await db.requisitions.bulkDelete(oldReqs.map((row) => row.id));

      const [seedling, existingReqs] = await Promise.all([
        db.seedlings.get(next.seedlingId),
        db.requisitions.where('seedlingId').equals(next.seedlingId).toArray(),
      ]);
      const draft: Requisition = {
        id: uuid('requisition'),
        plotId: next.plotId,
        seedlingId: next.seedlingId,
        purpose: '栽植',
        plantingId: next.id,
        requestDate: next.plantDate,
        count: next.count,
        operator: next.operator,
        status: '挂起',
        note: '',
        writebackApplied: false,
        lastRetryAt: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      const requisition = classifyNewRequisition(draft, seedling, existingReqs);
      await db.requisitions.put(requisition);
      result = { requisition };
      await recomputePlotSurveysInTx(next.plotId);
    },
  );
  return result;
}

/** 删除栽植：同步作废其领用（释放余量）并复算成活率 */
export async function removePlantingWithRequisition(id: string): Promise<void> {
  await db.transaction('rw', db.plantings, db.requisitions, db.surveys, async () => {
    const planting = await db.plantings.get(id);
    await db.requisitions.where('plantingId').equals(id).delete();
    await db.plantings.delete(id);
    if (planting) await recomputePlotSurveysInTx(planting.plotId);
  });
}

export async function removePlanting(id: string): Promise<void> {
  await removePlantingWithRequisition(id);
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
  await db.surveys.put({
    ...row,
    grade,
    recalculatedRate: row.finalized ? row.recalculatedRate || row.survivalRate : row.survivalRate,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
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

/** 定搞验收结论：固化当时的成活率快照；之后复算只挂「待复认」，不覆盖结论 */
export async function finalizeSurvey(id: string): Promise<void> {
  await db.transaction('rw', db.surveys, db.plantings, db.requisitions, async () => {
    const survey = await db.surveys.get(id);
    if (!survey || survey.finalized) return;
    const [plantings, requisitions] = await Promise.all([
      db.plantings.where('plotId').equals(survey.plotId).toArray(),
      db.requisitions.where('plotId').equals(survey.plotId).toArray(),
    ]);
    const total = effectivePlantedTotal(survey.plotId, plantings, requisitions);
    await db.surveys.put({
      ...survey,
      finalized: true,
      finalizedAt: nowIso(),
      finalizedTotalCount: total,
      finalizedRate: survey.survivalRate,
      recalculatedRate: survey.survivalRate,
      pendingReconfirm: false,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  });
}

/** 撤销定稿 */
export async function unfinalizeSurvey(id: string): Promise<void> {
  const survey = await db.surveys.get(id);
  if (!survey) return;
  await db.surveys.put({
    ...survey,
    finalized: false,
    finalizedAt: '',
    finalizedTotalCount: 0,
    finalizedRate: 0,
    pendingReconfirm: false,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

/** 复认：接受复算结果，刷新定稿快照（结论留痕继续保留为已定稿） */
export async function reconfirmSurvey(id: string): Promise<void> {
  await db.transaction('rw', db.surveys, db.plantings, db.requisitions, async () => {
    const survey = await db.surveys.get(id);
    if (!survey) return;
    const [plantings, requisitions] = await Promise.all([
      db.plantings.where('plotId').equals(survey.plotId).toArray(),
      db.requisitions.where('plotId').equals(survey.plotId).toArray(),
    ]);
    const total = effectivePlantedTotal(survey.plotId, plantings, requisitions);
    await db.surveys.put({
      ...reconfirmFinalizedSurvey(survey, total),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  });
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划（班组侧） ------------------------------ */

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
  await db.transaction('rw', db.replants, db.requisitions, async () => {
    await db.requisitions.where('replantId').equals(id).delete();
    await db.replants.delete(id);
  });
}

/**
 * 事务内补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 * 只在补植领用「已扣减」时执行；返回是否实际回写。
 */
async function applyReplantWritebackInTx(replantId: string): Promise<boolean> {
  const replant = await db.replants.get(replantId);
  if (!replant) return false;
  const plot = await db.plots.get(replant.plotId);
  if (!plot) return false;

  const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
  await db.plots.update(plot.id, {
    missingCount: nextMissing,
    lastReplantDate: today(),
    updatedAt: nowIso(),
  });

  const [plantings, surveys, requisitions] = await Promise.all([
    db.plantings.where('plotId').equals(plot.id).toArray(),
    db.surveys.where('plotId').equals(plot.id).toArray(),
    db.requisitions.where('plotId').equals(plot.id).toArray(),
  ]);
  if (surveys.length === 0) return true;
  const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
  const aliveAfter = latest.aliveCount + replant.missingCount;
  const total = effectivePlantedTotal(plot.id, plantings, requisitions);
  const rateValue = total > 0 ? Math.min(100, (aliveAfter / total) * 100) : latest.survivalRate;
  const rate = Math.round(rateValue * 10) / 10;
  await db.surveys.update(latest.id, {
    aliveCount: aliveAfter,
    survivalRate: latest.finalized ? latest.survivalRate : rate,
    recalculatedRate: rate,
    grade: latest.finalized || latest.gradeManual ? latest.grade : rateLevel(rate),
    // 定稿结论留痕：仅当复算结果与定稿快照不一致时才挂待复认
    pendingReconfirm: latest.finalized ? Math.abs(rate - latest.finalizedRate) > 0.05 : latest.pendingReconfirm,
    updatedAt: nowIso(),
  });
  return true;
}

/**
 * 推进补植状态（待补植 → 已补植 → 已复核）。
 * 推进到「已补植」时班组提交补植领用：批次余量足则扣减并回写缺株 / 成活率；
 * 扣不下则领用挂起交苗圃确认，回写顺延到批准扣减时补做。
 */
export async function advanceReplantState(
  replantId: string,
  next: ReplantState,
): Promise<{ state: ReplantState; requisition?: Requisition }> {
  let requisition: Requisition | undefined;
  await rwTx(
    [db.replants, db.requisitions, db.seedlings, db.plots, db.plantings, db.surveys],
    async () => {
      await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
      if (next !== '已补植') return;
      const replant = await db.replants.get(replantId);
      if (!replant) return;

      // 历史补植可能已回填领用（升级数据），不重复提交
      const existed = await db.requisitions.where('replantId').equals(replantId).first();
      if (existed) {
        requisition = existed;
        if (existed.status === '已扣减' && !existed.writebackApplied) {
          const applied = await applyReplantWritebackInTx(replantId);
          if (applied) await db.requisitions.update(existed.id, { writebackApplied: true, updatedAt: nowIso() });
        }
        return;
      }

      const stamp = nowIso();
      const [seedling, existingReqs] = await Promise.all([
        replant.seedlingId ? db.seedlings.get(replant.seedlingId) : Promise.resolve(undefined),
        replant.seedlingId
          ? db.requisitions.where('seedlingId').equals(replant.seedlingId).toArray()
          : Promise.resolve([] as Requisition[]),
      ]);
      const draft: Requisition = {
        id: uuid('requisition'),
        plotId: replant.plotId,
        seedlingId: replant.seedlingId,
        purpose: '补植',
        replantId: replant.id,
        requestDate: today(),
        count: replant.missingCount,
        operator: '补植班组',
        status: '挂起',
        note: '',
        writebackApplied: false,
        lastRetryAt: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      requisition = classifyNewRequisition(draft, seedling, existingReqs);
      await db.requisitions.put(requisition);
      if (requisition.status === '已扣减') {
        const applied = await applyReplantWritebackInTx(replantId);
        requisition = { ...requisition, writebackApplied: applied };
        await db.requisitions.put({ ...requisition, updatedAt: nowIso(), revision: ROW_REVISION });
      }
    },
  );
  return { state: next, requisition };
}

/* ------------------------------ 领用登记（挂起处理台） ------------------------------ */

export async function listRequisitions(): Promise<Requisition[]> {
  const rows = await db.requisitions.toArray();
  return rows.sort((a, b) => a.requestDate.localeCompare(b.requestDate) || a.createdAt.localeCompare(b.createdAt));
}

export async function listRequisitionsByPlot(plotId: string): Promise<Requisition[]> {
  return db.requisitions.where('plotId').equals(plotId).toArray();
}

export interface RequisitionDecision {
  requisition: Requisition;
  /** 本次是否成功扣减 */
  deducted: boolean;
  /** 仍挂起的原因（成功时为空） */
  reason: string;
}

/** 人工处理挂起领用：按当前批次余量再判一次；批准则扣减，补植回写顺延补做，并复算成活率 */
export async function retryRequisition(id: string): Promise<RequisitionDecision | null> {
  let decision: RequisitionDecision | null = null;
  await rwTx(
    [db.requisitions, db.seedlings, db.plantings, db.surveys, db.replants, db.plots],
    async () => {
      const req = await db.requisitions.get(id);
      if (!req) return;
      const [seedling, existing] = await Promise.all([
        db.seedlings.get(req.seedlingId),
        db.requisitions.where('seedlingId').equals(req.seedlingId).toArray(),
      ]);
      const others = existing.filter((row) => row.id !== req.id && row.status === '已扣减');
      const candidate = { ...req, status: '挂起' as const };
      const rejudged = classifyNewRequisition(candidate, seedling, others);
      const stamp = nowIso();
      if (rejudged.status === '已扣减') {
        const next: Requisition = { ...rejudged, note: '人工确认后扣减', lastRetryAt: stamp, updatedAt: stamp };
        await db.requisitions.put(next);
        if (next.purpose === '补植' && next.replantId && !next.writebackApplied) {
          const applied = await applyReplantWritebackInTx(next.replantId);
          await db.requisitions.update(next.id, { writebackApplied: applied });
        }
        await recomputePlotSurveysInTx(next.plotId);
        decision = { requisition: next, deducted: true, reason: '' };
      } else {
        const reason =
          seedling === undefined
            ? '引用的批次不存在，请苗圃核对'
            : `批次余量仍不足（需 ${req.count} 株），请苗圃追加进场或办理退货调整后再试`;
        const next: Requisition = { ...req, lastRetryAt: stamp, note: reason, updatedAt: stamp };
        await db.requisitions.put(next);
        decision = { requisition: next, deducted: false, reason };
      }
    },
  );
  return decision;
}

/** 人工驳回挂起领用：不扣批次余量；栽植领用不计入成活率分母，并复算地块成活率 */
export async function rejectRequisition(id: string, note: string): Promise<Requisition | null> {
  let next: Requisition | null = null;
  await db.transaction('rw', db.requisitions, db.surveys, db.plantings, async () => {
    const req = await db.requisitions.get(id);
    if (!req) return;
    next = {
      ...req,
      status: '已驳回',
      note: note || '人工驳回，未占用批次余量',
      updatedAt: nowIso(),
    };
    await db.requisitions.put(next);
    await recomputePlotSurveysInTx(req.plotId);
  });
  return next;
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

/** 归一化旧版本存档里缺失的 v3 字段 */
function normalizeSnapshotRows(snapshot: Partial<DatabaseSnapshot>): DatabaseSnapshot {
  const stamp = nowIso();
  const seedlings: Seedling[] = (snapshot.seedlings ?? []).map((row) => ({
    ...row,
    returnedQuantity: typeof row.returnedQuantity === 'number' ? row.returnedQuantity : 0,
  }));
  const replants: Replant[] = (snapshot.replants ?? []).map((row) => ({
    ...row,
    seedlingId:
      typeof row.seedlingId === 'string' && row.seedlingId !== ''
        ? row.seedlingId
        : (seedlings.find((s) => s.plotId === row.plotId && s.species === row.species)?.id ??
          seedlings.find((s) => s.plotId === row.plotId)?.id ??
          ''),
  }));
  const plantings: Planting[] = snapshot.plantings ?? [];
  const surveys: Survey[] = (snapshot.surveys ?? []).map((row) => {
    const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
    return {
      ...row,
      finalized: typeof row.finalized === 'boolean' ? row.finalized : false,
      finalizedAt: typeof row.finalizedAt === 'string' ? row.finalizedAt : '',
      finalizedTotalCount: typeof row.finalizedTotalCount === 'number' ? row.finalizedTotalCount : 0,
      finalizedRate: typeof row.finalizedRate === 'number' ? row.finalizedRate : rate,
      pendingReconfirm: typeof row.pendingReconfirm === 'boolean' ? row.pendingReconfirm : false,
      recalculatedRate: typeof row.recalculatedRate === 'number' ? row.recalculatedRate : rate,
    };
  });
  const requisitions: Requisition[] =
    snapshot.requisitions ??
    buildBackfilledRequisitions(plantings, replants, seedlings, stamp);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: snapshot.exportedAt ?? stamp,
    plots: snapshot.plots ?? [],
    seedlings,
    plantings,
    surveys,
    replants,
    requisitions,
  };
}

/** 用快照覆盖整库（导入存档；旧版存档自动按 v3 口径回填领用） */
export async function importSnapshot(rawSnapshot: Partial<DatabaseSnapshot>): Promise<void> {
  const snapshot = normalizeSnapshotRows(rawSnapshot);
  await rwTx(
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
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.requisitions.bulkPut(snapshot.requisitions.map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await rwTx(
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
