/**
 * 成活率派生 hook
 * 按地块与测次算成活率、株高增幅与补植建议；被验收台与补植计划页复用。
 * v3 起成活率分母只统计「领用已扣减」的栽植，挂起 / 驳回领用不计入；
 * 已定稿验收展示定稿快照，复算后的差异等待人工复认。
 */
import { useEffect, useMemo, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Survey, RateLevel } from '../types/survey';
import type { Planting } from '../types/planting';
import type { Requisition } from '../types/requisition';
import { db, initDatabase } from '../utils/db';
import { effectivePlantedTotal } from '../utils/inventory';
import {
  SURVIVAL_WARN_RATE,
  calcSurvivalRate,
  heightGrowth,
  rateLevel,
  round1,
  suggestReplantCount,
} from '../utils/rate';

/** 单个测次的成活率数据点 */
export interface SurvivalPoint {
  surveyId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
  /** 该测次的成活率（%）——非定稿记录为实时复算值，定稿记录取定稿快照 */
  rate: number;
  /** 是否已人工定稿 */
  finalized: boolean;
  /** 定稿后是否等待复认 */
  pendingReconfirm: boolean;
  /** 是否被人工复核过等级 */
  gradeManual: boolean;
  level: RateLevel;
}

/** 单个地块的成活率派生汇总 */
export interface SurvivalSummary {
  plotId: string;
  /** 有效栽植总株数（仅已扣减领用对应的栽植计入） */
  totalCount: number;
  /** 按测次排序的数据点 */
  points: SurvivalPoint[];
  /** 最新测次 */
  latest: SurvivalPoint | null;
  /** 上一次测次 */
  previous: SurvivalPoint | null;
  /** 最新成活率（%） */
  latestRate: number;
  /** 与上一测次的成活率差（百分点） */
  trend: number;
  /** 株高增幅（cm） */
  heightDelta: number;
  /** 株高增幅百分比（%） */
  heightPct: number;
  /** 建议补植株数 */
  suggestReplant: number;
  /** 最新等级 */
  level: RateLevel;
  /** 是否低于告警阈值 */
  warn: boolean;
  /** 等待复认的定稿测次数（批次数量变动触发复算后 > 0） */
  pendingReconfirmCount: number;
}

/** 纯函数：由验收记录、栽植记录与领用登记派生地块成活率汇总 */
export function buildSurvivalSummary(
  plotId: string,
  surveys: Survey[],
  plantings: Planting[],
  threshold: number = SURVIVAL_WARN_RATE,
  requisitions: Requisition[] = [],
): SurvivalSummary {
  const totalCount = effectivePlantedTotal(plotId, plantings, requisitions);

  const points: SurvivalPoint[] = surveys
    .filter((row) => row.plotId === plotId)
    .sort((a, b) => a.round - b.round)
    .map((row) => {
      // 定稿结论留痕：展示定稿快照；未定稿展示按有效栽植实时复算的成活率
      const rate = row.finalized
        ? row.finalizedRate
        : totalCount > 0
          ? calcSurvivalRate(row.aliveCount, totalCount)
          : row.survivalRate;
      return {
        surveyId: row.id,
        round: row.round,
        date: row.date,
        aliveCount: row.aliveCount,
        avgHeightCm: row.avgHeightCm,
        rate,
        finalized: row.finalized,
        pendingReconfirm: row.pendingReconfirm,
        gradeManual: row.gradeManual,
        level: row.gradeManual ? row.grade : rateLevel(rate),
      };
    });

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const growth = latest && previous ? heightGrowth(previous.avgHeightCm, latest.avgHeightCm) : { delta: 0, pct: 0 };

  return {
    plotId,
    totalCount,
    points,
    latest,
    previous,
    latestRate: latest ? latest.rate : 0,
    trend: latest && previous ? round1(latest.rate - previous.rate) : 0,
    heightDelta: growth.delta,
    heightPct: growth.pct,
    suggestReplant: latest ? suggestReplantCount(totalCount, latest.aliveCount) : totalCount,
    level: latest ? latest.level : 'poor',
    warn: latest !== null && latest.rate < threshold,
    pendingReconfirmCount: points.filter((point) => point.pendingReconfirm).length,
  };
}

export interface UseSurvivalRateResult {
  summary: SurvivalSummary;
  loading: boolean;
  error: string;
}

/** 空汇总，用于地块不存在或尚无数据时兜底，避免页面白屏 */
export function emptySummary(plotId: string): SurvivalSummary {
  return buildSurvivalSummary(plotId, [], []);
}

/**
 * 订阅某地块的验收、栽植与领用记录，实时派生成活率、株高增幅与补植建议。
 */
export function useSurvivalRate(plotId: string | null, threshold: number = SURVIVAL_WARN_RATE): UseSurvivalRateResult {
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const subscription = liveQuery(async () => {
      await initDatabase();
      const [surveyRows, plantingRows, requisitionRows] = await Promise.all([
        db.surveys.toArray(),
        db.plantings.toArray(),
        db.requisitions.toArray(),
      ]);
      return { surveyRows, plantingRows, requisitionRows };
    }).subscribe({
      next: ({ surveyRows, plantingRows, requisitionRows }) => {
        if (!active) return;
        setSurveys(surveyRows);
        setPlantings(plantingRows);
        setRequisitions(requisitionRows);
        setError('');
        setLoading(false);
      },
      error: (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取成活率数据失败');
        setLoading(false);
      },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const summary = useMemo(
    () =>
      plotId === null
        ? emptySummary('')
        : buildSurvivalSummary(plotId, surveys, plantings, threshold, requisitions),
    [plotId, surveys, plantings, requisitions, threshold],
  );

  return { summary, loading, error };
}
