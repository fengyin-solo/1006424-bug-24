/**
 * 烟气净化告警共用实现（唯一口径）。
 *
 * 取数来源只有 fluegas 一份净化记录：反应塔温度、活性炭喷射量都从这里读，
 * 出口烟气温度不参与告警判定。列表（fluegas 页）、净化详情、值班待办
 * （shift 页）三个入口都调 {@link getFluegasAlarmViews} 这条链上的判定，
 * 保证同一台净化线算出来的高低一致。
 *
 * 停运留档：停运瞬间把当时的高低快照写进记录，之后只认快照、不再重判
 * （改阈值也不重判）。判定结果通过 {@link reconcileAll} 自动对账到在线
 * 排放监测（cems）的待核对台账：每台净化线的每个指标只占一条台账，
 * 反复异常在同一条上流转，不会重复挂两条。
 */
import { listRows, saveRows, subscribeRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

import { loadLedger, loadParams, saveLedger, saveParams } from './alarm-store'
import type {
  AlarmLevel,
  AlarmParams,
  CemsLedgerEntry,
  FluegasAlarmRow,
  FluegasMetricKey,
  MetricAlarm,
  RegisterFluegasInput,
  UpdateParamsInput,
} from './types'

const MODULE_KEY = 'fluegas'
const STOPPED_STATUS = '已停运'
/** 停运快照在净化记录里的存放字段（JSON 字符串，不参与列表筛选与导出）。 */
export const ALARM_SNAPSHOT_FIELD = '告警判定快照'

/** 只有这两个指标参与告警判定，且只认 fluegas 这一份取数来源。 */
const METRIC_KEYS: FluegasMetricKey[] = ['反应塔温度', '活性炭喷射量']

interface AlarmSnapshot {
  overall: AlarmLevel
  judgedAt: string
  metrics: Array<{ metric: FluegasMetricKey; value: number | null; level: AlarmLevel; unit: string }>
}

function nowIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** 现场填的可能是空、带单位的字符串或非数字；统一从这里过，缺测单独成档。 */
function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null
  }
  const n = Number(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

function lineCodeOf(row: EntryRow): string {
  return String(row['净化编号'] ?? '')
}

/** 共用的单指标高低判定：高 / 低 / 正常 / 缺失，三个入口都从这里出结果。 */
function judgeMetric(metric: FluegasMetricKey, raw: unknown, params: AlarmParams): MetricAlarm {
  const limit = params.limits[metric]
  const value = toNumber(raw)
  let level: AlarmLevel
  if (value === null) {
    level = '缺失'
  } else if (value > limit.max) {
    level = '高'
  } else if (value < limit.min) {
    level = '低'
  } else {
    level = '正常'
  }
  return { metric, unit: limit.unit, value, level }
}

const LEVEL_PRIORITY: Record<AlarmLevel, number> = { 高: 3, 低: 2, 缺失: 1, 正常: 0 }

function overallOf(metrics: MetricAlarm[]): AlarmLevel {
  return metrics.reduce<AlarmLevel>((acc, item) => {
    return LEVEL_PRIORITY[item.level] > LEVEL_PRIORITY[acc] ? item.level : acc
  }, '正常')
}

/** 用记录当前的数据与阈值，拍一份高低快照（停运时调用，拍多少是多少）。 */
function buildSnapshot(row: EntryRow, params: AlarmParams, judgedAt: string): AlarmSnapshot {
  const metrics = METRIC_KEYS.map((key) => judgeMetric(key, row[key], params))
  return { overall: overallOf(metrics), judgedAt, metrics }
}

/** 供 local-service 的「登记停运」动作调用：停运前先把当时高低快照拍下来。 */
export function buildShutdownSnapshot(row: EntryRow): string {
  const judgedAt = String(row['记录时间'] ?? '') || nowIso()
  return JSON.stringify(buildSnapshot(row, loadParams(), judgedAt))
}

function readSnapshot(row: EntryRow): AlarmSnapshot | null {
  const raw = row[ALARM_SNAPSHOT_FIELD]
  if (typeof raw !== 'string' || raw === '') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as AlarmSnapshot
    if (!parsed || !Array.isArray(parsed.metrics)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * 唯一的净化记录告警视图构造。
 * - 已停运且有快照：高低、数值全部取自快照，frozen=true，永不重判；
 * - 其余（待投运/运行中/指标异常，或无快照的历史停运兜底）：实时判定。
 */
function judgeRow(row: EntryRow, params: AlarmParams): FluegasAlarmRow {
  const status = String(row.status)
  const recordedAt = String(row['记录时间'] ?? '')
  const base = {
    id: Number(row.id),
    lineCode: lineCodeOf(row),
    status,
    recordedAt,
  }
  const snapshot = status === STOPPED_STATUS ? readSnapshot(row) : null
  if (snapshot) {
    return {
      ...base,
      metrics: snapshot.metrics.map((m) => ({ ...m })),
      overall: snapshot.overall,
      frozen: true,
      judgedAt: snapshot.judgedAt || recordedAt,
    }
  }
  const metrics = METRIC_KEYS.map((key) => judgeMetric(key, row[key], params))
  return { ...base, metrics, overall: overallOf(metrics), frozen: false, judgedAt: recordedAt }
}

function ledgerKey(lineCode: string, metric: FluegasMetricKey): string {
  return `${lineCode}｜${metric}`
}

function nextLedgerNo(entries: CemsLedgerEntry[]): { id: number; no: string } {
  const id = entries.reduce((max, item) => Math.max(max, item.id), 0) + 1
  return { id, no: `YJ-${String(id).padStart(4, '0')}` }
}

type LedgerUpsertMode = 'live' | 'shutdown'

/**
 * 台账状态机（同一台净化线的同一个指标全生命周期只有一条）：
 * live      ：待核对/已消除/停运留档 → 待核对（反复异常在同一条上重开）；已核对不动（留痕）。
 * shutdown  ：待核对 → 停运留档；无则新建；已核对/已消除不动。
 * 数值、级别、判定时间仅在级别或值变化时才更新，避免每次对账都翻动台账。
 */
function upsertLedger(
  entries: CemsLedgerEntry[],
  view: FluegasAlarmRow,
  metric: MetricAlarm,
  mode: LedgerUpsertMode,
): void {
  const key = ledgerKey(view.lineCode, metric.metric)
  const index = entries.findIndex(
    (item) => ledgerKey(item.lineCode, item.metric) === key,
  )
  const sameFinding = (item: CemsLedgerEntry) =>
    item.level === metric.level && item.value === metric.value

  if (index < 0) {
    if (mode === 'shutdown') {
      const { id, no } = nextLedgerNo(entries)
      entries.push({
        id,
        ledgerNo: no,
        lineCode: view.lineCode,
        metric: metric.metric,
        value: metric.value,
        unit: metric.unit,
        level: metric.level,
        status: '停运留档',
        judgedAt: view.judgedAt,
        checkedAt: null,
        checker: '',
      })
    } else {
      const { id, no } = nextLedgerNo(entries)
      entries.push({
        id,
        ledgerNo: no,
        lineCode: view.lineCode,
        metric: metric.metric,
        value: metric.value,
        unit: metric.unit,
        level: metric.level,
        status: '待核对',
        judgedAt: view.judgedAt,
        checkedAt: null,
        checker: '',
      })
    }
    return
  }

  const current = entries[index]
  if (mode === 'shutdown') {
    if (current.status === '已核对' || current.status === '已消除') {
      return
    }
    entries[index] = {
      ...current,
      status: '停运留档',
      value: metric.value,
      unit: metric.unit,
      level: metric.level,
      judgedAt: sameFinding(current) ? current.judgedAt : view.judgedAt,
    }
    return
  }

  if (current.status === '已核对') {
    return
  }
  if (current.status === '待核对' && sameFinding(current)) {
    return
  }
  entries[index] = {
    ...current,
    status: '待核对',
    value: metric.value,
    unit: metric.unit,
    level: metric.level,
    judgedAt: sameFinding(current) ? current.judgedAt : view.judgedAt,
    checkedAt: null,
    checker: '',
  }
}

let reconcileRunning = false

/**
 * 以 fluegas 记录为准做一次全量对账，结果同步到 cems 待核对台账：
 * 1) 历史已停运但缺快照的记录：按记录里当时的数据补拍快照（仅迁移兜底）；
 * 2) 停运线只认快照，异常指标挂/转「停运留档」，不做重判；
 * 3) 在运线实时判定，异常进「待核对」，恢复正常或线被删除则关闭为「已消除」。
 */
export function reconcileAll(): void {
  if (reconcileRunning) {
    return
  }
  reconcileRunning = true
  try {
    const params = loadParams()
    const rows = listRows(MODULE_KEY).map((row) => ({ ...row }))

    // 兜底：已停运记录没有快照（旧数据）时，按其当时数据补拍，之后同样冻结。
    let rowsChanged = false
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i].status) === STOPPED_STATUS && !readSnapshot(rows[i])) {
        const judgedAt = String(rows[i]['记录时间'] ?? '') || nowIso()
        const snapshot = buildSnapshot(rows[i], params, judgedAt)
        rows[i] = { ...rows[i], [ALARM_SNAPSHOT_FIELD]: JSON.stringify(snapshot) }
        rowsChanged = true
      }
    }
    if (rowsChanged) {
      saveRows(MODULE_KEY, rows, true)
    }

    const views = rows.map((row) => judgeRow(row, params))
    const entries = [...loadLedger()]
    const activeKeys = new Set<string>()

    for (const view of views) {
      const abnormal = view.metrics.filter((m) => m.level === '高' || m.level === '低')
      for (const metric of abnormal) {
        activeKeys.add(ledgerKey(view.lineCode, metric.metric))
        upsertLedger(entries, view, metric, view.frozen ? 'shutdown' : 'live')
      }
    }

    // 全量对齐：已不在异常集合（恢复正常 / 停运时已正常 / 线被删除）的未结台账关闭。
    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i]
      if (
        !activeKeys.has(ledgerKey(item.lineCode, item.metric)) &&
        (item.status === '待核对' || item.status === '停运留档')
      ) {
        entries[i] = { ...item, status: '已消除' }
      }
    }

    saveLedger(entries)
  } finally {
    reconcileRunning = false
  }
}

// fluegas 记录一有落库（登记/状态流转/重置）就自动重新对账，同步待核对台账。
subscribeRows((key) => {
  if (key === MODULE_KEY) {
    reconcileAll()
  }
})
// 模块首次加载也对一遍，保证刷新后三个入口看到的高低与台账一致。
reconcileAll()

/** 烟气净化列表入口：每台净化线的告警视图（与详情、值班待办同一判定链）。 */
export function getFluegasAlarmViews(): FluegasAlarmRow[] {
  reconcileAll()
  const params = loadParams()
  return listRows(MODULE_KEY).map((row) => judgeRow(row, params))
}

/** 值班待办入口：只列在运且高低异常的净化线，已停运的按留档处理、不再派活。 */
export function getShiftAlarmTodos(): FluegasAlarmRow[] {
  return getFluegasAlarmViews()
    .filter((view) => !view.frozen && (view.overall === '高' || view.overall === '低'))
    .sort(
      (a, b) =>
        LEVEL_PRIORITY[b.overall] - LEVEL_PRIORITY[a.overall] ||
        b.judgedAt.localeCompare(a.judgedAt),
    )
}

/** 在线排放监测入口：告警结果同步过来的待核对台账（每线每指标一条）。 */
export function getCemsAlarmLedger(): CemsLedgerEntry[] {
  reconcileAll()
  const statusWeight: Record<CemsLedgerEntry['status'], number> = {
    待核对: 0,
    停运留档: 1,
    已核对: 2,
    已消除: 3,
  }
  return [...loadLedger()].sort(
    (a, b) =>
      statusWeight[a.status] - statusWeight[b.status] || b.judgedAt.localeCompare(a.judgedAt),
  )
}

/** 台账核对：只有待核对的条目可以核对，核对后留痕，不会再被同一异常改写。 */
export function checkCemsAlarmEntry(id: number, checker: string): ActionResult {
  const entries = [...loadLedger()]
  const index = entries.findIndex((item) => item.id === id)
  if (index < 0) {
    return { ok: false, message: '没有找到对应的待核对台账条目' }
  }
  if (entries[index].status !== '待核对') {
    return { ok: false, message: `台账当前为「${entries[index].status}」，无需核对` }
  }
  entries[index] = {
    ...entries[index],
    status: '已核对',
    checkedAt: nowIso(),
    checker: checker.trim() || '值班管理员',
  }
  saveLedger(entries)
  return { ok: true, message: `台账 ${entries[index].ledgerNo} 已核对` }
}

export function getFluegasAlarmParams(): AlarmParams {
  return loadParams()
}

/**
 * 两台净化线同时改同一份阈值参数时的仲裁：带版本号的乐观锁，
 * baseVersion 与库中不一致说明已有人先改过，本次提交被拒，以先落库的一版为准。
 */
export function updateFluegasAlarmParams(input: UpdateParamsInput): ActionResult {
  const current = loadParams()
  if (input.baseVersion !== current.version) {
    return {
      ok: false,
      message:
        `告警参数刚被「${current.updatedBy}」先落库为 v${current.version}，` +
        `您基于 v${input.baseVersion} 的修改已作废，请按新版本重新填写`,
    }
  }
  for (const key of METRIC_KEYS) {
    const range = input.limits[key]
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      return { ok: false, message: `「${key}」的上下限必须都是数字` }
    }
    if (range.min >= range.max) {
      return { ok: false, message: `「${key}」的下限必须小于上限` }
    }
  }
  const next: AlarmParams = {
    version: current.version + 1,
    updatedAt: nowIso(),
    updatedBy: input.operator.trim() || '值班管理员',
    limits: {
      反应塔温度: { ...input.limits['反应塔温度'], unit: current.limits['反应塔温度'].unit },
      活性炭喷射量: { ...input.limits['活性炭喷射量'], unit: current.limits['活性炭喷射量'].unit },
    },
  }
  saveParams(next)
  // 参数落库后立即重判：只影响在运线；停运线有快照冻结，不会被新阈值重判。
  reconcileAll()
  return { ok: true, message: `告警参数已更新为 v${next.version}` }
}

/**
 * 同一台净化线重复登记只记一次：净化编号是唯一取数键，已存在就拒绝。
 */
export function registerFluegasRecord(input: RegisterFluegasInput): ActionResult {
  const lineCode = input.lineCode.trim()
  if (!lineCode) {
    return { ok: false, message: '净化编号不能为空' }
  }
  const rows = listRows(MODULE_KEY)
  if (rows.some((row) => lineCodeOf(row) === lineCode)) {
    return { ok: false, message: `净化编号 ${lineCode} 已登记过，同一台净化线只记一次` }
  }
  const towerTemp = toNumber(input.towerTemp)
  const carbon = toNumber(input.carbonInjection)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const row: EntryRow = {
    id,
    status: '待投运',
    pending: true,
    abnormal: false,
    净化编号: lineCode,
    // 允许空/非数字：缺测单独判「缺失」档，不按正常或异常处理。
    反应塔温度: towerTemp === null ? '' : towerTemp,
    活性炭喷射量: carbon === null ? '' : carbon,
    石灰浆流量: input.slurryFlow.trim(),
    出口烟气温度: input.outletTemp.trim(),
    操作人员: input.operator.trim() || '值班管理员',
    记录时间: input.recordedAt.trim() || nowIso(),
    净化状态: '待投运',
  }
  // saveRows 会触发订阅，reconcileAll 同步把判定结果对到待核对台账。
  saveRows(MODULE_KEY, [...rows, row])
  return { ok: true, message: `净化线 ${lineCode} 已登记（编号 #${id}）` }
}
