<template>
  <section class="page" data-module="fluegas">
    <header class="page-head">
      <div>
        <h2>烟气净化运行管理</h2>
        <p class="page-desc">反应塔温度与活性炭喷射量的告警高低统一按厂级阈值参数判定，取数只认本页净化记录；已停运净化线按停运当时高低留档，不再重判。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">登记烟气净化记录</button>
        <button class="btn" type="button" @click="showParams = !showParams">告警阈值参数</button>
        <button class="btn" type="button" @click="exportRows">导出烟气净化运行清单</button>
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

    <!-- 登记：净化编号唯一，同一台净化线重复登记只记一次 -->
    <section v-if="showCreate" class="panel">
      <h3 class="panel-title">登记烟气净化记录</h3>
      <p class="section-sub">反应塔温度、活性炭喷射量为告警判定数据来源，填数字即参与高低判定，留空按「缺测」处理；出口烟气温度仅作展示，不参与高低判定。</p>
      <form @submit.prevent="submitCreate">
        <div class="form-grid">
          <label><span>净化编号 *</span><input v-model="form.lineCode" placeholder="如 FLUE-0010" /></label>
          <label><span>反应塔温度（℃）</span><input v-model="form.towerTemp" placeholder="140~170" /></label>
          <label><span>活性炭喷射量（kg/h）</span><input v-model="form.carbonInjection" placeholder="8~15" /></label>
          <label><span>石灰浆流量</span><input v-model="form.slurryFlow" /></label>
          <label><span>出口烟气温度（℃）</span><input v-model="form.outletTemp" /></label>
          <label><span>操作人员</span><input v-model="form.operator" /></label>
          <label><span>记录时间</span><input v-model="form.recordedAt" placeholder="留空取当前时间" /></label>
        </div>
        <div class="form-actions">
          <button class="btn primary" type="submit">提交登记</button>
          <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
        </div>
      </form>
    </section>

    <!-- 阈值参数：全厂一份，带版本乐观锁，两处同时改以先落库为准 -->
    <section v-if="showParams" class="panel">
      <div class="panel-head">
        <h3 class="panel-title">告警阈值参数（全厂同一份）</h3>
        <span class="panel-note">当前 v{{ paramsForm.version }} · {{ params.updatedAt || '默认' }} · {{ params.updatedBy }}</span>
      </div>
      <form @submit.prevent="submitParams">
        <div class="form-grid">
          <template v-for="metric in metricKeys" :key="metric">
            <label>
              <span>{{ metric }} 下限（{{ params.limits[metric].unit }}）</span>
              <input v-model.number="paramsForm.limits[metric].min" type="number" step="0.1" />
            </label>
            <label>
              <span>{{ metric }} 上限（{{ params.limits[metric].unit }}）</span>
              <input v-model.number="paramsForm.limits[metric].max" type="number" step="0.1" />
            </label>
          </template>
        </div>
        <p class="section-sub">参数只对在运净化线重判；已停运净化线按停运快照留档，不受影响。两人同时修改时，后提交者会被拒绝并需按新版本重填。</p>
        <div class="form-actions">
          <button class="btn primary" type="submit">保存参数</button>
          <button class="btn ghost" type="button" @click="resetParamsForm">恢复当前值</button>
        </div>
      </form>
    </section>

    <!-- 净化详情：告警高低与列表、值班待办同一份判定 -->
    <section v-if="detailView" class="panel">
      <div class="panel-head">
        <h3 class="panel-title">净化详情 · {{ detailView.lineCode }}</h3>
        <button class="link" type="button" @click="detailView = null">关闭</button>
      </div>
      <table class="data-table" style="margin-bottom: 10px;">
        <thead>
          <tr><th>告警指标</th><th>实测值</th><th>单位</th><th>正常区间</th><th>告警高低</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in detailView.metrics" :key="m.metric">
            <td>{{ m.metric }}</td>
            <td>{{ m.value === null ? '缺测' : m.value }}</td>
            <td>{{ m.unit }}</td>
            <td>{{ rangeText(m.metric) }}</td>
            <td><span :class="badgeClass(m.level, detailView.frozen)">{{ levelText(m.level, detailView.frozen) }}</span></td>
          </tr>
        </tbody>
      </table>
      <ul class="detail-list">
        <li><span class="k">综合高低</span><span><b>{{ detailView.overall }}</b></span></li>
        <li><span class="k">净化状态</span><span>{{ detailView.status }}</span></li>
        <li><span class="k">判定时间</span><span>{{ detailView.judgedAt }}</span></li>
        <li><span class="k">判定依据</span><span>{{ detailView.frozen ? '停运留档（快照，不重判）' : '实时判定（当前阈值 v' + params.version + '）' }}</span></li>
      </ul>
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
          <th>告警高低</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <button class="link" type="button" @click="openDetail(Number(row.id))">
              <span :class="badgeClass(alarmOf(row)?.overall, alarmOf(row)?.frozen)">
                {{ levelText(alarmOf(row)?.overall, alarmOf(row)?.frozen) }}
              </span>
            </button>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(Number(row.id))">净化详情</button>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无烟气净化运行数据，可先登记烟气净化记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条烟气净化运行记录；告警取数只认本页记录，结果同步至「在线排放监测」待核对台账</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  getFluegasAlarmParams,
  getFluegasAlarmViews,
  listEntries,
  moduleMeta,
  registerFluegasRecord,
  runAction as applyAction,
  updateFluegasAlarmParams,
} from '@/api/local-service'
import type { AlarmLevel, FluegasAlarmRow, FluegasMetricKey } from '@/domain/fluegas-alarm/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fluegas')
const columns = ["净化编号", "反应塔温度", "活性炭喷射量", "石灰浆流量", "出口烟气温度", "操作人员", "记录时间", "净化状态"]
const actions = ["提交投运", "登记停运", "上报异常"]
const statuses = ["待投运", "运行中", "已停运", "指标异常"]
const metricKeys: FluegasMetricKey[] = ['反应塔温度', '活性炭喷射量']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['净化编号', '反应塔温度', '活性炭喷射量']

const alarmViews = ref<FluegasAlarmRow[]>([])
const detailView = ref<FluegasAlarmRow | null>(null)
const showCreate = ref(false)
const showParams = ref(false)

const form = reactive({
  lineCode: '',
  towerTemp: '',
  carbonInjection: '',
  slurryFlow: '',
  outletTemp: '',
  operator: '',
  recordedAt: '',
})

const params = ref(getFluegasAlarmParams())
const paramsForm = reactive({
  version: params.value.version,
  limits: {
    反应塔温度: { min: params.value.limits['反应塔温度'].min, max: params.value.limits['反应塔温度'].max },
    活性炭喷射量: { min: params.value.limits['活性炭喷射量'].min, max: params.value.limits['活性炭喷射量'].max },
  },
})

function resetParamsForm() {
  paramsForm.version = params.value.version
  for (const key of metricKeys) {
    paramsForm.limits[key].min = params.value.limits[key].min
    paramsForm.limits[key].max = params.value.limits[key].max
  }
}

function alarmOf(row: EntryRow): FluegasAlarmRow | undefined {
  return alarmViews.value.find((view) => view.id === Number(row.id))
}

function badgeClass(level: AlarmLevel | undefined, frozen?: boolean): string {
  const base =
    level === '高' ? 'badge badge-high'
    : level === '低' ? 'badge badge-low'
    : level === '缺失' ? 'badge badge-na'
    : 'badge badge-ok'
  return frozen ? `${base} badge-frozen` : base
}

function levelText(level: AlarmLevel | undefined, frozen?: boolean): string {
  if (!level) {
    return '—'
  }
  return frozen && level === '正常' ? '正常·留档' : frozen ? `${level}·留档` : level
}

function rangeText(metric: FluegasMetricKey): string {
  const limit = params.value.limits[metric]
  return `${limit.min} ~ ${limit.max} ${limit.unit}`
}

const stats = computed(() => [
  { label: '运行中净化线', value: rows.value.filter((r) => String(r.status) === '运行中').length },
  { label: '已停运净化线（留档）', value: alarmViews.value.filter((v) => v.frozen).length },
  { label: '在运告警高', value: alarmViews.value.filter((v) => !v.frozen && v.overall === '高').length },
  { label: '在运告警低', value: alarmViews.value.filter((v) => !v.frozen && v.overall === '低').length },
])

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

function openDetail(id: number) {
  detailView.value = alarmViews.value.find((view) => view.id === id) ?? null
}

function submitCreate() {
  errorMessage.value = ''
  const result = registerFluegasRecord({ ...form })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  showCreate.value = false
  Object.assign(form, {
    lineCode: '', towerTemp: '', carbonInjection: '', slurryFlow: '',
    outletTemp: '', operator: '', recordedAt: '',
  })
  reload()
}

function submitParams() {
  errorMessage.value = ''
  const result = updateFluegasAlarmParams({
    baseVersion: paramsForm.version,
    operator: '值班管理员',
    limits: {
      反应塔温度: { min: Number(paramsForm.limits['反应塔温度'].min), max: Number(paramsForm.limits['反应塔温度'].max) },
      活性炭喷射量: { min: Number(paramsForm.limits['活性炭喷射量'].min), max: Number(paramsForm.limits['活性炭喷射量'].max) },
    },
  })
  if (!result.ok) {
    errorMessage.value = result.message
    params.value = getFluegasAlarmParams()
    resetParamsForm()
    return
  }
  errorMessage.value = result.message
  params.value = getFluegasAlarmParams()
  resetParamsForm()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    alarmViews.value = getFluegasAlarmViews()
    params.value = getFluegasAlarmParams()
    if (detailView.value) {
      detailView.value = alarmViews.value.find((v) => v.id === detailView.value?.id) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '烟气净化运行列表读取失败'
  }
}

onMounted(reload)
</script>
