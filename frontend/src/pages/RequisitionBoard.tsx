/**
 * /requisitions 领用挂起台
 * 汇总班组栽植 / 补植领用登记：已扣减、挂起、已驳回。
 * 扣不下的领用在这里交人定——批准则按当前批次余量扣减（补植回写顺延补做），驳回则不占余量；
 * 无论哪种处理，相关地块的有效栽植与成活率都会立即复算（定稿结论留痕待复认）。
 * 消费模型：Requisition、Seedling、Planting、Replant、Plot
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useCrewStore } from '../stores/crewStore';
import { db } from '../utils/db';
import { batchStock } from '../utils/inventory';
import type { Requisition, RequisitionPurpose, RequisitionStatus } from '../types/requisition';
import { REQUISITION_PURPOSE_OPTIONS } from '../types/requisition';

const STATUS_FILTERS: Array<RequisitionStatus | 'all'> = ['all', '挂起', '已扣减', '已驳回'];

export default function RequisitionBoard() {
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plots = usePlotStore((state) => state.plots);
  const seedlings = usePlotStore((state) => state.seedlings);

  const approvePending = useCrewStore((state) => state.approvePending);
  const dismissPending = useCrewStore((state) => state.dismissPending);

  const { rows, loading } = useIdbTable<Requisition>(db.requisitions, { sortByUpdatedAt: false });

  const [keyword, setKeyword] = useState('');
  const [plotFilter, setPlotFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<RequisitionStatus | 'all'>('all');
  const [purposeFilter, setPurposeFilter] = useState<RequisitionPurpose | 'all'>('all');
  const [rejectTarget, setRejectTarget] = useState<Requisition | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [busy, setBusy] = useState(false);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';
  const seedlingName = (seedlingId: string): string => {
    const row = seedlings.find((item) => item.id === seedlingId);
    return row === undefined ? '（批次已删除）' : `${row.species} · ${row.spec}`;
  };

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (plotFilter !== 'all' && row.plotId !== plotFilter) return false;
        if (statusFilter !== 'all' && row.status !== statusFilter) return false;
        if (purposeFilter !== 'all' && row.purpose !== purposeFilter) return false;
        if (key === '') return true;
        return (
          plotName(row.plotId).toLowerCase().includes(key) ||
          seedlingName(row.seedlingId).toLowerCase().includes(key) ||
          row.operator.toLowerCase().includes(key) ||
          row.note.toLowerCase().includes(key)
        );
      })
      .sort((a, b) => a.requestDate.localeCompare(b.requestDate) || a.createdAt.localeCompare(b.createdAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, plots, seedlings, keyword, plotFilter, statusFilter, purposeFilter]);

  const stats = useMemo(() => {
    const pending = rows.filter((row) => row.status === '挂起');
    const deducted = rows.filter((row) => row.status === '已扣减');
    const rejected = rows.filter((row) => row.status === '已驳回');
    return {
      pendingCount: pending.length,
      pendingStems: pending.reduce((acc, row) => acc + row.count, 0),
      deductedCount: deducted.length,
      deductedStems: deducted.reduce((acc, row) => acc + row.count, 0),
      rejectedCount: rejected.length,
    };
  }, [rows]);

  const handleApprove = async (row: Requisition): Promise<void> => {
    setBusy(true);
    try {
      const result = await approvePending(row.id);
      if (result.tone === 'success') message.success(result.text);
      else message.warning(result.text, 6);
    } finally {
      setBusy(false);
    }
  };

  const openReject = (row: Requisition): void => {
    setRejectTarget(row);
    setRejectNote('');
  };

  const handleReject = async (): Promise<void> => {
    if (rejectTarget === null) return;
    if (rejectNote.trim() === '') {
      message.warning('请填写驳回原因');
      return;
    }
    setBusy(true);
    try {
      await dismissPending(rejectTarget.id, rejectNote.trim());
      message.success('领用已驳回，未占用批次余量');
      setRejectTarget(null);
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnsType<Requisition> = [
    {
      title: '领用日期',
      dataIndex: 'requestDate',
      key: 'requestDate',
      width: 120,
      sorter: (a, b) => a.requestDate.localeCompare(b.requestDate),
    },
    {
      title: '地块',
      key: 'plot',
      width: 170,
      render: (_value, record) => plotName(record.plotId),
    },
    {
      title: '用途',
      dataIndex: 'purpose',
      key: 'purpose',
      width: 80,
      render: (value: RequisitionPurpose) => <Tag color={value === '栽植' ? 'blue' : 'purple'}>{value}</Tag>,
    },
    {
      title: '苗木批次',
      key: 'seedling',
      width: 180,
      render: (_value, record) => seedlingName(record.seedlingId),
    },
    {
      title: '领用株数',
      dataIndex: 'count',
      key: 'count',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.count - b.count,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '当前批次余量',
      key: 'remaining',
      width: 120,
      align: 'right',
      render: (_value, record) => {
        const seedling = seedlings.find((item) => item.id === record.seedlingId);
        if (seedling === undefined) return '—';
        const remaining = batchStock(seedling, rows).remaining;
        return (
          <Typography.Text type={remaining < record.count ? 'danger' : 'success'} strong>
            {remaining.toLocaleString('zh-CN')}
          </Typography.Text>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 100 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      filters: [],
      render: (value: RequisitionStatus, record) => {
        if (value === '已扣减') return <Tag icon={<CheckCircleOutlined />} color="success">已扣减</Tag>;
        if (value === '挂起')
          return (
            <Tooltip title={record.note}>
              <Tag color="error">挂起待确认</Tag>
            </Tooltip>
          );
        return (
          <Tooltip title={record.note}>
            <Tag icon={<CloseCircleOutlined />} color="default">已驳回</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '备注 / 挂起原因',
      dataIndex: 'note',
      key: 'note',
      ellipsis: true,
      render: (value: string) => (
        <Tooltip title={value}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {value || '—'}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 190,
      fixed: 'right',
      render: (_value, record) =>
        record.status === '挂起' ? (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ReloadOutlined />}
              loading={busy}
              onClick={() => void handleApprove(record)}
            >
              批准扣减
            </Button>
            <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => openReject(record)}>
              驳回
            </Button>
          </Space>
        ) : (
          record.status === '已驳回' ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleApprove(record)}>
              重新判扣
            </Button>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已结清
            </Typography.Text>
          )
        ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge
          label="挂起待确认"
          value={stats.pendingCount}
          suffix={`笔 / ${stats.pendingStems.toLocaleString('zh-CN')} 株`}
          tone={stats.pendingCount > 0 ? 'danger' : 'default'}
          icon={<CloseCircleOutlined />}
        />
        <StatBadge
          label="已扣减领用"
          value={stats.deductedCount}
          suffix={`笔 / ${stats.deductedStems.toLocaleString('zh-CN')} 株`}
          tone="success"
        />
        <StatBadge label="已驳回" value={stats.rejectedCount} suffix="笔" tone="default" />
      </div>

      {stats.pendingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${stats.pendingCount} 笔领用超出批次余量（共 ${stats.pendingStems.toLocaleString('zh-CN')} 株），待人工裁定`}
          description="苗圃追加进场或调整退货保存后，系统按领用先后自动重判；也可以在这里直接「批准扣减」（按当前余量再判）或「驳回」（不占余量），处理后成活率立即复算。"
        />
      ) : null}

      <Card title="栽植 / 补植领用登记">
        <FilterBar
          keyword={keyword}
          onKeywordChange={setKeyword}
          fields={[
            {
              key: 'plotId',
              label: '地块',
              options: plots.map((plot) => plot.id),
              optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])),
            },
            { key: 'status', label: '状态', options: ['挂起', '已扣减', '已驳回'] },
            { key: 'purpose', label: '用途', options: [...REQUISITION_PURPOSE_OPTIONS] },
          ]}
          values={{ plotId: plotFilter, status: statusFilter, purpose: purposeFilter }}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setPlotFilter(value);
            if (key === 'status') setStatusFilter(value as RequisitionStatus | 'all');
            if (key === 'purpose') setPurposeFilter(value as RequisitionPurpose | 'all');
          }}
          onReset={() => {
            setKeyword('');
            setPlotFilter('all');
            setStatusFilter('all');
            setPurposeFilter('all');
          }}
          resultText={`命中 ${filtered.length} / ${rows.length} 笔`}
          extra={
            <Space size={6}>
              <Select
                size="small"
                style={{ minWidth: 120 }}
                value={statusFilter}
                onChange={(value: RequisitionStatus | 'all') => setStatusFilter(value)}
                options={STATUS_FILTERS.map((value) => ({ value, label: value === 'all' ? '全部状态' : value }))}
              />
            </Space>
          }
        />

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有领用登记"
            description="班组在栽植记录页提交栽植、在补植计划页推进到「已补植」时，系统会自动生成领用登记并按批次余量扣减。"
          />
        ) : (
          <Table<Requisition>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1320 }}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的领用登记" actionText="重置筛选" onAction={() => setStatusFilter('all')} />,
            }}
          />
        )}
      </Card>

      <Modal
        title="驳回领用"
        open={rejectTarget !== null}
        onCancel={() => setRejectTarget(null)}
        onOk={() => void handleReject()}
        confirmLoading={busy}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          驳回后该笔领用不占用批次余量；栽植领用对应的株数将移出成活率分母并立即复算，定稿结论保留待复认。
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          value={rejectNote}
          onChange={(event) => setRejectNote(event.target.value)}
          placeholder="请填写驳回原因（必填，便于班组核对）"
        />
      </Modal>
    </div>
  );
}
