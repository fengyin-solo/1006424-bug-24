<template>
  <section class="page" data-module="cems">
    <header class="page-head">
      <div>
        <h2>在线排放监测管理</h2>
        <p class="page-desc">维护排放监测记录，围绕监测编号、监测因子、实测值、排放限值做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记排放监测记录</button>
        <button class="btn" type="button" @click="exportRows">导出在线排放监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="todo-panel">
      <h3>待核对台账 · 烟气净化告警同步</h3>
      <p class="page-desc">告警判定结果由烟气净化共用实现统一推送：同一台净化线同一因子一轮异常只挂一条；恢复正常自动置「已消除」，停运置「停运留档」，均不再重判。</p>
      <div class="stat-row">
        <article v-for="item in ledgerStatCards" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>净化编号</th><th>告警因子</th><th>告警高低</th><th>实测值</th>
            <th>发生时间</th><th>台账状态</th><th>判定依据 / 核对备注</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ledgerRows" :key="String(item.id)">
            <td>{{ item.净化编号 }}</td>
            <td>{{ item.告警因子 }}</td>
            <td>
              <span class="alarm-badge" :class="item.告警高低 === '偏高' ? 'badge-high' : 'badge-low'">
                {{ item.告警高低 }}
              </span>
            </td>
            <td>{{ item.实测值 === null ? '留档无值' : `${item.实测值} ${item.单位}` }}</td>
            <td>{{ item.发生时间 }}</td>
            <td>
              <span class="ledger-status" :class="`ledger-${item.台账状态}`">{{ item.台账状态 }}</span>
            </td>
            <td>{{ item.核对备注 }}<template v-if="item.核对人员">（核对人：{{ item.核对人员 }}）</template></td>
            <td>
              <button v-if="item.台账状态 === '待核对'" class="link" type="button" @click="openAck(item)">
                核对
              </button>
              <span v-else class="page-desc">—</span>
            </td>
          </tr>
          <tr v-if="!ledgerRows.length">
            <td colspan="8" class="empty-state">台账暂无同步记录，烟气净化出现告警后会自动挂到这里</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无在线排放监测数据，可先登记排放监测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条在线排放监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="ackTarget" class="modal-mask" @click.self="closeAck">
      <div class="modal-card">
        <header class="modal-head">
          <h3>核对告警 · {{ ackTarget.净化编号 }} / {{ ackTarget.告警因子 }}（{{ ackTarget.告警高低 }}）</h3>
          <button class="btn ghost" type="button" @click="closeAck">关闭</button>
        </header>
        <form class="filter-bar" @submit.prevent="submitAck">
          <label class="filter-item">
            <span>核对人员</span>
            <input v-model="ackForm.operator" placeholder="请填写核对人员" />
          </label>
          <label class="filter-item filter-grow">
            <span>核对备注</span>
            <input v-model="ackForm.note" placeholder="可填写核对结论，留空则沿用判定依据" />
          </label>
          <button class="btn primary" type="submit">确认核对</button>
          <span v-if="ackError" class="error-text">{{ ackError }}</span>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { fluegasAlarmApi } from '@/api/fluegas-alarm-service'
import type { AlarmLedgerRow } from '@/domain/fluegas-alarm'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cems')
const columns = ["监测编号", "监测因子", "实测值", "排放限值", "折算值", "采集时间", "审核人员", "监测状态"]
const actions = ["提交采集", "确认审核", "标记超标"]
const statuses = ["待采集", "已采集", "已审核", "超标预警"]
const stats = ref([{"label": "待采集因子", "value": 0}, {"label": "已审核因子", "value": 0}, {"label": "超标预警次数", "value": 0}])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const ledgerRows = ref<AlarmLedgerRow[]>([])
const ledgerStatCards = ref<{ label: string; value: number }[]>([])
const ackTarget = ref<AlarmLedgerRow | null>(null)
const ackForm = ref({ operator: '', note: '' })
const ackError = ref('')
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '排放监测记录登记入口尚未接入审批流'
}

function openAck(row: AlarmLedgerRow) {
  ackTarget.value = row
  ackForm.value = { operator: '', note: '' }
  ackError.value = ''
}

function closeAck() {
  ackTarget.value = null
}

function submitAck() {
  if (!ackTarget.value) {
    return
  }
  ackError.value = ''
  const result = fluegasAlarmApi.acknowledgeLedger(
    Number(ackTarget.value.id),
    ackForm.value.operator,
    ackForm.value.note,
  )
  if (!result.ok) {
    ackError.value = result.message
    return
  }
  ackTarget.value = null
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledgerRows.value = fluegasAlarmApi.listLedger()
    ledgerStatCards.value = fluegasAlarmApi.ledgerStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '在线排放监测列表读取失败'
  }
}

onMounted(reload)
</script>
