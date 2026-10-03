/** 纯业务规则冒烟测试：余量扣减、挂起重判、成活率复算、定稿留痕 */
import assert from 'node:assert';
import {
  batchStock,
  settleRequisitions,
  classifyNewRequisition,
  effectivePlantedTotal,
  recomputeSurveyRates,
  reconfirmFinalizedSurvey,
} from '../src/utils/inventory';
import type { Seedling } from '../src/types/seedling';
import type { Requisition } from '../src/types/requisition';
import type { Planting } from '../src/types/planting';
import type { Survey } from '../src/types/survey';

const stamp = '2025-01-01T00:00:00.000Z';

function seedling(quantity: number, returnedQuantity = 0): Seedling {
  return {
    id: 's1',
    plotId: 'p1',
    species: '秋茄',
    source: '自育苗',
    spec: '50cm',
    quantity,
    returnedQuantity,
    arrivalDate: '2025-01-01',
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  };
}

function req(id: string, count: number, status: Requisition['status'], date = '2025-01-02', createdAt = stamp): Requisition {
  return {
    id,
    plotId: 'p1',
    seedlingId: 's1',
    purpose: '栽植',
    plantingId: `pl-${id}`,
    requestDate: date,
    count,
    operator: '一班',
    status,
    note: '',
    writebackApplied: false,
    lastRetryAt: '',
    createdAt,
    updatedAt: stamp,
    revision: 3,
  };
}

// 1. 余量 = 进场 - 退货 - 已扣减
{
  const s = seedling(1000, 100);
  const stock = batchStock(s, [req('a', 300, '已扣减'), req('b', 100, '挂起')]);
  assert.strictEqual(stock.available, 900);
  assert.strictEqual(stock.deducted, 300);
  assert.strictEqual(stock.remaining, 600);
}

// 2. 新领用：余量足 → 已扣减；不足 → 挂起
{
  const s = seedling(500);
  const existing = [req('a', 400, '已扣减')];
  const ok = classifyNewRequisition(req('b', 100, '挂起'), s, existing);
  assert.strictEqual(ok.status, '已扣减');
  const over = classifyNewRequisition(req('c', 101, '挂起'), s, [...existing, ok]);
  assert.strictEqual(over.status, '挂起');
  assert.match(over.note, /余量仅 0 株/);
}

// 3. 批次数量一修改：挂起领用按 FIFO 自动重判，足则扣、不足继续挂起
{
  const pendingPair = (): Requisition[] => [
    req('a', 250, '已扣减', '2025-01-02'),
    req('b', 50, '挂起', '2025-01-03', '2025-01-03T00:00:00Z'),
    req('c', 30, '挂起', '2025-01-04', '2025-01-04T00:00:00Z'),
  ];
  // 追加进场 80 株 → 余量 130：b 先扣 50，c 再扣 30，全部扣下
  const settled = settleRequisitions(seedling(380), pendingPair(), stamp);
  assert.strictEqual(settled[0].row.status, '已扣减');
  assert.strictEqual(settled[1].row.status, '已扣减');

  // 只追加 20 株 → 余量 70：b 扣 50 后只剩 20，c（30 株）仍挂起
  const partial = settleRequisitions(seedling(320), pendingPair(), stamp);
  assert.strictEqual(partial[0].row.status, '已扣减');
  assert.strictEqual(partial[1].changed, false);
  assert.strictEqual(partial[1].row.status, '挂起');
}

// 4. 有效栽植只统计已扣减领用
{
  const plantings: Planting[] = [
    { id: 'pl-a', plotId: 'p1', seedlingId: 's1', plantDate: '2025-01-02', spacingM: 1, count: 100, operator: '一班', createdAt: stamp, updatedAt: stamp, revision: 3 },
    { id: 'pl-b', plotId: 'p1', seedlingId: 's1', plantDate: '2025-01-03', spacingM: 1, count: 40, operator: '一班', createdAt: stamp, updatedAt: stamp, revision: 3 },
    { id: 'pl-x', plotId: 'p2', seedlingId: 's1', plantDate: '2025-01-03', spacingM: 1, count: 999, operator: '一班', createdAt: stamp, updatedAt: stamp, revision: 3 },
  ];
  const requisitions = [req('a', 100, '已扣减'), req('b', 40, '挂起')];
  assert.strictEqual(effectivePlantedTotal('p1', plantings, requisitions), 100);
  // b 扣下后变 140
  const settled = settleRequisitions(seedling(200), [requisitions[0], { ...requisitions[1] }], stamp);
  const next = [requisitions[0], settled[0].row];
  assert.strictEqual(effectivePlantedTotal('p1', plantings, next), 140);
}

// 5. 成活率复算 + 定稿留痕待复认
{
  const makeSurvey = (id: string, finalized = false): Survey => ({
    id,
    plotId: 'p1',
    round: 1,
    date: '2025-02-01',
    aliveCount: 90,
    avgHeightCm: 50,
    survivalRate: 90,
    grade: 'excellent',
    gradeManual: false,
    finalized,
    finalizedAt: finalized ? stamp : '',
    finalizedTotalCount: finalized ? 100 : 0,
    finalizedRate: finalized ? 90 : 0,
    pendingReconfirm: false,
    recalculatedRate: finalized ? 90 : 90,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  });
  // 批次追加进场，挂起扣下后有效栽植 100 → 120：未定稿直接复算 90/120 = 75%
  const [openSurvey] = recomputeSurveyRates([makeSurvey('sv1')], 120);
  assert.strictEqual(openSurvey.survivalRate, 75);
  assert.strictEqual(openSurvey.grade, 'good');
  assert.strictEqual(openSurvey.pendingReconfirm, false);

  // 已定稿：结论保留 90%，recalculatedRate 75%，挂待复认
  const [lockedSurvey] = recomputeSurveyRates([makeSurvey('sv2', true)], 120);
  assert.strictEqual(lockedSurvey.survivalRate, 90);
  assert.strictEqual(lockedSurvey.finalizedRate, 90);
  assert.strictEqual(lockedSurvey.recalculatedRate, 75);
  assert.strictEqual(lockedSurvey.pendingReconfirm, true);
  assert.strictEqual(lockedSurvey.grade, 'excellent');

  // 复认后以 75% 刷新定稿快照，仍为已定稿
  const reconfirmed = reconfirmFinalizedSurvey(lockedSurvey, 120);
  assert.strictEqual(reconfirmed.finalized, true);
  assert.strictEqual(reconfirmed.finalizedRate, 75);
  assert.strictEqual(reconfirmed.survivalRate, 75);
  assert.strictEqual(reconfirmed.pendingReconfirm, false);
}

console.log('inventory rules: all assertions passed');
