import {
  ARCHIVED_AT_FIELD,
  ARCHIVED_DETAIL_FIELD,
  ARCHIVED_LABEL_FIELD,
  ARCHIVED_VERSION_FIELD,
  CARBON_FIELD,
  CEMS_LEDGER_KEY,
  deriveOutletTemp,
  FLUEGAS_DUP_AUDIT_KEY,
  FLUEGAS_KEY,
  FLUEGAS_STATUS,
  lineNoOf,
  splitDuplicates,
  TOWER_TEMP_FIELD,
  verdictForRow,
  type AlarmLedgerRow,
  type AlarmVerdict,
  type FluegasRow,
} from '@/domain/fluegas-alarm'
import { reconcileLedger } from '@/domain/alarm-ledger'
import {
  listRows,
  loadCollection,
  saveCollection,
  saveRows,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const VERSION_FIELD = ARCHIVED_VERSION_FIELD

export type FluegasViewRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: unknown
  verdict: AlarmVerdict | null
  outletTemp: number | null
}

export type ShiftTodo = {
  recordId: number
  lineNo: string
  level: string
  reasons: string[]
  recordTime: string
}

export type ServiceResult<T> = (T & { ok: true }) | { ok: false; message: string; serverVersion?: number }

export type FluegasAlarmApi = {
  listFluegas: (filters?: Record<string, string>) => { items: FluegasViewRow[]; total: number }
  getFluegasDetail: (id: number) => FluegasViewRow | null
  updateParams: (
    id: number,
    patch: { towerTemp?: number | null; carbon?: number | null; expectedVersion: number },
  ) => ServiceResult<{ version: number }>
  runFluegasAction: (id: number, action: string) => ActionResult
  shiftTodos: () => ShiftTodo[]
  fluegasStats: () => { label: string; value: number }[]
  listLedger: () => AlarmLedgerRow[]
  acknowledgeLedger: (id: number, operator: string, note: string) => ActionResult
  ledgerStats: () => { label: string; value: number }[]
  listDupAudit: () => EntryRow[]
}

type StoreDeps = {
  getRows: () => FluegasRow[]
  setRows: (rows: FluegasRow[]) => void
  getLedger: () => AlarmLedgerRow[]
  setLedger: (rows: AlarmLedgerRow[]) => void
  getDupAudit: () => EntryRow[]
  setDupAudit: (rows: EntryRow[]) => void
  now: () => string
}

function timestampNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toViewRow(row: FluegasRow): FluegasViewRow {
  return { ...row, verdict: verdictForRow(row), outletTemp: deriveOutletTemp(row) }
}

// 两台净化线同时改同一份参数时的乐观锁冲突文案，调用方直接展示。
export function createFluegasAlarmApi(deps: StoreDeps): FluegasAlarmApi {
  let initialized = false

  function alignFlags(rows: FluegasRow[]): FluegasRow[] {
    return rows.map((row) => {
      if (String(row.status) === FLUEGAS_STATUS.stopped) {
        // 停运记录的异常标记以留档为准，不随实时判定翻动。
        const archivedLabel = String(row[ARCHIVED_LABEL_FIELD] ?? '')
        return { ...row, pending: false, abnormal: archivedLabel !== '' && archivedLabel !== '正常' }
      }
      const verdict = verdictForRow(row)
      const manualAbnormal = String(row.status) === FLUEGAS_STATUS.abnormalFlow
      return { ...row, abnormal: manualAbnormal || (verdict?.abnormal ?? false) }
    })
  }

  function persist(rows: FluegasRow[]) {
    const aligned = alignFlags(rows)
    deps.setRows(aligned)
    const ledger = reconcileLedger(deps.getLedger(), aligned, { now: deps.now() })
    deps.setLedger(ledger)
    return aligned
  }

  // 初始化只做一次：重复登记去重留痕，再按正本对账台账。
  function ensureReady(): FluegasRow[] {
    let rows = deps.getRows()
    if (!initialized) {
      const { canonical, duplicates } = splitDuplicates(rows)
      if (duplicates.length > 0) {
        const audit = deps.getDupAudit()
        const known = new Set(audit.map((item) => Number(item.原始记录)))
        const added = duplicates
          .filter((item) => !known.has(Number(item.row.id)))
          .map((item, index) => ({
            id: audit.length + index + 1,
            status: '已丢弃',
            pending: false,
            abnormal: true,
            原始记录: Number(item.row.id),
            净化编号: lineNoOf(item.row),
            保留正本: item.keptId,
            丢弃时间: deps.now(),
            原因: '同一台净化线重复登记，保留先落库的正本',
          }))
        if (added.length > 0) {
          deps.setDupAudit([...audit, ...added])
        }
        rows = canonical
      }
      rows = persist(rows)
      initialized = true
      return rows
    }
    return rows
  }

  function canonicalRows(): FluegasRow[] {
    // 每次读取都过一次去重：初始化之后正常不会再命中，留着是兜住并发写入。
    return splitDuplicates(ensureReady()).canonical
  }

  function findRow(id: number): FluegasRow | undefined {
    return canonicalRows().find((row) => Number(row.id) === id)
  }

  function mutate(id: number, produce: (row: FluegasRow) => FluegasRow | string): ActionResult {
    const rows = canonicalRows()
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的烟气净化记录（可能是重复登记已被去重）` }
    }
    const produced = produce(rows[index])
    if (typeof produced === 'string') {
      return { ok: false, message: produced }
    }
    const next = [...rows]
    next[index] = produced
    persist(next)
    return { ok: true, message: 'ok' }
  }

  return {
    listFluegas(filters: Record<string, string> = {}) {
      const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
      const matched = canonicalRows()
        .filter((row) => pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())))
        .map(toViewRow)
      return { items: matched, total: matched.length }
    },

    getFluegasDetail(id) {
      const row = findRow(id)
      return row ? toViewRow(row) : null
    },

    updateParams(id, patch) {
      const rows = canonicalRows()
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        return { ok: false, message: `没有找到编号为 ${id} 的烟气净化记录` }
      }
      const current = rows[index]
      const currentVersion = Number(current[VERSION_FIELD] ?? 0)
      if (currentVersion !== patch.expectedVersion) {
        // 乐观锁：两台净化线（两个编辑会话）改同一份参数，先落库的版本号已经往前走。
        return {
          ok: false,
          message: `该净化线参数已被先落库的一版修改（当前版本 v${currentVersion}），请刷新后基于新版本再提交`,
          serverVersion: currentVersion,
        }
      }
      if (String(current.status) === FLUEGAS_STATUS.stopped) {
        return { ok: false, message: '净化线已停运，告警按停运时的高低留档，参数不再允许修改' }
      }
      if (String(current.status) === FLUEGAS_STATUS.waiting) {
        return { ok: false, message: '净化线尚未投运，请先提交投运再录入工艺参数' }
      }
      const next = [...rows]
      next[index] = {
        ...current,
        [TOWER_TEMP_FIELD]: patch.towerTemp ?? null,
        [CARBON_FIELD]: patch.carbon ?? null,
        [VERSION_FIELD]: currentVersion + 1,
      }
      persist(next)
      return { ok: true, version: currentVersion + 1 }
    },

    runFluegasAction(id, action) {
      const result = mutate(id, (row) => {
        const status = String(row.status)
        if (action === '提交投运') {
          if (status !== FLUEGAS_STATUS.waiting) {
            return `净化线当前为「${status}」，不能重复投运`
          }
          return { ...row, status: FLUEGAS_STATUS.running, pending: true }
        }
        if (action === '上报异常') {
          if (status === FLUEGAS_STATUS.stopped) {
            return '净化线已停运，异常按留档处理，不再重判'
          }
          if (status === FLUEGAS_STATUS.abnormalFlow) {
            return '该净化线已是「指标异常」状态'
          }
          return { ...row, status: FLUEGAS_STATUS.abnormalFlow, pending: true }
        }
        if (action === '登记停运') {
          if (status === FLUEGAS_STATUS.stopped) {
            return '净化线已经停运'
          }
          if (status === FLUEGAS_STATUS.waiting) {
            return '净化线尚未投运，不能登记停运'
          }
          // 停运这一刻把当时的高低固化成快照，之后只看快照，不做重判。
          const verdict = verdictForRow(row)
          return {
            ...row,
            status: FLUEGAS_STATUS.stopped,
            pending: false,
            [ARCHIVED_LABEL_FIELD]: verdict?.level ?? '正常',
            [ARCHIVED_DETAIL_FIELD]: (verdict?.reasons ?? []).join('；') || '停运时各项指标正常',
            [ARCHIVED_AT_FIELD]: deps.now(),
          }
        }
        return `烟气净化记录没有登记「${action}」这个动作`
      })
      if (!result.ok) {
        return result
      }
      const targetMessage: Record<string, string> = {
        提交投运: '净化线已投运',
        上报异常: '净化线已标记为指标异常',
        登记停运: '净化线已停运，告警高低已按当时结果留档',
      }
      return { ok: true, message: targetMessage[action] ?? '操作成功' }
    },

    shiftTodos() {
      // 值班待办不再跟着净化状态走，直接读同一份判定结果；
      // 待投运没有指标、已停运按留档处理，都不挂待办。
      return canonicalRows()
        .filter((row) => {
          const status = String(row.status)
          return status !== FLUEGAS_STATUS.waiting && status !== FLUEGAS_STATUS.stopped
        })
        .map(toViewRow)
        .filter((row) => row.verdict?.abnormal)
        .map((row) => ({
          recordId: Number(row.id),
          lineNo: lineNoOf(row),
          level: row.verdict?.level ?? '',
          reasons: row.verdict?.reasons ?? [],
          recordTime: String(row.记录时间 ?? ''),
        }))
    },

    fluegasStats() {
      const rows = canonicalRows().map(toViewRow)
      return [
        { label: '运行中净化线', value: rows.filter((row) => String(row.status) === FLUEGAS_STATUS.running).length },
        { label: '已停运净化线', value: rows.filter((row) => String(row.status) === FLUEGAS_STATUS.stopped).length },
        { label: '指标异常次数', value: rows.filter((row) => row.verdict?.abnormal).length },
      ]
    },

    listLedger() {
      ensureReady()
      return deps.getLedger()
    },

    acknowledgeLedger(id, operator, note) {
      const ledger = deps.getLedger()
      const index = ledger.findIndex((item) => Number(item.id) === id)
      if (index < 0) {
        return { ok: false, message: `没有找到编号为 ${id} 的待核对台账条目` }
      }
      if (ledger[index].台账状态 !== '待核对') {
        return { ok: false, message: `该条目当前为「${ledger[index].台账状态}」，无需核对` }
      }
      if (!operator.trim()) {
        return { ok: false, message: '请填写核对人员' }
      }
      const next = [...ledger]
      next[index] = {
        ...ledger[index],
        status: '已核对',
        pending: false,
        台账状态: '已核对',
        核对人员: operator.trim(),
        核对备注: note.trim() || String(ledger[index].核对备注 ?? ''),
      }
      deps.setLedger(next)
      return { ok: true, message: '台账条目已核对' }
    },

    ledgerStats() {
      const ledger = deps.getLedger()
      return [
        { label: '待核对', value: ledger.filter((item) => item.台账状态 === '待核对').length },
        { label: '已核对', value: ledger.filter((item) => item.台账状态 === '已核对').length },
        { label: '已消除', value: ledger.filter((item) => item.台账状态 === '已消除').length },
        { label: '停运留档', value: ledger.filter((item) => item.台账状态 === '停运留档').length },
      ]
    },

    listDupAudit() {
      ensureReady()
      return deps.getDupAudit()
    },
  }
}

export const fluegasAlarmApi: FluegasAlarmApi = createFluegasAlarmApi({
  getRows: () => listRows(FLUEGAS_KEY) as FluegasRow[],
  setRows: (rows) => saveRows(FLUEGAS_KEY, rows),
  getLedger: () => loadCollection<AlarmLedgerRow[]>(CEMS_LEDGER_KEY, []),
  setLedger: (rows) => saveCollection(CEMS_LEDGER_KEY, rows),
  getDupAudit: () => loadCollection<EntryRow[]>(FLUEGAS_DUP_AUDIT_KEY, []),
  setDupAudit: (rows) => saveCollection(FLUEGAS_DUP_AUDIT_KEY, rows),
  now: timestampNow,
})
