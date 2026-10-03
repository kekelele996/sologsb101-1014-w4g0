/**
 * 批次库存与领用扣减的纯业务规则
 * 职责边界：
 * - 苗圃管批次进场数量、退货数量与余量；
 * - 班组管栽植 / 补植领用，系统按「先进场先扣」对余量扣减；
 * - 余量不足的领用保持「挂起」，批次数量或退货调整后再统一重试，仍不足则继续挂起交人定。
 * 本文件只做纯计算，不触碰数据库，便于在 Dexie 事务内外复用与测试。
 */
import type { Seedling } from '../types/seedling';
import type { Requisition } from '../types/requisition';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import { calcSurvivalRate, rateLevel } from './rate';

/** 批次可用于领用的数量 = 进场数量 - 累计退货数量 */
export function effectiveQuantity(seedling: Seedling): number {
  return Math.max(0, seedling.quantity - seedling.returnedQuantity);
}

/** 某批次已扣减的领用株数（只统计「已扣减」状态，挂起 / 已驳回不占余量） */
export function deductedQuantity(seedlingId: string, requisitions: Requisition[]): number {
  return requisitions
    .filter((row) => row.seedlingId === seedlingId && row.status === '已扣减')
    .reduce((acc, row) => acc + row.count, 0);
}

export interface BatchStock {
  seedlingId: string;
  /** 进场 - 退货 */
  available: number;
  /** 已扣减 */
  deducted: number;
  /** 余量 */
  remaining: number;
}

/** 计算单个批次的余量快照 */
export function batchStock(seedling: Seedling, requisitions: Requisition[]): BatchStock {
  const available = effectiveQuantity(seedling);
  const deducted = deductedQuantity(seedling.id, requisitions);
  return { seedlingId: seedling.id, available, deducted, remaining: Math.max(0, available - deducted) };
}

/**
 * 对某批次挂起的领用做一次余量重判（按领用日期 + 创建时间先进先出）。
 * 返回需要落库的领用记录（仅状态发生变化或需要刷新重试时间的记录由调用方判定）。
 * 不修改入参。
 */
export function settleRequisitions(
  seedling: Seedling,
  requisitions: Requisition[],
  nowIso: string,
): Array<{ row: Requisition; changed: boolean }> {
  const pending = requisitions
    .filter((row) => row.seedlingId === seedling.id && row.status === '挂起')
    .sort((a, b) => a.requestDate.localeCompare(b.requestDate) || a.createdAt.localeCompare(b.createdAt));
  let remaining = batchStock(seedling, requisitions).remaining;
  return pending.map((row) => {
    const touched = { ...row, lastRetryAt: nowIso };
    if (remaining >= row.count) {
      remaining -= row.count;
      return { row: { ...touched, status: '已扣减', note: row.note || '余量补足后自动扣减' }, changed: true };
    }
    return { row: touched, changed: false };
  });
}

/** 尝试让一条新提交 / 重新提交的领用即时扣减；余量不足则挂起 */
export function classifyNewRequisition(
  requisition: Requisition,
  seedling: Seedling | undefined,
  existing: Requisition[],
): Requisition {
  if (seedling === undefined) {
    return { ...requisition, status: '挂起', note: '引用的批次不存在，待人工处理', lastRetryAt: '' };
  }
  const remaining = batchStock(seedling, existing).remaining;
  if (remaining >= requisition.count) {
    return { ...requisition, status: '已扣减', note: '' };
  }
  return {
    ...requisition,
    status: '挂起',
    note: `批次余量仅 ${remaining} 株，不足领用 ${requisition.count} 株，已挂起待苗圃确认`,
    lastRetryAt: '',
  };
}

/**
 * 有效栽植总株数：只有关联领用「已扣减」的栽植记录才计入成活率分母。
 * 挂起 / 已驳回的领用所对应的栽植尚未真正占用批次苗木，不参与成活率口径。
 */
export function effectivePlantedTotal(plotId: string, plantings: Planting[], requisitions: Requisition[]): number {
  const deductedPlantingIds = new Set(
    requisitions
      .filter((row) => row.plotId === plotId && row.purpose === '栽植' && row.status === '已扣减')
      .map((row) => row.plantingId)
      .filter((id): id is string => id !== undefined),
  );
  return plantings
    .filter((row) => row.plotId === plotId && deductedPlantingIds.has(row.id))
    .reduce((acc, row) => acc + row.count, 0);
}

/**
 * 按最新有效栽植总株数复算地块全部测次的成活率。
 * - 未定稿：直接刷新 survivalRate 与自动等级（人工等级保留）；
 * - 已定稿：结论留痕不动，只写 recalculatedRate 并在结果变化时置 pendingReconfirm，等人工复认。
 * 返回新数组（不修改入参）。
 */
export function recomputeSurveyRates(surveys: Survey[], totalCount: number): Survey[] {
  return surveys.map((row) => {
    const nextRate = calcSurvivalRate(row.aliveCount, totalCount);
    if (row.finalized) {
      const changed = Math.abs(nextRate - row.finalizedRate) > 0.05;
      return {
        ...row,
        // 定稿结论（成活率与等级）留痕不动，只登记复算值并在结果变化时挂待复认
        survivalRate: row.finalizedRate,
        grade: row.grade,
        recalculatedRate: nextRate,
        pendingReconfirm: changed,
      };
    }
    return {
      ...row,
      survivalRate: nextRate,
      grade: row.gradeManual ? row.grade : rateLevel(nextRate),
      recalculatedRate: nextRate,
      pendingReconfirm: false,
    };
  });
}

/** 人工复认定稿结论：以复算结果刷新定稿快照，结论继续保留为「已定稿」 */
export function reconfirmFinalizedSurvey(survey: Survey, totalCount: number): Survey {
  const rate = survey.recalculatedRate || survey.survivalRate;
  return {
    ...survey,
    finalized: true,
    finalizedAt: survey.finalizedAt || survey.updatedAt,
    finalizedRate: rate,
    finalizedTotalCount: totalCount,
    survivalRate: rate,
    grade: survey.gradeManual ? survey.grade : rateLevel(rate),
    recalculatedRate: rate,
    pendingReconfirm: false,
  };
}
