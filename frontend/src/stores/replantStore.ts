/**
 * 补植计划状态管理（Zustand）
 * 维护补植计划的行内草稿、复核状态与批量选中项；
 * 推进到「已补植」时由班组提交补植领用：批次余量足则扣减并回写缺株 / 成活率，
 * 扣不下则领用挂起，回写顺延到苗圃确认扣减时补做。
 */
import { create } from 'zustand';
import type { Replant, ReplantDraft, ReplantState } from '../types/replant';
import {
  advanceReplantState,
  db,
  exportSnapshot,
  importSnapshot,
  initDatabase,
  putReplant,
  removeReplant,
  resetDatabase,
  type DatabaseSnapshot,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

/** 补植计划筛选条件 */
export interface ReplantFilters {
  plotId: string | 'all';
  state: ReplantState | 'all';
  keyword: string;
}

export interface ReplantStoreState {
  filters: ReplantFilters;
  /** 每行的行内编辑草稿，key = replant id */
  drafts: Record<string, Partial<ReplantDraft>>;
  /** 当前复核选中的状态（用于批量推进） */
  reviewState: ReplantState | 'all';
  selectedIds: string[];
  lastMessage: string;
  revision: number;
  init: () => Promise<void>;
  setFilters: (patch: Partial<ReplantFilters>) => void;
  resetFilters: () => void;
  setDraft: (replantId: string, patch: Partial<ReplantDraft>) => void;
  clearDraft: (replantId: string) => void;
  hasDraft: (replantId: string) => boolean;
  saveDraft: (replantId: string) => Promise<void>;
  createReplant: (draft: ReplantDraft) => Promise<Replant>;
  deleteReplant: (replantId: string) => Promise<void>;
  /** 推进到下一状态；进入「已补植」时提交补植领用并在余量充足时回写 */
  advance: (replantId: string) => Promise<{ state: ReplantState | null; pending: boolean }>;
  setState: (replantId: string, state: ReplantState) => Promise<void>;
  batchAdvance: () => Promise<number>;
  setSelectedIds: (ids: string[]) => void;
  setReviewState: (state: ReplantState | 'all') => void;
  exportAll: () => Promise<DatabaseSnapshot>;
  importAll: (snapshot: DatabaseSnapshot) => Promise<void>;
  resetAll: () => Promise<void>;
}

const EMPTY_FILTERS: ReplantFilters = { plotId: 'all', state: 'all', keyword: '' };
const FLOW: ReplantState[] = ['待补植', '已补植', '已复核'];

export const useReplantStore = create<ReplantStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  drafts: {},
  reviewState: 'all',
  selectedIds: [],
  lastMessage: '',
  revision: 0,

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

  setDraft(replantId, patch) {
    set({ drafts: { ...get().drafts, [replantId]: { ...get().drafts[replantId], ...patch } } });
  },

  clearDraft(replantId) {
    const next = { ...get().drafts };
    delete next[replantId];
    set({ drafts: next });
  },

  hasDraft(replantId) {
    return get().drafts[replantId] !== undefined;
  },

  async saveDraft(replantId) {
    const draft = get().drafts[replantId];
    if (draft === undefined) return;
    const existing = await db.replants.get(replantId);
    if (!existing) return;
    await putReplant({ ...existing, ...draft } as Replant);
    get().clearDraft(replantId);
    set({ revision: get().revision + 1, lastMessage: '草稿已保存到补植计划' });
  },

  async createReplant(draft) {
    const stamp = nowIso();
    const row: Replant = {
      id: uuid('replant'),
      plotId: draft.plotId,
      missingCount: draft.missingCount,
      planDate: draft.planDate,
      species: draft.species,
      seedlingId: draft.seedlingId,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putReplant(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async deleteReplant(replantId) {
    await removeReplant(replantId);
    get().clearDraft(replantId);
    set({
      selectedIds: get().selectedIds.filter((id) => id !== replantId),
      revision: get().revision + 1,
    });
  },

  async advance(replantId) {
    const existing = await db.replants.get(replantId);
    if (!existing) return { state: null, pending: false };
    const index = FLOW.indexOf(existing.state);
    if (index < 0 || index >= FLOW.length - 1) return { state: null, pending: false };
    const next = FLOW[index + 1];
    const result = await advanceReplantState(replantId, next);
    await usePlotStore.getState().refreshCounts();
    const pending = result.requisition?.status === '挂起';
    set({
      revision: get().revision + 1,
      lastMessage:
        next === '已补植'
          ? pending
            ? '补植领用因批次余量不足已挂起，待苗圃确认后扣减并回写成活率'
            : '补植已扣减批次余量，地块缺株数与成活率已回写'
          : `状态已推进为「${next}」`,
    });
    return { state: next, pending };
  },

  async setState(replantId, state) {
    await advanceReplantState(replantId, state);
    set({ revision: get().revision + 1 });
  },

  async batchAdvance() {
    const ids = get().selectedIds;
    let count = 0;
    for (const id of ids) {
      const result = await get().advance(id);
      if (result.state !== null) count += 1;
    }
    set({ selectedIds: [], lastMessage: `已批量推进 ${count} 条补植计划` });
    return count;
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setReviewState(state) {
    set({ reviewState: state });
  },

  async exportAll() {
    return exportSnapshot();
  },

  async importAll(snapshot) {
    await importSnapshot(snapshot);
    set({ revision: get().revision + 1 });
  },

  async resetAll() {
    await resetDatabase();
    set({ drafts: {}, selectedIds: [], revision: get().revision + 1 });
  },
}));
