/**
 * 领用记录（Requisition）
 * 班组按地块领用苗木：栽植领用与补植领用都从苗木批次里扣。
 * 扣得下的（批次余量足够）状态为「已扣」；扣不下的（超出批次余量）先「挂起」交人定。
 */

/** 领用来源：栽植领用 / 补植领用 */
export type RequisitionKind = '栽植' | '补植';

/** 领用状态：已扣（批次余量足够，已核销） / 挂起（超出余量，待人工定夺） / 已驳回（人工驳回） */
export type RequisitionStatus = '已扣' | '挂起' | '已驳回';

export const REQUISITION_KIND_OPTIONS: RequisitionKind[] = ['栽植', '补植'];
export const REQUISITION_STATUS_OPTIONS: RequisitionStatus[] = ['已扣', '挂起', '已驳回'];

export interface Requisition {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 被扣减的苗木批次 */
  seedlingId: string;
  /** 领用来源：栽植 / 补植 */
  kind: RequisitionKind;
  /** 来源单据 id（栽植记录 id 或补植计划 id），便于追溯 */
  refId: string;
  /** 领用数量（株） */
  quantity: number;
  /** 作业班组 */
  operator: string;
  /** 领用日期 YYYY-MM-DD（栽植日期或补植计划日期） */
  date: string;
  /** 核销状态 */
  status: RequisitionStatus;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建领用记录的入参（id / 时间戳 / 修订号由数据层补齐） */
export type RequisitionInput = Omit<Requisition, 'id' | 'createdAt' | 'updatedAt' | 'revision'>;
