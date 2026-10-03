/**
 * 成活率验收（Survey）
 * 按测次登记成活株数与平均株高，成活率由成活株数 / 栽植总株数派生。
 */

/** 成活率等级：优 / 良 / 一般 / 差 */
export type RateLevel = 'excellent' | 'good' | 'fair' | 'poor';

export const RATE_LEVEL_LABEL: Record<RateLevel, string> = {
  excellent: '优',
  good: '良',
  fair: '一般',
  poor: '差',
};

export const RATE_LEVEL_OPTIONS: RateLevel[] = ['excellent', 'good', 'fair', 'poor'];

export interface Survey {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 测次（1、2、3……） */
  round: number;
  /** 验收日期 YYYY-MM-DD */
  date: string;
  /** 成活株数 */
  aliveCount: number;
  /** 平均株高（厘米） */
  avgHeightCm: number;
  /** 成活率（百分比，保留 1 位小数）——默认由成活株数 / 栽植总株数派生 */
  survivalRate: number;
  /** 成活率等级——默认按区间自动判定，可人工批量调整 */
  grade: RateLevel;
  /** 该等级是否被人工调整过 */
  gradeManual: boolean;
  /** 验收结论是否已定稿（定稿后留痕，批次数量变动触发复算时不直接覆盖结论） */
  finalized: boolean;
  /** 定稿时间 ISO，未定稿为空串 */
  finalizedAt: string;
  /** 定稿时的栽植总株数快照（复算依据） */
  finalizedTotalCount: number;
  /** 定稿时的成活率快照（%） */
  finalizedRate: number;
  /** 批次数量 / 领用变动导致复算后，定稿结论是否等待人工复认 */
  pendingReconfirm: boolean;
  /** 复算后的最新成活率（%），与 finalizedRate 对照展示 */
  recalculatedRate: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑验收记录的表单草稿 */
export interface SurveyDraft {
  plotId: string;
  round: number;
  date: string;
  aliveCount: number;
  avgHeightCm: number;
}
