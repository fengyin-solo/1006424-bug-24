import type { EntryRow } from '@/data/types'

// 反应塔温度告警：三处入口（净化列表、净化详情、值班待办）共用这一份阈值，
// 判定函数也只有这一份，谁都不许在页面里再拿固定数比一次。
export const FLUEGAS_KEY = 'fluegas'
export const CEMS_LEDGER_KEY = 'cemsAlarmLedger'
export const FLUEGAS_DUP_AUDIT_KEY = 'fluegasDupAudit'

export const LINE_NO_FIELD = '净化编号'
export const TOWER_TEMP_FIELD = '反应塔温度'
export const CARBON_FIELD = '活性炭喷射量'
export const OUTLET_TEMP_FIELD = '出口烟气温度'
export const RECORD_TIME_FIELD = '记录时间'

// 反应塔温度工艺区间（℃）：低限以下算偏低，高限以上算偏高。
export const TOWER_TEMP_RANGE = { min: 140, max: 170 } as const
// 活性炭喷射量工艺区间（kg/h）。
export const CARBON_RANGE = { min: 8, max: 20 } as const

// 出口烟气温度 = 反应塔温度 - 固定温降，仅用于详情展示折算，不参与告警判定。
export const OUTLET_TEMP_DROP = 15

// 停运记录留档时落在记录上的快照字段：停运后按这份高低存档，不再重判。
export const ARCHIVED_LABEL_FIELD = '告警留档'
export const ARCHIVED_DETAIL_FIELD = '告警留档明细'
export const ARCHIVED_AT_FIELD = '告警留档时间'
export const ARCHIVED_VERSION_FIELD = '参数版本'

export const FLUEGAS_STATUS = {
  waiting: '待投运',
  running: '运行中',
  stopped: '已停运',
  abnormalFlow: '指标异常',
} as const

export type MetricLevel = '正常' | '偏高' | '偏低' | '数据缺失'

// 告警因子与在线排放监测台账里的核对条目一一对应。
export type AlarmFactor = '反应塔温度' | '活性炭喷射量'

export type MetricReading = {
  factor: AlarmFactor
  value: number | null
  level: MetricLevel
  range: { min: number; max: number }
  unit: string
  message: string
}

export type AlarmVerdict = {
  // 整体高低只可能是这一档：任一因子越限即按该因子的高低挂告警。
  level: MetricLevel
  abnormal: boolean
  metrics: MetricReading[]
  reasons: string[]
}

export type FluegasRow = EntryRow

// 视图行（带派生判定）字段更宽，领域函数按结构读取，不要求它就是入库行。
export type AnyRow = {
  id?: number
  status?: string
  pending?: boolean
  abnormal?: boolean
  [field: string]: unknown
}

export type LedgerStatus = '待核对' | '已核对' | '已消除' | '停运留档'

export type AlarmLedgerRow = EntryRow & {
  净化编号: string
  告警因子: AlarmFactor
  告警高低: Exclude<MetricLevel, '正常' | '数据缺失'>
  实测值: number | null
  单位: string
  台账状态: LedgerStatus
  来源记录: number
  参数版本: number
  发生时间: string
  核对人员: string
  核对备注: string
}

export function toMetricNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'boolean') {
    return null
  }
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  if (text === '') {
    return null
  }
  const parsed = Number(text.replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function checkMetric(
  factor: AlarmFactor,
  rawValue: unknown,
): MetricReading {
  const range = factor === '反应塔温度' ? TOWER_TEMP_RANGE : CARBON_RANGE
  const unit = factor === '反应塔温度' ? '℃' : 'kg/h'
  const value = toMetricNumber(rawValue)
  if (value === null) {
    return {
      factor,
      value: null,
      level: '数据缺失',
      range,
      unit,
      message: `${factor}未采集到有效数值`,
    }
  }
  if (value > range.max) {
    return {
      factor,
      value,
      level: '偏高',
      range,
      unit,
      message: `${factor} ${value}${unit}，高于高限 ${range.max}${unit}`,
    }
  }
  if (value < range.min) {
    return {
      factor,
      value,
      level: '偏低',
      range,
      unit,
      message: `${factor} ${value}${unit}，低于低限 ${range.min}${unit}`,
    }
  }
  return {
    factor,
    value,
    level: '正常',
    range,
    unit,
    message: `${factor} ${value}${unit}，在 ${range.min}~${range.max}${unit} 区间内`,
  }
}

// 唯一一份判定实现：反应塔温度、活性炭喷射量都从同一条净化记录上取数。
export function evaluateFluegas(row: AnyRow): AlarmVerdict {
  const metrics = [
    checkMetric('反应塔温度', row[TOWER_TEMP_FIELD]),
    checkMetric('活性炭喷射量', row[CARBON_FIELD]),
  ]
  const overLimit = metrics.filter((item) => item.level === '偏高' || item.level === '偏低')
  if (overLimit.length > 0) {
    const first = overLimit[0]
    return {
      level: first.level,
      abnormal: true,
      metrics,
      reasons: overLimit.map((item) => item.message),
    }
  }
  const missing = metrics.filter((item) => item.level === '数据缺失')
  if (missing.length > 0) {
    // 缺数据只提示补录，不属于"偏高/偏低"告警，不挂待办、不进待核对台账。
    return {
      level: '数据缺失',
      abnormal: false,
      metrics,
      reasons: missing.map((item) => item.message),
    }
  }
  return {
    level: '正常',
    abnormal: false,
    metrics,
    reasons: metrics.map((item) => item.message),
  }
}

export function lineNoOf(row: AnyRow): string {
  return String(row[LINE_NO_FIELD] ?? '').trim()
}

export function isStopped(row: AnyRow): boolean {
  return String(row.status) === FLUEGAS_STATUS.stopped
}

// 停运记录取留档快照；其余在运记录都走同一份实时判定。
// 待投运的记录没有工艺参数，不参与告警（返回 null，由调用方按"未投运"展示）。
export function verdictForRow(row: AnyRow): AlarmVerdict | null {
  if (String(row.status) === FLUEGAS_STATUS.waiting) {
    return null
  }
  if (isStopped(row)) {
    const label = String(row[ARCHIVED_LABEL_FIELD] ?? '').trim()
    if (label === '') {
      // 历史停运记录若没留下快照，按正常留档，绝不用新阈值重判。
      return { level: '正常', abnormal: false, metrics: [], reasons: ['停运记录无留档，按存档展示'] }
    }
    return {
      level: label as MetricLevel,
      abnormal: label !== '正常',
      metrics: [],
      reasons: String(row[ARCHIVED_DETAIL_FIELD] ?? label)
        .split('；')
        .map((item) => item.trim())
        .filter(Boolean),
    }
  }
  return evaluateFluegas(row)
}

export function archivedFactors(row: AnyRow): AlarmFactor[] {
  const detail = String(row[ARCHIVED_DETAIL_FIELD] ?? '')
  const factors: AlarmFactor[] = []
  if (detail.includes('反应塔温度')) {
    factors.push('反应塔温度')
  }
  if (detail.includes('活性炭喷射量')) {
    factors.push('活性炭喷射量')
  }
  return factors
}

// 出口烟气温度折算：只展示，不判高低，告警仍然只认反应塔温度这一份来源。
export function deriveOutletTemp(row: AnyRow): number | null {
  const tower = toMetricNumber(row[TOWER_TEMP_FIELD])
  return tower === null ? null : tower - OUTLET_TEMP_DROP
}

export type DupSplit = {
  // 同编号只保留先登记（id 最小）的一条作为正本。
  canonical: FluegasRow[]
  duplicates: { row: FluegasRow; keptId: number }[]
}

// 同一台净化线重复登记：只认一条正本，其余记审计、不再参与判定与台账。
export function splitDuplicates(rows: FluegasRow[]): DupSplit {
  const firstById = new Map<string, number>()
  for (const row of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
    const key = lineNoOf(row)
    if (key !== '' && !firstById.has(key)) {
      firstById.set(key, Number(row.id))
    }
  }
  const canonical: FluegasRow[] = []
  const duplicates: { row: FluegasRow; keptId: number }[] = []
  for (const row of rows) {
    const key = lineNoOf(row)
    const keptId = key === '' ? Number(row.id) : (firstById.get(key) ?? Number(row.id))
    if (keptId === Number(row.id)) {
      canonical.push(row)
    } else {
      duplicates.push({ row, keptId })
    }
  }
  return { canonical, duplicates }
}
