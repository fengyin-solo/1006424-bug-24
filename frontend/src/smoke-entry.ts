// 纯内存端到端场景：模拟三个入口、并发改参、停运留档、台账同步与去重。
import { createFluegasAlarmApi } from './api/fluegas-alarm-service'
import { SEED_ROWS } from './data/seed'
import type { EntryRow } from './data/types'
import {
  ARCHIVED_LABEL_FIELD,
  TOWER_TEMP_RANGE,
  verdictForRow,
  type AlarmLedgerRow,
  type FluegasRow,
} from './domain/fluegas-alarm'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function runSmoke(): { ok: boolean; report: string } {
  const checks: { name: string; pass: boolean; detail?: string }[] = []
  const assert = (name: string, pass: boolean, detail = '') => {
    checks.push({ name, pass: !!pass, detail })
  }

  const rows: FluegasRow[] = clone(SEED_ROWS.fluegas)
  let ledger: AlarmLedgerRow[] = []
  let dupAudit: EntryRow[] = []

  const api = createFluegasAlarmApi({
    getRows: () => rows,
    setRows: (next) => {
      rows.splice(0, rows.length, ...next)
    },
    getLedger: () => ledger,
    setLedger: (next) => {
      ledger = next
    },
    getDupAudit: () => dupAudit,
    setDupAudit: (next) => {
      dupAudit = next
    },
    now: () => '2026-10-07 10:00',
  })

  // 1. 重复登记：FLUE-0002 的 #8 只留先落库的 #2，且只记一次审计。
  const listed = api.listFluegas().items
  const flue0002 = listed.filter((row) => String(row['净化编号']) === 'FLUE-0002')
  assert('同一台净化线重复登记只保留一条正本', flue0002.length === 1 && Number(flue0002[0].id) === 2)
  api.listFluegas()
  api.listFluegas()
  const dupOf8 = dupAudit.filter((item) => Number(item.原始记录) === 8)
  assert('去重审计只记一次，不随刷新重复', dupOf8.length === 1 && Number(dupOf8[0].保留正本) === 2)

  // 2. 三个入口算出来的高低一致。
  const listLevel = new Map(listed.map((row) => [String(row['净化编号']), row.verdict?.level ?? null]))
  const detailLevel = new Map(
    listed.map((row) => [String(row['净化编号']), api.getFluegasDetail(Number(row.id))?.verdict?.level ?? null]),
  )
  const todoMap = new Map(api.shiftTodos().map((item) => [item.lineNo, item.level]))
  // 列表/详情的期望高低（含停运留档）；值班待办只覆盖在运异常。
  const expect = new Map([
    ['FLUE-0001', '正常'],
    ['FLUE-0002', '偏高'],
    ['FLUE-0003', '偏低'],
    ['FLUE-0004', '偏低'],
    ['FLUE-0006', '偏高'],
    ['FLUE-0007', '正常'],
  ])
  const runningAbnormal = new Set(['FLUE-0002', 'FLUE-0003', 'FLUE-0004'])
  let consistent = true
  for (const [line, level] of expect) {
    if (listLevel.get(line) !== level || detailLevel.get(line) !== level) {
      consistent = false
    }
    if (runningAbnormal.has(line) && todoMap.get(line) !== level) {
      consistent = false
    }
  }
  assert('列表、详情、值班待办三处高低一致', consistent)

  // 待投运不判，停运留档不挂待办。
  assert('待投运记录不参与告警', listLevel.get('FLUE-0005') === null)
  assert('停运留档记录不挂值班待办', !todoMap.has('FLUE-0006') && !todoMap.has('FLUE-0007'))

  // 3. 台账同步：在运 3 条待核对，停运 1 条留档，因子/高低正确。
  const ledgerAfterBoot = api.listLedger()
  const pending = ledgerAfterBoot.filter((item) => item.台账状态 === '待核对')
  const archived = ledgerAfterBoot.filter((item) => item.台账状态 === '停运留档')
  const pendingKey = pending.map((item) => `${item.净化编号}:${item.告警因子}:${item.告警高低}`).sort().join('|')
  assert(
    '在运告警挂待核对台账（3 条，因子与高低正确）',
    pending.length === 3 &&
      pendingKey === 'FLUE-0002:反应塔温度:偏高|FLUE-0003:活性炭喷射量:偏低|FLUE-0004:反应塔温度:偏低',
    pendingKey,
  )
  assert(
    '停运记录按当时高低留档，不重判',
    archived.length === 1 &&
      archived[0].净化编号 === 'FLUE-0006' &&
      archived[0].告警因子 === '反应塔温度' &&
      archived[0].告警高低 === '偏高',
  )

  // 反复对账不重复挂。
  const idsOnce = ledgerAfterBoot.map((item) => item.id).join(',')
  assert('重复读取不产生重复台账条目', api.listLedger().map((item) => item.id).join(',') === idsOnce)

  // 4. 参数修改：先落库版本生效，后提交的旧版本冲突。
  const updateOk = api.updateParams(2, { towerTemp: 155, carbon: 14, expectedVersion: 1 })
  assert('基于当前版本的修改落库成功，版本号 +1', updateOk.ok && updateOk.ok && (updateOk as { version: number }).version === 2)
  const stale = api.updateParams(2, { towerTemp: 190, carbon: 14, expectedVersion: 1 })
  assert('拿着旧版本再提交被拒，以先落库为准', !stale.ok && /当前版本 v2/.test(stale.message))

  // 恢复正常后原待核对自动消除，不删历史。
  const afterFix = api.listLedger()
  const line2Entries = afterFix.filter((item) => item.净化编号 === 'FLUE-0002')
  assert(
    '告警消除后待核对自动置「已消除」，条目仍留痕',
    line2Entries.length >= 1 && line2Entries.every((item) => item.台账状态 !== '待核对') &&
      line2Entries.some((item) => item.台账状态 === '已消除'),
  )

  // 三个入口立刻一致刷新为正常。
  assert('修改后三入口高低同步刷新', api.getFluegasDetail(2)?.verdict?.level === '正常'
    && api.listFluegas().items.find((r) => Number(r.id) === 2)?.verdict?.level === '正常'
    && !api.shiftTodos().some((t) => t.lineNo === 'FLUE-0002'))

  // 5. 停运留档：停运瞬间固化高低，之后不重判、不可改参。
  const stop = api.runFluegasAction(3, '登记停运')
  const stoppedRow = rows.find((row) => Number(row.id) === 3)
  assert(
    '停运时按当时结果留档（偏低）',
    stop.ok && String(stoppedRow?.[ARCHIVED_LABEL_FIELD]) === '偏低' && String(stoppedRow?.status) === '已停运',
    stop.message,
  )
  // 即使把记录上的数值改成正常值，留档仍按偏低，绝不重判。
  const rewritten = { ...stoppedRow, '反应塔温度': 155, '活性炭喷射量': 12 } as FluegasRow
  assert('停运后改数值不触发重判', verdictForRow(rewritten)?.level === '偏低')
  const editStopped = api.updateParams(3, { towerTemp: 155, carbon: 12, expectedVersion: 2 })
  assert('停运记录拒绝参数修改', !editStopped.ok)
  const line3Ledger = api.listLedger().filter((item) => item.净化编号 === 'FLUE-0003')
  assert(
    '停运后对应待核对条目转为停运留档',
    line3Ledger.length === 1 && line3Ledger[0].台账状态 === '停运留档' && line3Ledger[0].告警高低 === '偏低',
  )
  assert('值班待办移除已停运线', !api.shiftTodos().some((item) => item.lineNo === 'FLUE-0003'))

  // 6. 人工核对后锁定，后续对账不再翻动。
  const id4 = api.listLedger().find((item) => item.净化编号 === 'FLUE-0004' && item.台账状态 === '待核对')?.id
  const ack = api.acknowledgeLedger(Number(id4), '值班长刘洋', '现场核实为热电偶漂移')
  assert('台账核对成功', ack.ok)
  const acked = api.listLedger().find((item) => Number(item.id) === Number(id4))
  assert('已核对条目不被后续对账覆盖', acked?.台账状态 === '已核对' && acked.核对人员 === '值班长刘洋')

  // 7. 出口温度折算来自同一份反应塔温度。
  const d1 = api.getFluegasDetail(1)
  assert('出口烟气温度按反应塔温度统一折算', d1 !== null && d1.outletTemp === Number(d1['反应塔温度']) - 15)
  assert('折算不参与判定，区间仍以共用阈值为准', TOWER_TEMP_RANGE.min === 140 && TOWER_TEMP_RANGE.max === 170)

  const failed = checks.filter((item) => !item.pass)
  const report = checks
    .map((item) => `${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `（${item.detail}）` : ''}`)
    .join('\n')
  return { ok: failed.length === 0, report }
}

const invoked = runSmoke()
console.log(invoked.report)
if (!invoked.ok) {
  process.exitCode = 1
}
