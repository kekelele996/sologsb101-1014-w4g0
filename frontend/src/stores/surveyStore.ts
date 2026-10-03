/**
 * 验收状态管理（Zustand）
 * 维护验收筛选条件、批量选中的记录与成活率等级草稿；
 * 成活率口径统一由 hooks/useSurvivalRate 的纯函数产出（分母只算已扣减领用的栽植）。
 * 定稿结论在批次数量变动触发复算时留痕，复算完由人工复认。
 */
import { create } from 'zustand';
import type { RateLevel, Survey, SurveyDraft } from '../types/survey';
import {
  db,
  finalizeSurvey,
  initDatabase,
  patchSurveyGrades,
  putSurvey,
  reconfirmSurvey,
  removeSurvey,
  unfinalizeSurvey,
} from '../utils/db';
import type { SurvivalSummary } from '../hooks/useSurvivalRate';
import { nowIso, uuid } from '../utils/id';
import { calcSurvivalRate, rateLevel } from '../utils/rate';
import { usePlotStore } from './plotStore';

/** 验收筛选条件（地块 + 等级 + 关键字 + 日期区间） */
export interface SurveyFilters {
  plotId: string | 'all';
  level: RateLevel | 'all';
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: SurveyFilters = { plotId: 'all', level: 'all', keyword: '', from: '', to: '' };

interface SurveyStoreState {
  filters: SurveyFilters;
  /** 批量操作选中的验收记录 id */
  selectedIds: string[];
  /** 批量调整使用的目标等级 */
  gradeDraft: RateLevel;
  /** 每次写操作后的版本号，页面据此重新拉取列表 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  setFilters: (patch: Partial<SurveyFilters>) => void;
  resetFilters: () => void;
  setSelectedIds: (ids: string[]) => void;
  setGradeDraft: (level: RateLevel) => void;
  createSurvey: (draft: SurveyDraft) => Promise<Survey>;
  updateSurvey: (surveyId: string, draft: SurveyDraft) => Promise<void>;
  deleteSurvey: (surveyId: string) => Promise<void>;
  /** 定稿 / 撤销定稿 / 复认 */
  finalize: (surveyId: string) => Promise<void>;
  unfinalize: (surveyId: string) => Promise<void>;
  reconfirm: (surveyId: string) => Promise<void>;
  /** 批量调整成活率等级（人工复核） */
  bulkApplyGrade: (level: RateLevel) => Promise<number>;
  /** 按最新测次生成补植计划（回写地块缺株数） */
  generateReplant: (plotId: string) => Promise<string>;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  rateStats: () => { total: number; warnCount: number; avgRate: number };
}

/** 有效栽植总株数：只统计领用已扣减的栽植 */
function effectivePlantedOf(plotId: string): number {
  const { plantings, requisitions } = usePlotStore.getState();
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

export const useSurveyStore = create<SurveyStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  selectedIds: [],
  gradeDraft: 'good',
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setGradeDraft(level) {
    set({ gradeDraft: level });
  },

  async createSurvey(draft) {
    const total = effectivePlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    const stamp = nowIso();
    const row: Survey = {
      id: uuid('survey'),
      plotId: draft.plotId,
      round: draft.round,
      date: draft.date,
      aliveCount: draft.aliveCount,
      avgHeightCm: draft.avgHeightCm,
      survivalRate,
      grade: rateLevel(survivalRate),
      gradeManual: false,
      finalized: false,
      finalizedAt: '',
      finalizedTotalCount: 0,
      finalizedRate: 0,
      pendingReconfirm: false,
      recalculatedRate: survivalRate,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSurvey(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateSurvey(surveyId, draft) {
    const existing = await db.surveys.get(surveyId);
    if (!existing) return;
    const total = effectivePlantedOf(draft.plotId);
    const survivalRate = calcSurvivalRate(draft.aliveCount, total);
    // 已定稿的验收编辑实测数据时，结论保持定稿快照，差异进入待复认
    const next: Survey = existing.finalized
      ? {
          ...existing,
          plotId: draft.plotId,
          round: draft.round,
          date: draft.date,
          aliveCount: draft.aliveCount,
          avgHeightCm: draft.avgHeightCm,
          recalculatedRate: survivalRate,
          pendingReconfirm: Math.abs(survivalRate - existing.finalizedRate) > 0.05,
        }
      : {
          ...existing,
          plotId: draft.plotId,
          round: draft.round,
          date: draft.date,
          aliveCount: draft.aliveCount,
          avgHeightCm: draft.avgHeightCm,
          survivalRate,
          recalculatedRate: survivalRate,
          pendingReconfirm: false,
        };
    await putSurvey(next);
    set({ revision: get().revision + 1 });
  },

  async deleteSurvey(surveyId) {
    await removeSurvey(surveyId);
    set({ selectedIds: get().selectedIds.filter((id) => id !== surveyId), revision: get().revision + 1 });
  },

  async finalize(surveyId) {
    await finalizeSurvey(surveyId);
    set({ revision: get().revision + 1, lastMessage: '验收结论已定稿，后续复算将保留结论并挂待复认' });
  },

  async unfinalize(surveyId) {
    await unfinalizeSurvey(surveyId);
    set({ revision: get().revision + 1 });
  },

  async reconfirm(surveyId) {
    await reconfirmSurvey(surveyId);
    set({ revision: get().revision + 1, lastMessage: '已按复算结果复认，定稿结论已更新' });
  },

  async bulkApplyGrade(level) {
    const ids = get().selectedIds;
    if (ids.length === 0) return 0;
    // 人工复核只改写等级标注，不改写实测成活率数值，保证数据可追溯
    await patchSurveyGrades(ids, level);
    set({ revision: get().revision + 1, lastMessage: `已批量调整 ${ids.length} 条验收记录的成活率等级` });
    return ids.length;
  },

  async generateReplant(plotId) {
    const summary = get().summaryOf(plotId);
    const plot = usePlotStore.getState().plots.find((row) => row.id === plotId);
    if (!plot) return '地块不存在，无法生成补植计划';
    const missing = summary.suggestReplant;
    if (missing <= 0) return '该地块当前无缺株，无需生成补植计划';
    const seedlings = usePlotStore.getState().seedlings.filter((row) => row.plotId === plotId);
    const seedling = seedlings.find((row) => row.species === '秋茄') ?? seedlings[0];
    const stamp = nowIso();
    await db.replants.put({
      id: uuid('replant'),
      plotId,
      missingCount: missing,
      planDate: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      species: seedling?.species ?? '秋茄',
      seedlingId: seedling?.id ?? '',
      state: '待补植',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    });
    set({ revision: get().revision + 1, lastMessage: `已为「${plot.name}」生成补植计划：缺株 ${missing} 株` });
    return `已生成补植计划：缺株 ${missing} 株`;
  },

  summaryOf(plotId) {
    return usePlotStore.getState().summaryOf(plotId);
  },

  rateStats() {
    const { summaries } = usePlotStore.getState();
    const list = Object.values(summaries);
    const withSurvey = list.filter((item) => item.latest !== null);
    if (withSurvey.length === 0) return { total: 0, warnCount: 0, avgRate: 0 };
    const sum = withSurvey.reduce((acc, item) => acc + item.latestRate, 0);
    return {
      total: withSurvey.length,
      warnCount: withSurvey.filter((item) => item.warn).length,
      avgRate: Math.round((sum / withSurvey.length) * 10) / 10,
    };
  },
}));
