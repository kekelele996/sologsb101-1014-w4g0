/**
 * /plots/:id/seedlings 苗木批次与来源登记（苗圃侧）
 * 苗圃管批次进场、退货与余量；班组的栽植 / 补植领用从批次余量里扣，扣不下的挂起交人定。
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
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { db, recordSeedlingReturn, rejectRequisition, removeSeedling, saveSeedling } from '../utils/db';
import {
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type Seedling,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import type { Requisition, RequisitionStatus } from '../types/requisition';
import { ROUTES } from '../router';
import { muToM2 } from '../utils/rate';

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: Dayjs;
}

/** 参考密度：每平方米不超过 2 株（约 0.5 ㎡/株），用于批次数量提示 */
const MAX_PLANTS_PER_M2 = 2;

const STATUS_COLOR: Record<RequisitionStatus, string> = {
  已扣: 'green',
  挂起: 'orange',
  已驳回: 'default',
};

export default function SeedlingBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const plantings = usePlotStore((state) => state.plantings);
  const requisitions = usePlotStore((state) => state.requisitions);
  const batchRemainingOf = usePlotStore((state) => state.batchRemainingOf);
  const { rows, loading } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Seedling | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();

  // 退货弹窗
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<Seedling | null>(null);
  const [returnQty, setReturnQty] = useState(0);
  const [returning, setReturning] = useState(false);

  const plotSeedlings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [rows, id],
  );

  const plotRequisitions = useMemo(
    () =>
      requisitions
        .filter((row) => row.plotId === id)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(b.createdAt)),
    [requisitions, id],
  );

  const totalQuantity = plotSeedlings.reduce((acc, row) => acc + row.quantity, 0);
  const totalReturned = plotSeedlings.reduce((acc, row) => acc + (row.returnedQuantity ?? 0), 0);
  const totalDeducted = plotSeedlings.reduce(
    (acc, row) => acc + requisitions.filter((r) => r.seedlingId === row.id && r.status === '已扣').reduce((s, r) => s + r.quantity, 0),
    0,
  );
  const totalRemaining = totalQuantity - totalReturned - totalDeducted;
  const pendingCount = plotRequisitions.filter((row) => row.status === '挂起').length;

  const density = plot ? totalQuantity / Math.max(1, muToM2(plot.areaMu)) : 0;
  const overloaded = plot !== undefined && density > MAX_PLANTS_PER_M2;

  const seedlingLabel = (seedlingId: string): string => {
    const seedling = rows.find((row) => row.id === seedlingId);
    return seedling === undefined ? '（批次已删除）' : `${seedling.species} · ${seedling.spec}`;
  };

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      species: '秋茄',
      source: '自育苗',
      spec: '50cm 裸根苗',
      quantity: 1000,
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
        arrivalDate: values.arrivalDate.format('YYYY-MM-DD'),
      };
      if (editing === null) {
        await saveSeedling({
          id: `seedling-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          ...payload,
          returnedQuantity: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          revision: 3,
        });
        message.success(`已登记苗木批次：${payload.species} ${payload.quantity} 株`);
      } else {
        await saveSeedling({ ...editing, ...payload });
        message.success('苗木批次已更新，相关领用已重新核销');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: Seedling): Promise<void> => {
    const bound = plantings.filter((item) => item.seedlingId === row.id).length;
    await removeSeedling(row.id);
    message.success(
      bound > 0 ? `已删除批次（同时清理了 ${bound} 条引用它的栽植记录与领用）` : '已删除苗木批次',
    );
  };

  const openReturn = (row: Seedling): void => {
    setReturnTarget(row);
    setReturnQty(0);
    setReturnOpen(true);
  };

  const handleReturn = async (): Promise<void> => {
    if (returnTarget === null) return;
    if (returnQty <= 0) {
      message.warning('请填写大于 0 的退货数量');
      return;
    }
    try {
      setReturning(true);
      const remaining = await recordSeedlingReturn(returnTarget.id, returnQty);
      message.success(`已登记退货 ${returnQty} 株，批次余量 ${remaining.toLocaleString('zh-CN')} 株`);
      setReturnOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setReturning(false);
    }
  };

  const handleReject = (row: Requisition): void => {
    modal.confirm({
      title: '驳回这笔挂起的领用？',
      content: `驳回后该笔 ${row.kind}领用 ${row.quantity.toLocaleString('zh-CN')} 株不再占用批次余量，相关地块成活率会重算。`,
      okText: '驳回',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await rejectRequisition(row.id);
        message.success('已驳回该笔领用');
      },
    });
  };

  if (!ready) {
    return <Card loading title="苗木批次与来源登记" />;
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
      render: (value: number) => (value ?? 0).toLocaleString('zh-CN'),
    },
    {
      title: '已扣（株）',
      key: 'deducted',
      width: 100,
      align: 'right',
      render: (_value, record) =>
        requisitions
          .filter((item) => item.seedlingId === record.id && item.status === '已扣')
          .reduce((acc, item) => acc + item.quantity, 0)
          .toLocaleString('zh-CN'),
    },
    {
      title: '余量（株）',
      key: 'remaining',
      width: 110,
      align: 'right',
      sorter: (a, b) => batchRemainingOf(a.id) - batchRemainingOf(b.id),
      render: (_value, record) => {
        const remaining = batchRemainingOf(record.id);
        return (
          <Typography.Text strong type={remaining < 0 ? 'danger' : remaining === 0 ? 'secondary' : undefined}>
            {remaining.toLocaleString('zh-CN')}
          </Typography.Text>
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
      width: 230,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button size="small" type="link" icon={<RollbackOutlined />} onClick={() => openReturn(record)}>
            退货
          </Button>
          <Popconfirm
            title="确认删除该苗木批次？"
            description="引用该批次的栽植记录与领用会被一并清理。"
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

  const requisitionColumns: ColumnsType<Requisition> = [
    { title: '领用日期', dataIndex: 'date', key: 'date', width: 120 },
    {
      title: '类型',
      dataIndex: 'kind',
      key: 'kind',
      width: 90,
      render: (value: string) => <Tag color={value === '栽植' ? 'blue' : 'purple'}>{value}领用</Tag>,
    },
    {
      title: '苗木批次',
      key: 'seedling',
      render: (_value, record) => seedlingLabel(record.seedlingId),
    },
    {
      title: '数量（株）',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 120 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: RequisitionStatus) => <Tag color={STATUS_COLOR[value]}>{value}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_value, record) =>
        record.status === '挂起' ? (
          <Button size="small" type="link" danger onClick={() => handleReject(record)}>
            驳回
          </Button>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
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
          {plot.name}
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
        <StatBadge label="进场苗木合计" value={totalQuantity.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge label="已扣领用" value={totalDeducted.toLocaleString('zh-CN')} suffix="株" tone="success" />
        <StatBadge
          label="批次余量合计"
          value={totalRemaining.toLocaleString('zh-CN')}
          suffix="株"
          tone={totalRemaining < 0 ? 'danger' : 'default'}
          hint="进场 - 退货 - 已扣领用"
        />
        <StatBadge
          label="挂起领用"
          value={pendingCount}
          suffix="笔"
          tone={pendingCount > 0 ? 'warning' : 'default'}
          hint="超出批次余量、扣不下而挂起的领用，交人定"
        />
      </div>

      {pendingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${pendingCount} 笔领用扣不下、已挂起`}
          description="班组的栽植 / 补植领用超出了批次余量。可登记退货或编辑批次数量让系统自动核销，也可以驳回该笔领用。批次数量变动后，相关地块的成活率会自动重算。"
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
        title="苗木批次与来源（苗圃管进场、退货与余量）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记苗木批次
          </Button>
        }
        style={{ marginBottom: 14 }}
      >
        {plotSeedlings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="登记进场苗木的树种、来源、规格与数量，栽植与补植才能领用。"
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
            scroll={{ x: 1100 }}
          />
        )}
      </Card>

      <Card title="领用记录（班组管栽植与补植领用）">
        <Table<Requisition>
          rowKey="id"
          size="middle"
          columns={requisitionColumns}
          dataSource={plotRequisitions}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{
            emptyText: (
              <EmptyPanel
                title="还没有领用记录"
                description="班组登记栽植或补植后，会在这里生成领用并从批次余量里扣。"
              />
            ),
          }}
        />
      </Card>

      <Modal
        title={editing === null ? '登记苗木批次' : '编辑苗木批次'}
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
              rules={[{ required: true, message: '请填写数量' }]}
            >
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
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
            保存后班组可在栽植记录页领用；批次数量变动会触发领用重新核销与成活率重算。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={`登记退货 · ${returnTarget?.species ?? ''} ${returnTarget?.spec ?? ''}`}
        open={returnOpen}
        onCancel={() => setReturnOpen(false)}
        onOk={() => void handleReturn()}
        confirmLoading={returning}
        okText="确认退货"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            当前余量 {returnTarget ? batchRemainingOf(returnTarget.id).toLocaleString('zh-CN') : 0} 株，
            已登记退货 {(returnTarget?.returnedQuantity ?? 0).toLocaleString('zh-CN')} 株。
          </Typography.Text>
          <InputNumber
            min={1}
            max={200000}
            step={100}
            style={{ width: '100%' }}
            value={returnQty}
            onChange={(value) => setReturnQty(value ?? 0)}
            addonBefore="本次退货"
            addonAfter="株"
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            退货后系统按 FIFO 重新核销领用，扣不下的挂起；相关地块成活率自动重算。
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
}
