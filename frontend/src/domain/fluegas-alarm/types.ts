/**
 * 烟气净化告警共用域的类型定义。
 *
 * 反应塔温度与活性炭喷射量的高低判定只有这一套口径，列表、净化详情、
 * 值班待办三个入口都消费这里的判定结果，不允许再各自比一遍。
 */

/** 告警高低：除高/低/正常外，缺测（现场未填或填了非数字）单独成一档。 */
export type AlarmLevel = '高' | '低' | '正常' | '缺失'

/** 纳入告警判定的指标：键名与烟气净化记录字段一致，只认 fluegas 这一份取数来源。 */
export type FluegasMetricKey = '反应塔温度' | '活性炭喷射量'

export interface MetricLimit {
  min: number
  max: number
  unit: string
}

/**
 * 告警阈值参数（全厂同一份）。
 * version 是乐观锁版本：两台净化线同时改参数时，先落库的版本号 +1，
 * 后提交的一方 baseVersion 对不上就被拒绝，以先落库的一版为准。
 */
export interface AlarmParams {
  version: number
  updatedAt: string
  updatedBy: string
  limits: Record<FluegasMetricKey, MetricLimit>
}

/** 单个指标在一条净化记录上的判定结果。 */
export interface MetricAlarm {
  metric: FluegasMetricKey
  unit: string
  value: number | null
  level: AlarmLevel
}

/** 一条净化记录的完整告警视图，三个入口看到的都是它。 */
export interface FluegasAlarmRow {
  id: number
  /** 净化编号：同一台净化线全系统只认这一份编号。 */
  lineCode: string
  status: string
  recordedAt: string
  metrics: MetricAlarm[]
  /** 综合高低：任一指标为高即高，否则任一为低即低，否则任一缺测即缺测。 */
  overall: AlarmLevel
  /** true=已停运留档，高低取自停运当时快照，后续不再重判。 */
  frozen: boolean
  judgedAt: string
}

/** 在线排放监测侧的待核对台账状态。 */
export type CemsLedgerStatus = '待核对' | '已核对' | '已消除' | '停运留档'

/** 告警结果同步到在线排放监测的待核对台账条目，按 净化编号+指标 保持唯一。 */
export interface CemsLedgerEntry {
  id: number
  ledgerNo: string
  lineCode: string
  metric: FluegasMetricKey
  value: number | null
  unit: string
  level: AlarmLevel
  status: CemsLedgerStatus
  /** 最近一次判为该高低的时间。 */
  judgedAt: string
  checkedAt: string | null
  checker: string
}

export interface RegisterFluegasInput {
  lineCode: string
  towerTemp: string
  carbonInjection: string
  slurryFlow: string
  outletTemp: string
  operator: string
  recordedAt: string
}

export interface UpdateParamsInput {
  /** 页面打开/最近一次读取时看到的参数版本，提交时据此做乐观锁校验。 */
  baseVersion: number
  operator: string
  limits: Record<FluegasMetricKey, { min: number; max: number }>
}
