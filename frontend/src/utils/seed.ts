/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 / 领用 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 * v3 起领用登记随栽植 / 补植一并播种，包含一条「批次余量不足、领用挂起」的演示。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { Requisition } from '../types/requisition';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
} as const;

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision'>): Planting {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function surveyRow(
  row: Omit<
    Survey,
    | 'createdAt'
    | 'updatedAt'
    | 'revision'
    | 'grade'
    | 'gradeManual'
    | 'survivalRate'
    | 'finalized'
    | 'finalizedAt'
    | 'finalizedTotalCount'
    | 'finalizedRate'
    | 'pendingReconfirm'
    | 'recalculatedRate'
  > & { finalized?: boolean; finalizedTotalCount?: number },
  total: number,
): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  const finalized = row.finalized ?? false;
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    finalized,
    finalizedAt: finalized ? SEED_TIME : '',
    finalizedTotalCount: finalized ? (row.finalizedTotalCount ?? total) : 0,
    finalizedRate: finalized ? survivalRate : 0,
    pendingReconfirm: false,
    recalculatedRate: survivalRate,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function requisitionRow(row: Omit<Requisition, 'createdAt' | 'updatedAt' | 'revision'>): Requisition {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 地块（3 块，覆盖三种潮位带与三种底质） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),
  ];

  // ---------------- 苗木批次（每地块 2 批；b2 进场 1600、栽植领用 1800 → 挂起 200 株） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, returnedQuantity: 0, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, returnedQuantity: 100, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, returnedQuantity: 0, arrivalDate: '2024-04-28' }),
    // 班组把超出批次余量的领用照记：进场 1600 株，栽植 1800 株，多出的 200 株挂起待苗圃确认
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, returnedQuantity: 0, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, returnedQuantity: 0, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, returnedQuantity: 0, arrivalDate: '2024-03-16' }),
  ];

  // ---------------- 栽植记录（每地块 2 条，引用真实苗木批次） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    // 该条超出批次余量 200 株：班组照记，领用登记挂起，有效栽植按 1600 株口径计算
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1800, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),
  ];

  // 有效栽植总株数（仅「已扣减」领用对应栽植计入；挂起的 planting-b2 按 1600 株口径）
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 1800 + 1600,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收记录（每地块 2–3 个测次；survey-b2 已定稿留痕） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 3060, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow(
      { id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2176, avgHeightCm: 55, finalized: true },
      totalByPlot[SEED_IDS.plotB],
    ),
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),
  ];

  // ---------------- 补植计划（每地块 1 条，覆盖三种状态；指定补植领用批次） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', seedlingId: 'seedling-a1', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 200, planDate: '2025-04-18', species: '白骨壤', seedlingId: 'seedling-b1', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', seedlingId: 'seedling-c1', state: '已复核' }),
  ];

  // ---------------- 领用登记（栽植全部登记；补植仅已补植 / 已复核登记） ----------------
  const requisitions: Requisition[] = [
    requisitionRow({ id: 'requisition-pa1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', purpose: '栽植', plantingId: 'planting-a1', requestDate: '2024-04-12', count: 3000, operator: '东港一班', status: '已扣减', note: '', writebackApplied: false, lastRetryAt: '' }),
    requisitionRow({ id: 'requisition-pa2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', purpose: '栽植', plantingId: 'planting-a2', requestDate: '2024-04-15', count: 2200, operator: '东港二班', status: '已扣减', note: '', writebackApplied: false, lastRetryAt: '' }),
    requisitionRow({ id: 'requisition-pb1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', purpose: '栽植', plantingId: 'planting-b1', requestDate: '2024-05-06', count: 1800, operator: '西湾一班', status: '已扣减', note: '', writebackApplied: false, lastRetryAt: '' }),
    requisitionRow({
      id: 'requisition-pb2',
      plotId: SEED_IDS.plotB,
      seedlingId: 'seedling-b2',
      purpose: '栽植',
      plantingId: 'planting-b2',
      requestDate: '2024-05-09',
      count: 1800,
      operator: '西湾二班',
      status: '挂起',
      note: '批次余量仅 1600 株，不足领用 1800 株，已挂起待苗圃确认（追加进场 200 株后自动扣减）',
      writebackApplied: false,
      lastRetryAt: '',
    }),
    requisitionRow({ id: 'requisition-pc1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', purpose: '栽植', plantingId: 'planting-c1', requestDate: '2024-03-20', count: 4200, operator: '北屿一班', status: '已扣减', note: '', writebackApplied: false, lastRetryAt: '' }),
    requisitionRow({ id: 'requisition-pc2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', purpose: '栽植', plantingId: 'planting-c2', requestDate: '2024-03-24', count: 3800, operator: '北屿二班', status: '已扣减', note: '', writebackApplied: false, lastRetryAt: '' }),
    requisitionRow({ id: 'requisition-rb1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', purpose: '补植', replantId: 'replant-b1', requestDate: '2025-04-20', count: 200, operator: '补植班组', status: '已扣减', note: '', writebackApplied: true, lastRetryAt: '' }),
    requisitionRow({ id: 'requisition-rc1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', purpose: '补植', replantId: 'replant-c1', requestDate: '2024-11-08', count: 560, operator: '补植班组', status: '已扣减', note: '', writebackApplied: true, lastRetryAt: '' }),
  ];

  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.requisitions],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
      await db.requisitions.bulkPut(requisitions);
    },
  );
}
