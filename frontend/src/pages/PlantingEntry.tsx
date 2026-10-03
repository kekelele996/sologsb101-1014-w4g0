/**
 * /plots/:id/plantings 栽植记录（班组侧）
 * 班组只管栽植与补植领用：录入株距与株数即提交领用，系统按批次余量扣减；
 * 扣不下的领用照记但先挂起，交苗圃确认（追加进场后自动扣减）。
 * 消费模型：Planting、Seedling、Requisition；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
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
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useCrewStore } from '../stores/crewStore';
import { db } from '../utils/db';
import { batchStock } from '../utils/inventory';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import type { Requisition } from '../types/requisition';
import { ROUTES } from '../router';
import {
  DENSITY_MAX_M2_PER_PLANT,
  DENSITY_MIN_M2_PER_PLANT,
  checkDensity,
  muToM2,
  type DensityCheck,
} from '../utils/rate';

interface PlantingFormValues {
  seedlingId: string;
  plantDate: Dayjs;
  spacingM: number;
  count: number;
  operator: string;
}

const DEFAULT_VALUES: PlantingFormValues = {
  seedlingId: '',
  plantDate: dayjs(),
  spacingM: 1,
  count: 1000,
  operator: '',
};

export default function PlantingEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const submitPlanting = useCrewStore((state) => state.submitPlanting);
  const revisePlanting = useCrewStore((state) => state.revisePlanting);
  const discardPlanting = useCrewStore((state) => state.discardPlanting);

  const seedlingTable = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows, loading } = useIdbTable<Planting>(db.plantings, { sortByUpdatedAt: false });
  const requisitionTable = useIdbTable<Requisition>(db.requisitions, { sortByUpdatedAt: false });

  const [keyword, setKeyword] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Planting | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [density, setDensity] = useState<DensityCheck | null>(null);
  const [form] = Form.useForm<PlantingFormValues>();

  const plotSeedlings = useMemo(
    () => seedlingTable.rows.filter((row) => row.plotId === id),
    [seedlingTable.rows, id],
  );

  const plotRequisitions = useMemo(
    () => requisitionTable.rows.filter((row) => row.plotId === id),
    [requisitionTable.rows, id],
  );

  /** 栽植记录 id → 领用状态 */
  const requisitionByPlanting = useMemo(() => {
    const map = new Map<string, Requisition>();
    plotRequisitions
      .filter((row) => row.purpose === '栽植' && row.plantingId !== undefined)
      .forEach((row) => map.set(row.plantingId as string, row));
    return map;
  }, [plotRequisitions]);

  const plotPlantings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.plantDate.localeCompare(a.plantDate)),
    [rows, id],
  );

  const operatorOptions = useMemo(
    () => Array.from(new Set(plotPlantings.map((row) => row.operator).filter((item) => item !== ''))),
    [plotPlantings],
  );

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return plotPlantings.filter((row) => {
      if (operatorFilter !== 'all' && row.operator !== operatorFilter) return false;
      if (key === '') return true;
      const species = plotSeedlings.find((item) => item.id === row.seedlingId)?.species ?? '';
      return (
        row.operator.toLowerCase().includes(key) ||
        species.toLowerCase().includes(key) ||
        row.plantDate.includes(key)
      );
    });
  }, [plotPlantings, plotSeedlings, keyword, operatorFilter]);

  const totalCount = plotPlantings.reduce((acc, row) => acc + row.count, 0);
  const effectiveCount = plotPlantings
    .filter((row) => requisitionByPlanting.get(row.id)?.status === '已扣减')
    .reduce((acc, row) => acc + row.count, 0);
  const pendingCount = plotPlantings
    .filter((row) => requisitionByPlanting.get(row.id)?.status === '挂起')
    .reduce((acc, row) => acc + row.count, 0);
  const avgSpacing =
    plotPlantings.length === 0
      ? 0
      : Math.round((plotPlantings.reduce((acc, row) => acc + row.spacingM, 0) / plotPlantings.length) * 100) / 100;
  const usedSeedlingIds = new Set(plotPlantings.map((row) => row.seedlingId));

  const seedlingLabel = (seedlingId: string): string => {
    const seedling = seedlingTable.rows.find((row) => row.id === seedlingId);
    return seedling === undefined ? '（批次已删除）' : `${seedling.species} · ${seedling.spec}`;
  };

  /** 表单选中批次的余量提示 */
  const selectedSeedlingId = Form.useWatch('seedlingId', form) as string | undefined;
  const selectedStock = useMemo(() => {
    if (selectedSeedlingId === undefined || selectedSeedlingId === '') return null;
    const seedling = plotSeedlings.find((row) => row.id === selectedSeedlingId);
    if (seedling === undefined) return null;
    return batchStock(seedling, requisitionTable.rows);
  }, [selectedSeedlingId, plotSeedlings, requisitionTable.rows]);

  const openCreate = (): void => {
    setEditing(null);
    setDensity(null);
    form.setFieldsValue({
      ...DEFAULT_VALUES,
      seedlingId: plotSeedlings.length > 0 ? plotSeedlings[0].id : '',
      plantDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: Planting): void => {
    setEditing(row);
    form.setFieldsValue({
      seedlingId: row.seedlingId,
      plantDate: dayjs(row.plantDate),
      spacingM: row.spacingM,
      count: row.count,
      operator: row.operator,
    });
    setDensity(plot === undefined ? null : checkDensity(plot.areaMu, row.spacingM, row.count));
    setOpen(true);
  };

  const handleValuesChange = (): void => {
    if (plot === undefined) return;
    const values = form.getFieldsValue();
    setDensity(checkDensity(plot.areaMu, values.spacingM, values.count));
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        plotId: id,
        seedlingId: values.seedlingId,
        plantDate: values.plantDate.format('YYYY-MM-DD'),
        spacingM: values.spacingM,
        count: values.count,
        operator: values.operator.trim(),
      };
      const result =
        editing === null ? await submitPlanting(payload) : await revisePlanting(editing.id, payload);
      if (result.tone === 'success') {
        message.success(`已登记栽植 ${payload.count} 株，${result.text}`);
      } else {
        message.warning(`栽植已照记，${result.text}`, 6);
      }
      const check = plot === undefined ? null : checkDensity(plot.areaMu, payload.spacingM, payload.count);
      if (check !== null && !check.ok) {
        message.warning(check.message, 6);
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!ready) {
    return <Card loading title="栽植记录（班组侧）" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块，无法登记栽植领用。`}
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

  const columns: ColumnsType<Planting> = [
    {
      title: '栽植日期',
      dataIndex: 'plantDate',
      key: 'plantDate',
      width: 120,
      sorter: (a, b) => a.plantDate.localeCompare(b.plantDate),
    },
    {
      title: '苗木批次',
      key: 'seedling',
      width: 190,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{seedlingLabel(record.seedlingId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {plotSeedlings.find((item) => item.id === record.seedlingId)?.source ?? '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '株距（米）',
      dataIndex: 'spacingM',
      key: 'spacingM',
      width: 96,
      align: 'right',
      render: (value: number) => value.toFixed(2),
    },
    {
      title: '株数',
      dataIndex: 'count',
      key: 'count',
      width: 90,
      align: 'right',
      sorter: (a, b) => a.count - b.count,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '领用扣减',
      key: 'requisitionStatus',
      width: 150,
      render: (_value, record) => {
        const req = requisitionByPlanting.get(record.id);
        if (req === undefined) return <Tag>未登记领用</Tag>;
        if (req.status === '已扣减') return <Tag color="green">已扣减</Tag>;
        if (req.status === '挂起')
          return (
            <Tooltip title={req.note}>
              <Tag color="red">挂起待确认</Tag>
            </Tooltip>
          );
        return (
          <Tooltip title={req.note}>
            <Tag color="default">已驳回</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '平均单株占地',
      key: 'perPlant',
      width: 130,
      align: 'right',
      render: (_value, record) => `${checkDensity(plot.areaMu, record.spacingM, record.count).areaPerPlant} ㎡/株`,
    },
    {
      title: '密度校验',
      key: 'densityCheck',
      width: 100,
      render: (_value, record) => {
        const check = checkDensity(plot.areaMu, record.spacingM, record.count);
        return (
          <Tag color={check.level === 'success' ? 'green' : check.level === 'warning' ? 'orange' : 'red'}>
            {check.ok ? '合理' : check.level === 'warning' ? '偏疏' : '异常'}
          </Tag>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 100 },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该栽植记录？"
            description="对应领用登记一并作废，批次余量随即释放。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await discardPlanting(record.id);
              message.success('栽植记录已删除，领用余量已释放');
            }}
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
          {plot.name} · 栽植领用（班组）
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>
          {plot.areaMu} 亩 / {Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡
        </Tag>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="栽植记录" value={plotPlantings.length} suffix="条" tone="primary" />
        <StatBadge label="账面栽植" value={totalCount.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge
          label="有效栽植（已扣减）"
          value={effectiveCount.toLocaleString('zh-CN')}
          suffix="株"
          tone="success"
          hint="只有已扣减领用的栽植计入成活率分母"
        />
        <StatBadge
          label="挂起未扣"
          value={pendingCount.toLocaleString('zh-CN')}
          suffix="株"
          tone={pendingCount > 0 ? 'danger' : 'default'}
        />
        <StatBadge label="平均株距" value={avgSpacing.toFixed(2)} suffix="米" tone="default" />
        <StatBadge
          label="已引用批次"
          value={`${usedSeedlingIds.size} / ${plotSeedlings.length}`}
          percent={plotSeedlings.length > 0 ? (usedSeedlingIds.size / plotSeedlings.length) * 100 : 0}
          tone="default"
          hint="已被栽植记录引用的苗木批次占全部批次的比例"
        />
      </div>

      {pendingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${pendingCount.toLocaleString('zh-CN')} 株栽植领用超出批次余量，已照记并挂起`}
          description="班组照常作业，扣不下的部分先挂起交苗圃确认；苗圃追加进场后自动扣减，有效栽植与成活率随之复算。"
          action={
            <Button size="small" type="primary" onClick={() => navigate(ROUTES.requisitions)}>
              去挂起台查看
            </Button>
          }
        />
      ) : null}

      {plotSeedlings.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="该地块尚未登记苗木批次"
          description="栽植领用必须引用一个苗木批次，请苗圃先到苗木批次台登记进场苗木。"
          action={
            <Button size="small" onClick={() => navigate(ROUTES.seedlings(plot.id))}>
              去登记苗木批次
            </Button>
          }
        />
      ) : null}

      <Card
        title="栽植记录与领用"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plotSeedlings.length === 0}>
            新增栽植领用
          </Button>
        }
      >
        <FilterBar
          keyword={keyword}
          onKeywordChange={setKeyword}
          fields={[{ key: 'operator', label: '班组', options: operatorOptions }]}
          values={{ operator: operatorFilter }}
          onChange={(key: string, value: string) => {
            if (key === 'operator') setOperatorFilter(value);
          }}
          onReset={() => {
            setKeyword('');
            setOperatorFilter('all');
          }}
          resultText={`命中 ${filtered.length} / ${plotPlantings.length} 条`}
        />

        {plotPlantings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有栽植记录"
            description="录入栽植日期、株距与株数即提交领用，系统自动校验密度并按批次余量扣减；扣不下先挂起交苗圃确认。"
            actionText="新增栽植领用"
            onAction={openCreate}
          />
        ) : (
          <Table<Planting>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1180 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel
                  title="没有符合筛选条件的栽植记录"
                  actionText="重置筛选"
                  onAction={() => {
                    setKeyword('');
                    setOperatorFilter('all');
                  }}
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新增栽植领用' : '编辑栽植领用'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="提交领用"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_VALUES} onValuesChange={handleValuesChange}>
          <Form.Item name="seedlingId" label="苗木批次（苗圃余量扣减来源）" rules={[{ required: true, message: '请选择苗木批次' }]}>
            <Select
              placeholder="选择该地块下的苗木批次"
              options={plotSeedlings.map((row) => {
                const stock = batchStock(row, requisitionTable.rows);
                return {
                  value: row.id,
                  label: `${row.species} · ${row.spec} · 进场 ${row.quantity} 株 / 余量 ${stock.remaining} 株（${row.source}）`,
                };
              })}
            />
          </Form.Item>
          {selectedStock !== null ? (
            <Typography.Text
              type={selectedStock.remaining > 0 ? 'secondary' : 'danger'}
              style={{ fontSize: 12, display: 'block', marginTop: -8, marginBottom: 12 }}
            >
              该批次当前余量 {selectedStock.remaining.toLocaleString('zh-CN')} 株；提交株数超出余量时领用照记但先挂起，交苗圃确认。
            </Typography.Text>
          ) : null}
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plantDate" label="栽植日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="spacingM"
              label="株距（米）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写株距' }]}
            >
              <InputNumber min={0.2} max={10} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="count" label="领用株数" style={{ flex: 1 }} rules={[{ required: true, message: '请填写株数' }]}>
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="作业班组" rules={[{ required: true, message: '请填写作业班组' }]}>
            <Input placeholder="如：东港一班" />
          </Form.Item>

          {density !== null ? (
            <Alert
              type={density.level === 'success' ? 'success' : density.level === 'warning' ? 'warning' : 'error'}
              showIcon
              message={`密度校验：${density.ok ? '合理' : '需要关注'}`}
              description={
                <span>
                  {density.message}
                  <br />
                  合理区间为 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株。
                </span>
              }
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              填写株距与株数后会自动校验密度（合理区间 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株）。
            </Typography.Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
