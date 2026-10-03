/**
 * /plots/:id/seedlings 苗木批次台（苗圃侧）
 * 苗圃只管批次进场、退货与余量：登记进场数量与累计退货，余量 = 进场 - 退货 - 已扣减领用。
 * 批次数量一修改，挂起领用自动重判、相关地块成活率立即复算（定稿结论留痕待复认）。
 * 消费模型：Seedling、Requisition、Plot；复用组件：<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { db, removeSeedling, saveSeedlingBatch } from '../utils/db';
import { batchStock } from '../utils/inventory';
import {
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type Seedling,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import type { Requisition } from '../types/requisition';
import { ROUTES } from '../router';
import { muToM2, round1 } from '../utils/rate';
import { uuid } from '../utils/id';

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  returnedQuantity: number;
  arrivalDate: Dayjs;
}

/** 参考密度：每平方米不超过 2 株（约 0.5 ㎡/株），用于批次数量提示 */
const MAX_PLANTS_PER_M2 = 2;

export default function SeedlingBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const { rows, loading } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const requisitionTable = useIdbTable<Requisition>(db.requisitions, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Seedling | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();

  const plotSeedlings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [rows, id],
  );

  const plotRequisitions = useMemo(
    () => requisitionTable.rows.filter((row) => row.plotId === id),
    [requisitionTable.rows, id],
  );

  const totalQuantity = plotSeedlings.reduce((acc, row) => acc + row.quantity, 0);
  const totalReturned = plotSeedlings.reduce((acc, row) => acc + row.returnedQuantity, 0);
  const totalDeducted = plotSeedlings.reduce(
    (acc, row) => acc + batchStock(row, plotRequisitions).deducted,
    0,
  );
  const totalRemaining = plotSeedlings.reduce(
    (acc, row) => acc + batchStock(row, plotRequisitions).remaining,
    0,
  );
  const pendingRequisitions = plotRequisitions.filter((row) => row.status === '挂起');
  const pendingCount = pendingRequisitions.reduce((acc, row) => acc + row.count, 0);

  const density = plot ? round1(totalQuantity / Math.max(1, muToM2(plot.areaMu))) : 0;
  const overloaded = plot !== undefined && density > MAX_PLANTS_PER_M2;

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      species: '秋茄',
      source: '自育苗',
      spec: '50cm 裸根苗',
      quantity: 1000,
      returnedQuantity: 0,
      arrivalDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: Seedling): void => {
    setEditing(row);
    form.setFieldsValue({
      species: row.species,
      source: row.source,
      spec: row.spec,
      quantity: row.quantity,
      returnedQuantity: row.returnedQuantity,
      arrivalDate: dayjs(row.arrivalDate),
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        plotId: id,
        species: values.species,
        source: values.source,
        spec: values.spec.trim(),
        quantity: values.quantity,
        returnedQuantity: values.returnedQuantity ?? 0,
        arrivalDate: values.arrivalDate.format('YYYY-MM-DD'),
      };
      const stamp = new Date().toISOString();
      const row: Seedling =
        editing === null
          ? { ...payload, id: uuid('seedling'), createdAt: stamp, updatedAt: stamp, revision: 3 }
          : { ...editing, ...payload };
      if (editing === null) {
        await saveSeedlingBatch(row);
        message.success(`已登记进场批次：${payload.species} ${payload.quantity} 株`);
      } else {
        const result = await saveSeedlingBatch(row);
        if (result.autoDeducted > 0) {
          message.success(`批次已更新，${result.autoDeducted} 条挂起领用已自动扣减，成活率已复算`);
        } else if (result.stillPending > 0) {
          message.warning(`批次已更新，仍有 ${result.stillPending} 条领用挂起，待追加进场或人工处理`);
        } else {
          message.success('苗木批次已更新，相关地块成活率已复算');
        }
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: Seedling): Promise<void> => {
    const result = await removeSeedling(row.id);
    message.success(
      result.removedPlantings > 0
        ? `已删除批次（同时清理了 ${result.removedPlantings} 条引用它的栽植与领用记录），成活率已复算`
        : '已删除苗木批次',
    );
  };

  if (!ready) {
    return <Card loading title="苗木批次台（苗圃侧）" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块。可能是链接已过期，或该地块已被删除。`}
        actionText="返回地块台账"
        onAction={() => navigate(ROUTES.plots)}
        extra={
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
            返回
          </Button>
        }
      />
    );
  }

  const columns: ColumnsType<Seedling> = [
    {
      title: '树种',
      dataIndex: 'species',
      key: 'species',
      width: 110,
      render: (value: string) => <Tag color="green">{value}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 90,
      render: (value: string) => <Tag color={value === '自育苗' ? 'cyan' : 'gold'}>{value}</Tag>,
    },
    { title: '规格', dataIndex: 'spec', key: 'spec', width: 150 },
    {
      title: '进场（株）',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '退货（株）',
      dataIndex: 'returnedQuantity',
      key: 'returnedQuantity',
      width: 100,
      align: 'right',
      render: (value: number) =>
        value > 0 ? <Tag color="orange">{value.toLocaleString('zh-CN')}</Tag> : (
          <Typography.Text type="secondary">0</Typography.Text>
        ),
    },
    {
      title: '已扣减领用（株）',
      key: 'deducted',
      width: 130,
      align: 'right',
      render: (_value, record) =>
        batchStock(record, plotRequisitions).deducted.toLocaleString('zh-CN'),
    },
    {
      title: '批次余量（株）',
      key: 'remaining',
      width: 130,
      align: 'right',
      sorter: (a, b) => batchStock(a, plotRequisitions).remaining - batchStock(b, plotRequisitions).remaining,
      render: (_value, record) => {
        const stock = batchStock(record, plotRequisitions);
        const low = stock.remaining <= 0;
        return (
          <Tooltip title="余量 = 进场 - 退货 - 已扣减领用">
            <Typography.Text strong type={low ? 'danger' : undefined}>
              {stock.remaining.toLocaleString('zh-CN')}
            </Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: '进场日期',
      dataIndex: 'arrivalDate',
      key: 'arrivalDate',
      width: 120,
      sorter: (a, b) => a.arrivalDate.localeCompare(b.arrivalDate),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该苗木批次？"
            description="引用该批次的栽植记录与领用登记会被一并清理。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name} · 苗木批次台（苗圃）
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>{plot.substrate}</Tag>
        <Tag color="blue">{plot.restoreMode}</Tag>
        <Typography.Text type="secondary">
          面积 {plot.areaMu} 亩（{Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡）
        </Typography.Text>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="苗木批次" value={plotSeedlings.length} suffix="批" tone="primary" />
        <StatBadge label="进场合计" value={totalQuantity.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge label="累计退货" value={totalReturned.toLocaleString('zh-CN')} suffix="株" tone="warning" />
        <StatBadge label="已扣减领用" value={totalDeducted.toLocaleString('zh-CN')} suffix="株" tone="default" />
        <StatBadge
          label="批次余量合计"
          value={totalRemaining.toLocaleString('zh-CN')}
          suffix="株"
          tone={totalRemaining <= 0 ? 'danger' : 'success'}
          hint="余量 = 进场 - 退货 - 已扣减领用"
        />
        <StatBadge
          label="挂起领用"
          value={pendingRequisitions.length}
          suffix={`条 / ${pendingCount.toLocaleString('zh-CN')} 株`}
          tone={pendingRequisitions.length > 0 ? 'danger' : 'default'}
          hint="班组领用超出批次余量时挂起，追加进场或调整退货后自动重判"
        />
      </div>

      {pendingRequisitions.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${pendingRequisitions.length} 笔领用（共 ${pendingCount.toLocaleString('zh-CN')} 株）超出批次余量，已挂起待苗圃确认`}
          description={
            <Space direction="vertical" size={2}>
              {pendingRequisitions.map((req) => (
                <span key={req.id}>
                  {req.requestDate} {req.operator} · {req.purpose}领用 {req.count.toLocaleString('zh-CN')} 株：
                  {req.note}
                </span>
              ))}
              <span>追加进场 / 调整退货数量保存后，系统按领用先后自动重判并复算成活率；也可到「领用挂起台」人工处理。</span>
            </Space>
          }
          action={
            <Button size="small" type="primary" onClick={() => navigate(ROUTES.requisitions)}>
              去挂起台处理
            </Button>
          }
        />
      ) : null}

      {overloaded ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="苗木批次数量偏多"
          description={`当前地块累计进场 ${totalQuantity} 株，折算密度 ${density} 株/㎡，已超过 ${MAX_PLANTS_PER_M2} 株/㎡ 的参考上限。请核对规格与数量，或拆分到其他地块。`}
        />
      ) : null}

      <Card
        title="苗木批次与来源（苗圃侧）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记进场批次
          </Button>
        }
      >
        {plotSeedlings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="苗圃登记进场苗木的树种、来源、规格、数量与退货数量；班组栽植 / 补植领用自动从批次余量扣减。"
            actionText="登记第一批苗木"
            onAction={openCreate}
          />
        ) : (
          <Table<Seedling>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={plotSeedlings}
            pagination={false}
            scroll={{ x: 1080 }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '登记进场批次' : '编辑批次 · 进场 / 退货'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="source" label="来源" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SOURCE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Form.Item name="spec" label="规格" rules={[{ required: true, message: '请填写苗木规格' }]}>
            <Input placeholder="如：50cm 裸根苗 / 40cm 营养袋苗" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="quantity"
              label="进场数量（株）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写进场数量' }]}
            >
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="returnedQuantity"
              label="累计退货（株）"
              style={{ flex: 1 }}
              tooltip="退货只调减可领余量，不删除进场记录"
            >
              <InputNumber min={0} max={200000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="arrivalDate"
              label="进场日期"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请选择进场日期' }]}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            苗圃只管进场、退货与余量；保存后挂起领用自动重判，相关地块成活率立即复算，已定稿的验收结论会保留并等待复认。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
