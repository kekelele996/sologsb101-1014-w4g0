/**
 * 苗木领用登记（Requisition）
 * 班组侧（栽植 / 补植）每发生一次领用即登记一条，苗圃侧按批次余量扣减：
 * 余量充足 → 已扣减；扣不下 → 挂起，交人工裁定（余量补足后自动重试或人工驳回）。
 */

/** 领用用途：栽植 / 补植 */
export type RequisitionPurpose = '栽植' | '补植';

/** 领用状态：已扣减 / 挂起 / 已驳回 */
export type RequisitionStatus = '已扣减' | '挂起' | '已驳回';

export const REQUISITION_PURPOSE_OPTIONS: RequisitionPurpose[] = ['栽植', '补植'];
export const REQUISITION_STATUS_OPTIONS: RequisitionStatus[] = ['已扣减', '挂起', '已驳回'];

export interface Requisition {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 扣减的苗木批次 */
  seedlingId: string;
  /** 领用用途 */
  purpose: RequisitionPurpose;
  /** 栽植用途：关联的栽植记录 id */
  plantingId?: string;
  /** 补植用途：关联的补植计划 id */
  replantId?: string;
  /** 领用日期 YYYY-MM-DD */
  requestDate: string;
  /** 领用株数 */
  count: number;
  /** 领用人 / 作业班组 */
  operator: string;
  /** 处理状态 */
  status: RequisitionStatus;
  /** 挂起 / 驳回原因或人工备注 */
  note: string;
  /** 补植用途：批准扣减后是否已回写地块缺株数与验收成活数，防止重复回写 */
  writebackApplied: boolean;
  /** 最近一次扣减重试时间 ISO */
  lastRetryAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
