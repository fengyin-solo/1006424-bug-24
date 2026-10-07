import {
  ARCHIVED_AT_FIELD,
  ARCHIVED_VERSION_FIELD,
  archivedFactors,
  FLUEGAS_STATUS,
  isStopped,
  lineNoOf,
  RECORD_TIME_FIELD,
  verdictForRow,
  type AlarmFactor,
  type AlarmLedgerRow,
  type FluegasRow,
} from './fluegas-alarm'

export type LedgerContext = {
  now: string
}

type ActiveAlarm = {
  row: FluegasRow
  factor: AlarmFactor
  level: '偏高' | '偏低'
  value: number | null
  unit: string
  reasons: string[]
  archived: boolean
}

function collectActiveAlarms(rows: FluegasRow[]): ActiveAlarm[] {
  const alarms: ActiveAlarm[] = []
  for (const row of rows) {
    if (String(row.status) === FLUEGAS_STATUS.waiting) {
      continue
    }
    if (isStopped(row)) {
      // 已停运：按留档明细把当时的高低带进台账留档，不做任何重判。
      const verdict = verdictForRow(row)
      if (!verdict?.abnormal) {
        continue
      }
      for (const factor of archivedFactors(row)) {
        alarms.push({
          row,
          factor,
          level: verdict.level === '偏高' || verdict.level === '偏低' ? verdict.level : '偏高',
          value: null,
          unit: factor === '反应塔温度' ? '℃' : 'kg/h',
          reasons: verdict.reasons,
          archived: true,
        })
      }
      continue
    }
    const verdict = verdictForRow(row)
    if (!verdict?.abnormal) {
      continue
    }
    for (const metric of verdict.metrics) {
      if (metric.level === '偏高' || metric.level === '偏低') {
        alarms.push({
          row,
          factor: metric.factor,
          level: metric.level,
          value: metric.value,
          unit: metric.unit,
          reasons: [metric.message],
          archived: false,
        })
      }
    }
  }
  return alarms
}

// 台账对账：净化线的告警判定只从这里推一遍，三个入口共用结果。
// - 同一条在运告警已挂过待核对：沿用首条就地刷新，不重复挂；
// - 在运告警消失：原待核对条目置「已消除」；
// - 净化线停运：原待核对条目按当时高低置「停运留档」；
// - 停运线首次进台账：补一条「停运留档」，同因子只补一次；
// - 已核对等终态条目永不重判、永不删除。
export function reconcileLedger(
  previous: AlarmLedgerRow[],
  rows: FluegasRow[],
  context: LedgerContext,
): AlarmLedgerRow[] {
  const alarms = collectActiveAlarms(rows)
  const next: AlarmLedgerRow[] = []
  const consumed = new Set<number>()

  const ownerByLine = new Map(rows.map((row) => [lineNoOf(row), row]))

  for (const ledger of previous) {
    if (ledger.台账状态 !== '待核对') {
      next.push(ledger)
      continue
    }
    const owner = ownerByLine.get(String(ledger.净化编号))

    if (owner && isStopped(owner)) {
      // 停运优先：还挂在待核对的条目随停运一并处置，按留档结果走，绝不重判。
      const verdict = verdictForRow(owner)
      if (!verdict?.abnormal) {
        next.push({ ...ledger, 台账状态: '已消除', status: '已消除', pending: false })
        continue
      }
      next.push({
        ...ledger,
        告警高低: verdict.level === '偏低' || verdict.level === '偏高' ? verdict.level : ledger.告警高低,
        台账状态: '停运留档',
        status: '停运留档',
        pending: false,
        来源记录: Number(owner.id),
        参数版本: Number(owner[ARCHIVED_VERSION_FIELD] ?? ledger.参数版本 ?? 0),
      })
      const idx = alarms.findIndex(
        (alarm) =>
          alarm.archived &&
          lineNoOf(alarm.row) === String(ledger.净化编号) &&
          alarm.factor === String(ledger.告警因子),
      )
      if (idx >= 0) {
        consumed.add(idx)
      }
      continue
    }

    const match = alarms.find(
      (alarm) =>
        !alarm.archived &&
        lineNoOf(alarm.row) === String(ledger.净化编号) &&
        String(alarm.factor) === String(ledger.告警因子),
    )
    if (match) {
      // 同一轮异常只挂一条：高低在待核对期间变化时就地刷新，绝不挂第二条。
      consumed.add(alarms.indexOf(match))
      next.push({
        ...ledger,
        告警高低: match.level,
        实测值: match.value,
        单位: match.unit,
        核对备注: match.reasons.join('；'),
        来源记录: Number(match.row.id),
        参数版本: Number(match.row[ARCHIVED_VERSION_FIELD] ?? ledger.参数版本 ?? 0),
      })
      continue
    }

    next.push({ ...ledger, 台账状态: '已消除', status: '已消除', pending: false })
  }

  let nextId = previous.reduce((max, item) => Math.max(max, Number(item.id)), 0)
  for (const alarm of alarms) {
    if (consumed.has(alarms.indexOf(alarm))) {
      continue
    }
    if (alarm.archived) {
      // 同一台净化线同一因子的停运留档只补一次（终态条目也视为已存在）。
      const exists = next.some(
        (item) =>
          item.净化编号 === lineNoOf(alarm.row) && String(item.告警因子) === alarm.factor,
      )
      if (exists) {
        continue
      }
    }
    nextId += 1
    next.push({
      id: nextId,
      status: alarm.archived ? '停运留档' : '待核对',
      pending: !alarm.archived,
      abnormal: true,
      净化编号: lineNoOf(alarm.row),
      告警因子: alarm.factor,
      告警高低: alarm.level,
      实测值: alarm.value,
      单位: alarm.unit,
      台账状态: alarm.archived ? '停运留档' : '待核对',
      来源记录: Number(alarm.row.id),
      参数版本: Number(alarm.row[ARCHIVED_VERSION_FIELD] ?? 0),
      发生时间: alarm.archived
        ? String(alarm.row[ARCHIVED_AT_FIELD] ?? alarm.row[RECORD_TIME_FIELD] ?? context.now)
        : String(alarm.row[RECORD_TIME_FIELD] ?? context.now),
      核对人员: '',
      核对备注: alarm.reasons.join('；'),
    })
  }

  return next.sort((a, b) => Number(a.id) - Number(b.id))
}
