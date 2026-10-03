/**
 * 班组侧状态管理（Zustand）
 * 班组只管栽植与补植领用：登记后系统按批次余量扣减，扣不下先挂起交苗圃确认。
 * 批次进场 / 退货 / 余量由苗圃侧（苗木批次页 + db.saveSeedlingBatch）负责，本 store 不写批次数量。
 */
import { create } from 'zustand';
import type { Planting, PlantingDraft } from '../types/planting';
import type { Requisition } from '../types/requisition';
import {
  createPlantingWithRequisition,
  rejectRequisition,
  removePlantingWithRequisition,
  retryRequisition,
  updatePlantingWithRequisition,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';

export interface CrewMessage {
  /** 栽植 / 补植领用提交后的提示类型 */
  tone: 'success' | 'warning';
  text: string;
}

export interface CrewStoreState {
  revision: number;
  lastMessage: string;
  /** 由栽植 / 补植领用提交结果生成提示文案 */
  describeRequisition: (requisition: Requisition) => CrewMessage;
  submitPlanting: (draft: PlantingDraft) => Promise<CrewMessage>;
  revisePlanting: (plantingId: string, draft: PlantingDraft) => Promise<CrewMessage>;
  discardPlanting: (plantingId: string) => Promise<void>;
  /** 挂起领用：按当前批次余量再判，批准则扣减 */
  approvePending: (requisitionId: string) => Promise<CrewMessage>;
  /** 挂起领用：驳回，不占余量 */
  dismissPending: (requisitionId: string, note: string) => Promise<void>;
}

function messageOf(requisition: Requisition): CrewMessage {
  if (requisition.status === '已扣减') {
    return {
      tone: 'success',
      text: `领用 ${requisition.count} 株已从批次余量扣减（${requisition.purpose}）`,
    };
  }
  return {
    tone: 'warning',
    text: `批次余量不足，领用 ${requisition.count} 株已挂起，待苗圃确认后处理`,
  };
}

export const useCrewStore = create<CrewStoreState>((set, get) => ({
  revision: 0,
  lastMessage: '',

  describeRequisition: messageOf,

  async submitPlanting(draft) {
    const stamp = nowIso();
    const row: Planting = {
      id: uuid('planting'),
      plotId: draft.plotId,
      seedlingId: draft.seedlingId,
      plantDate: draft.plantDate,
      spacingM: draft.spacingM,
      count: draft.count,
      operator: draft.operator,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    const { requisition } = await createPlantingWithRequisition(row);
    set({ revision: get().revision + 1, lastMessage: messageOf(requisition).text });
    return messageOf(requisition);
  },

  async revisePlanting(plantingId, draft) {
    const result = await updatePlantingWithRequisition(plantingId, draft);
    const message = result === null ? { tone: 'success' as const, text: '栽植记录已更新' } : messageOf(result.requisition);
    set({ revision: get().revision + 1, lastMessage: message.text });
    return message;
  },

  async discardPlanting(plantingId) {
    await removePlantingWithRequisition(plantingId);
    set({ revision: get().revision + 1, lastMessage: '栽植记录与对应领用已删除，批次余量已释放' });
  },

  async approvePending(requisitionId) {
    const decision = await retryRequisition(requisitionId);
    if (decision === null) return { tone: 'warning', text: '领用记录不存在或已被处理' };
    const result: CrewMessage = decision.deducted
      ? { tone: 'success', text: `已批准扣减 ${decision.requisition.count} 株，成活率已复算` }
      : { tone: 'warning', text: decision.reason };
    set({ revision: get().revision + 1, lastMessage: result.text });
    return result;
  },

  async dismissPending(requisitionId, note) {
    await rejectRequisition(requisitionId, note);
    set({ revision: get().revision + 1, lastMessage: '领用已驳回，未占用批次余量，成活率已复算' });
  },
}));
