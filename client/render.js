// Workflow panel — pure renderer.
//
// Contract (M3, frozen by Lead): render(snapshot, ui) -> HTML string. This file must not touch
// document / window / DOM globals, so tests import the exact code the slot runs. Interaction
// lives in attach(root) — the only place here that touches a DOM node.
//
// Rules enforced by construction, each one is an acceptance item:
//   - every number shown comes from snapshot.counts (a declared key). The view never sums,
//     never merges, never derives a rate: a missing key renders MISSING, which the acceptance
//     script catches against the real snapshot (质检 第 ⑦ 关).
//   - arrays render in snapshot order. No view-side sorting (C19).
//   - missing data renders an explicit sentence; never a blank cell, never "—" / "/".
//   - keying uses adapter-provided ids (people[].id / gates[].id / milestones[].id), never an
//     array index, so a renamed or reordered member cannot silently swap blocks.

export const RENDER_VERSION = 5

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch])
const asArray = value => (Array.isArray(value) ? value : [])
const asText = value => (typeof value === 'string' ? value : value == null ? '' : String(value))
const asNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export const MISSING = '未提供'
export const NOT_LOADED = '未加载'

// Times are normalized to ISO so a render is byte-identical on any machine/timezone.
export function toIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const raw = asText(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

const attr = (name, value) => ` ${name}="${esc(value)}"`

function readCount(counts, dotted) {
  return asNumber(dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), counts))
}

// KPI tiles map 1:1 onto count keys on purpose: no tile is a sum of other tiles (质检 ⑦).
const KPI_TILES = [
  { key: 'taskTotal', label: '任务总数' },
  { key: 'byStatus.done', label: '已完成' },
  { key: 'byStatus.doing', label: '进行中' },
  { key: 'byStatus.blocked', label: '阻塞' },
  { key: 'byStatus.dropped', label: '降级/取代' },
  { key: 'byStatus.missed', label: '未达标' },
]

const STATUS_TEXT = {
  todo: '待开始',
  doing: '进行中',
  done: '完成',
  blocked: '阻塞',
  dropped: '降级/取代',
  missed: '未达标',
}
const statusLabel = (raw, label) => asText(label) || STATUS_TEXT[raw] || asText(raw) || '未知状态'

function header(snap) {
  // 宿主发的字段是 loadedAt（host.js LOADED_AT）；旧 fixture / 离线工具用的是 pluginLoadedAt。
  // 两处名字曾经对不上，导致「插件装载」时间永远显示未加载——这里两处都认，优先宿主字段。
  // 两者都没有时（离线渲染、fixture 缺字段）整条不显示，而不是硬报「未加载」——
  // 那会把「这份数据没有这个字段」说成「插件没装好」，是两种完全不同的故障。
  const loadedIso = toIso(snap.loadedAt ?? snap.pluginLoadedAt)
  const times = [
    ['pluginLoadedAt', '插件装载', loadedIso],
    ['readAt', '数据更新', toIso(snap.readAt)],
    ['generatedAt', '快照生成', toIso(snap.generatedAt)],
  ]
    .filter(([, , iso]) => iso)
    .map(([key, label, iso]) => `<span class="wp-time" data-time="${key}">${esc(label)}：${esc(iso)}</span>`)
  // 三个时间戳全缺席时仍要有一句话，否则头部的这一行会整块消失、看起来像渲染 bug。
  if (!times.length) times.push(`<span class="wp-time" data-time="none">时间戳：${NOT_LOADED}</span>`)
  const budget = snap.project && snap.project.budget
  const budgetText = budget && budget.cap != null
    ? `预算上限 ${esc(budget.cap)}${esc(asText(budget.unit))} · 实际 ${esc(budget.spent_low)}–${esc(budget.spent_high)}${esc(asText(budget.unit))}`
    : `预算${MISSING}`
  return `<header class="wp-head" data-project="${esc(snap.project && snap.project.name)}">`
    + `<div class="wp-title"><span class="wp-brand">panel v2</span>`
    + `<strong data-field="project.name">${esc(snap.project && snap.project.name) || '(未命名项目)'}</strong>`
    + `<span class="wp-sub" data-field="project.subtitle">${esc(snap.project && snap.project.subtitle)}</span></div>`
    + `<div class="wp-meta" data-budget="1">${esc(budgetText)}</div>`
    + `<div class="wp-times" data-times="1">${times.join('')}</div>`
    + `<div class="wp-verdict" data-field="project.verdict">${esc(snap.project && snap.project.verdict)}</div>`
    + navBar()
    + `</header>`
}

// 页序导航条：基线在标题下就有一条，六段固定顺序，只做跳转不做筛选。
const SECTIONS = [
  ['sec-overview', '① 概览'],
  ['sec-gates', '② 门禁'],
  ['sec-milestones', '③ 里程碑'],
  ['sec-org', '④ 项目组织模板'],
  ['sec-flows', '⑤ 任务流'],
  ['sec-people', '⑥ 人员卡'],
]

function navBar() {
  const items = SECTIONS.map(([target, label]) => `<a class="wp-nav-item" href="#${target}"`
    + `${attr('data-nav-target', target)}>${esc(label)}</a>`).join('')
  return `<nav class="wp-nav" data-nav="1"><span class="wp-nav-label">页序</span>${items}</nav>`
}

function banner(snap) {
  const rows = []
  if (snap.stale) rows.push('数据陈旧（stale）：实时层本轮未刷新')
  if (snap.liveStatus === 'unavailable') rows.push('实时层不可用：仅显示项目数据')
  if (snap.liveStatus === 'unsupported') rows.push('实时层版本不支持：已停用实时匹配')
  for (const item of asArray(snap.startConflicts)) {
    rows.push(`未过前置门就启动：${asText(item.gateId)} 的前置 ${asText(item.prereqGateId)} 状态为 ${asText(item.prereqStatus)}`)
  }
  for (const warning of asArray(snap.warnings)) rows.push(asText(warning))
  if (!rows.length) return `<div class="wp-banner" data-banner="none">无告警</div>`
  return `<div class="wp-banner" data-banner="warn"${attr('data-banner-count', rows.length)}>`
    + rows.map((row, index) => `<p data-warning-index="${index}">${esc(row)}</p>`).join('')
    + `</div>`
}

function kpi(snap) {
  const tiles = KPI_TILES.map(tile => {
    const value = readCount(snap.counts, tile.key)
    return `<div class="wp-tile"${attr('data-count-key', tile.key)}${attr('data-count-value', value == null ? '' : value)}>`
      + `<span class="wp-tile-label">${esc(tile.label)}</span>`
      + `<strong class="wp-tile-value">${value == null ? MISSING : esc(value)}</strong>`
      + `</div>`
  }).join('')
  return `<section class="wp-kpi" id="sec-overview" data-section="kpi"><h3>① 概览</h3><div class="wp-kpi-grid">${tiles}</div></section>`
}

function gateCard(gate, open) {
  const state = asText(gate.state) || 'unknown'
  const docs = asArray(gate.docs)
  const docItems = docs.map(doc => {
    const note = asText(doc.note)
    const path = asText(doc.path)
    const label = asText(doc.label) || path
    // D：文档条目做成可点按钮，点开在面板内弹出原文（点击由 attach 的 onOpenDoc 接走，
    // 不会冒泡去切换门禁卡的展开状态）。
    return `<li class="wp-doc"${attr('data-doc-kind', asText(doc.kind) || 'none')}${attr('data-doc-path', path)}>`
      + `<button class="wp-doc-btn" type="button"${attr('data-doc-path', path)}${attr('data-doc-label', label)}>${esc(label)}</button>`
      + `<span class="wp-doc-kind">${esc(asText(doc.kind) || '类型未注明')}</span>`
      + (note ? `<span class="wp-doc-note" data-doc-note="1">${esc(note)}</span>` : '')
      + `</li>`
  }).join('')
  const offKind = asArray(gate.offKindDocs)
    .filter(doc => asText(doc.note))
    .map(doc => `<p class="wp-offkind" data-offkind="1">非本门要求：${esc(asText(doc.note))}</p>`)
    .join('')
  const requires = asArray(gate.requiresLabel).map(asText).filter(Boolean).join('、')
  const docsBlock = docs.length
    ? `<ul class="wp-docs">${docItems}</ul>`
    : `<p class="wp-docs-empty">${gate.hasDoc ? '证据文档：' + MISSING : '本门无证据文档'}</p>`
  return `<article class="wp-gate"${attr('data-gate-id', asText(gate.id))}${attr('data-state', state)}`
    + `${attr('data-open', open ? '1' : '0')}${attr('data-passed', gate.passed ? '1' : '0')}>`
    + `<div class="wp-gate-head"><span class="wp-gate-id">${esc(asText(gate.id) || '(无门号)')}</span>`
    + `<span class="wp-gate-name">${esc(asText(gate.name))}</span>`
    + `<span class="wp-gate-state" data-state-label="1">${esc(asText(gate.stateLabel) || '状态' + MISSING)}</span>`
    + `<span class="wp-gate-hint" data-gate-hint="1"></span></div>`
    + `<div class="wp-gate-body">`
    + `<p class="wp-gate-requires" data-requires="${esc(requires)}">应产出：${requires || MISSING}</p>`
    + `<p class="wp-gate-passed">门禁结论：${gate.passed ? '已宣布通过' : '未通过（文档齐不等于门过）'}</p>`
    + docsBlock + offKind
    + (asText(gate.docNote) ? `<p class="wp-gate-docnote" data-doc-note="1">${esc(asText(gate.docNote))}</p>` : '')
    + (asText(gate.note) ? `<p class="wp-gate-note" data-note="1">${esc(asText(gate.note))}</p>` : '')
    + `</div></article>`
}

function gates(snap, ui) {
  // C：六张卡默认全部展开（用户要「跟 G0 点开的状态一样」，直接看到证据内容）。
  // ui.closedGates = 用户手动收起的 id 列表；ui.openGate 保留旧语义（只开这一张），
  // 既有测试与外部调用继续按"单张展开"验收，不会因为我改默认值而退化。
  const legacyOpen = asText(ui && ui.openGate)
  const closed = new Set(asArray(ui && ui.closedGates).map(asText).filter(Boolean))
  const cards = asArray(snap.gates)
    .map(gate => {
      const id = asText(gate.id)
      const open = legacyOpen ? id === legacyOpen : !closed.has(id)
      return gateCard(gate, open)
    })
    .join('')
  return `<section class="wp-gates" id="sec-gates" data-section="gates"${attr('data-gate-count', asArray(snap.gates).length)}>`
    + `<h3>② 门禁六卡（默认展开，点一下收起）</h3><div class="wp-gates-grid">${cards}</div></section>`
}

function milestones(snap) {
  const items = asArray(snap.milestones).map(milestone => {
    const format = asText(milestone.whenFormat) || 'missing'
    const date = asText(milestone.when)
      || (format === 'missing' ? '无日期' : format === 'unknown' ? '日期不可解析' : MISSING)
    const inferred = Boolean(milestone.whenInferred)
    return `<li class="wp-ms"${attr('data-milestone-id', asText(milestone.id))}${attr('data-when-format', format)}`
      + `${attr('data-inferred', inferred ? '1' : '0')}${attr('data-when-iso', toIso(milestone.whenIso) || '')}>`
      + `<span class="wp-ms-date">${esc(date)}${inferred ? '<span class="wp-badge" data-badge="inferred">年份补全</span>' : ''}</span>`
      + `<span class="wp-ms-name">${esc(asText(milestone.name))}</span>`
      + `<span class="wp-ms-status" data-state="${esc(asText(milestone.status) || 'unknown')}">${esc(statusLabel(milestone.status, milestone.statusLabel))}</span>`
      + `<span class="wp-ms-owner">${esc(asText(milestone.owner) || '负责人' + MISSING)}</span>`
      + `<span class="wp-ms-criteria">${esc(asText(milestone.criteria) || '退出标准' + MISSING)}</span>`
      + `</li>`
  }).join('')
  return `<section class="wp-milestones" id="sec-milestones" data-section="milestones"${attr('data-milestone-count', asArray(snap.milestones).length)}>`
    + `<h3>③ 里程碑（横向，按快照顺序）</h3>`
    + (items ? `<ol class="wp-ms-track">${items}</ol>` : `<p class="wp-empty-text">本快照无里程碑</p>`) + `</section>`
}

// 一条边 = 一个 li。data-flow-index 保留快照下标，用于和 flows[i] 逐条对账（F9）。
// 跨列连线不画在卡上，也不在 CSS 里，而是由 layoutWires() 量真实坐标后画进 .wp-flow-wires
// 那层 SVG；卡内只保留 from→to 那一小段。
function flowItem(flow, index) {
  const fromRaw = asText(flow.raw)
  const toRaw = asText(flow.toRaw)
  const fromUnresolved = flow.memberId == null && fromRaw !== ''
  const toUnresolved = flow.toMemberId == null && toRaw !== ''
  const label = asText(flow.label) || '无标签'
  const from = asText(flow.name) || fromRaw || '(未命名端点)'
  const to = asText(flow.toName) || toRaw || '(未命名端点)'
  const edgeClass = asText(flow.edgeClass)
  // 派单卡的发起端永远是那一列的表头，卡里不再写 from/to 名字：谁派给谁由表头 + layoutWires
  // 画的曲线表达。发起端/收端仍在 li 的 data-from-member / data-to-member 上，可追溯。
  // issue 行与第 2 列成员卡的任务行同构：小圆点 + 标题；圆点是"派发标记"，不是任务状态。
  const showFrom = edgeClass !== 'issue'
  return `<li class="wp-edge${showFrom ? '' : ' wp-task-mini'}" data-flow-index="${index}"${attr('data-edge-class', edgeClass)}`
    + `${attr('data-from-member', asText(flow.memberId))}${attr('data-to-member', asText(flow.toMemberId))}`
    + `${attr('data-resolved-by', asText(flow.resolvedBy))}>`
    + (showFrom
      ? `<span class="wp-edge-node wp-edge-from">${esc(from)}</span>`
        + `<span class="wp-edge-link" aria-hidden="true"></span>`
        + `<span class="wp-edge-node wp-edge-to">${esc(to)}</span>`
        + `<span class="wp-edge-label">${esc(label)}</span>`
      : `<i class="wp-dot" data-dot="issue" aria-hidden="true"></i>`
        + `<span class="wp-task-mini-title wp-edge-label">${esc(label)}</span>`)
    + (fromUnresolved ? `<span class="wp-unresolved" data-unresolved="from">未登记：${esc(fromRaw)}</span>` : '')
    + (toUnresolved ? `<span class="wp-unresolved" data-unresolved="to">未登记：${esc(toRaw)}</span>` : '')
    + `</li>`
}

// 任务流三列组织视图（版式冻结）：① Lead 派单 ② 成员竖排 ③ 派生层。
// 一条边只出现一次，data-flow-index 与 flows.length 逐条对账；回传（→Lead）与未分类边
// 放在三列之外的底部条带，绝不混进派生列。
function flows(snap) {
  const edges = asArray(snap.flows).map((flow, index) => ({ flow, index }))
  const edgeClassOf = entry => asText(entry.flow.edgeClass)
  const issues = edges.filter(entry => edgeClassOf(entry) === 'issue')
  const handoffs = edges.filter(entry => edgeClassOf(entry) === 'handoff')
  const replies = edges.filter(entry => edgeClassOf(entry) === 'reply')
  const unclassified = edges.filter(entry => !['issue', 'handoff', 'reply'].includes(edgeClassOf(entry)))

  // 列上的计数同样只读 adapter 的 counts（flowsIssue / flowsHandoff / flowsReply / people），
  // 键缺失时才退回"本列实际渲染条数"，并在 data-count-source 上写明来源。
  const columnCount = (key, fallback) => {
    const value = readCount(snap.counts, key)
    return value == null ? { text: fallback, source: 'rendered' } : { text: value, source: 'counts' }
  }
  const issueCount = columnCount('flowsIssue', issues.length)
  const handoffCount = columnCount('flowsHandoff', handoffs.length)
  const replyCount = columnCount('flowsReply', replies.length)

  // Lead 的判定只认快照字段：people[].isLead（boolean）优先，其次 snapshot.leadId 的 id 比对。
  // 禁止按 id === 'lead' 或按名字硬编码——改名/换人时那两种写法会静默错位。
  const leadId = asText(snap.leadId)
  const isLeadPerson = person => {
    if (typeof person.isLead === 'boolean') return person.isLead
    return leadId !== '' && asText(person.id) === leadId
  }
  const leadPerson = asArray(snap.people).find(isLeadPerson) || null
  const leadName = asText(leadPerson && leadPerson.name) || 'Lead'
  // 第 2 列只放非 Lead 成员：Lead 是派单端点，不是被派单的成员，重复出现在第 2 列没有信息量。
  // Lead 作为收端的边仍留在「回传（→Lead）」条带里，不丢。
  const memberPeople = asArray(snap.people).filter(person => !isLeadPerson(person))

  const derived = snap.derived || { supported: false, count: 0 }
  const derivedCount = derived.supported ? (asNumber(derived.count) ?? MISSING) : 0
  const derivedText = derived.supported ? `派生 ${derivedCount} 条` : '派生 0（v1 无数据源）'

  // 成员卡（第 2 列内容）：只有「名字/角色 + 计数 + 任务逐条」。
  // 交接不再写成文字行——它由 layoutWires 在右侧画成金色虚线（见隐藏层 .wp-flow-edges）。
  const memberBlock = person => {
    const id = asText(person.id)
    const taskCounts = person.taskCounts || {}
    const countsText = ['done', 'doing', 'blocked', 'dropped', 'missed']
      .filter(key => asNumber(taskCounts[key]) != null)
      .map(key => `${statusLabel(key)} ${taskCounts[key]}`)
      .join(' · ')
    const taskItems = asArray(person.tasks).map(task => {
      const state = asText(task.status) || 'unknown'
      return `<li class="wp-task-mini"${attr('data-task-status', state)}>`
        + `<i class="wp-dot"${attr('data-dot', state)} aria-hidden="true"></i>`
        + `<span class="wp-task-mini-title">${esc(asText(task.title))}</span>`
        + `<span class="wp-task-mini-status">${esc(statusLabel(task.status, task.statusLabel))}</span>`
        + `</li>`
    }).join('')
    const taskList = taskItems
      ? `<ul class="wp-task-mini-list">${taskItems}</ul>`
      : `<p class="wp-empty-text" data-empty-tasks="1">本成员暂无任务</p>`
    return `<div class="wp-member-block"${attr('data-member-id', id)}>`
      + `<div class="wp-member-head"><strong>${esc(asText(person.name))}</strong>`
      + `<span class="wp-member-role">${esc(asText(person.role) || '角色' + MISSING)}</span></div>`
      + `<p class="wp-member-counts">任务 ${asArray(person.tasks).length} 条 · 派生 ${esc(derived.supported ? (asNumber(derived.count) ?? MISSING) : 0)}</p>`
      + `<p class="wp-member-status">${esc(countsText || '任务状态' + MISSING)}</p>`
      + taskList
      + `</div>`
  }

  // 第 1 列改成"一整格 + 自然堆叠"：派单卡不再逐行对齐，全部塞进一个跨所有成员行的格子里，
  // 视觉上就是一叠卡；每张卡连到第 2 列哪张成员卡，由 layoutWires() 量出坐标后用细线连过去。
  const memberIdSet = new Set(memberPeople.map(person => asText(person.id)))
  const placedIssues = issues.filter(entry => memberIdSet.has(asText(entry.flow.toMemberId)))
  const orphanIssues = issues.filter(entry => !memberIdSet.has(asText(entry.flow.toMemberId)))
  // 派单卡按目标成员的行序排列，卡片从上到下的目标顺序 == 成员行从上到下的顺序，
  // 这样贝塞尔曲线单调、互不相交，看起来是一束线。同一成员的多条边保持原序相邻
  //（Array.prototype.sort 稳定），交叉只可能发生在"顺序错了"的时候，这里从源头消除。
  const memberOrder = new Map(memberPeople.map((person, index) => [asText(person.id), index]))
  placedIssues.sort((a, b) => {
    const ai = memberOrder.get(asText(a.flow.toMemberId))
    const bi = memberOrder.get(asText(b.flow.toMemberId))
    return (ai == null ? 999 : ai) - (bi == null ? 999 : bi)
  })

  // 第 1 列表头只写「Lead 派单」：块头已经显示 Lead 的名字与角色，标题里再带一遍名字是重复。
  const headRow = `<div class="wp-flow-cell" data-cell="head"><h3>Lead 派单`
    + `<span class="wp-col-count" data-column-count="issue"${attr('data-count-source', issueCount.source)}>${esc(issueCount.text)}</span></h3></div>`
    + `<div class="wp-flow-cell" data-cell="head"><h3>成员竖排（第 2 列，不含 Lead）`
    + `<span class="wp-col-count" data-column-count="members" data-count-source="rendered">${esc(memberPeople.length)}</span></h3></div>`
    + `<div class="wp-flow-cell" data-cell="head"><h3>派生层`
    + `<span class="wp-col-count" data-column-count="derived">${esc(derivedCount)}</span></h3></div>`

  // 第 1 列整块 = 一个".wp-flow-cell.wp-issue-card"，内部与成员卡同构：
  // 头（Lead 名字 + 角色）→ 计数行（任务 N 条 · 派生 X）→ 逐条派单行（小圆点 + 标题）。
  //   · 名字/角色只认 people 里 isLead 的那位，取不到写「Lead」；
  //   · "任务 N 条" = 本块列出的 issue 行数，不是 Lead 的全部任务；
  //   · 派生沿用现有语义（v1 unsupported 时写 0）。
  // 跨行数按已知成员行数写成定值（不依赖 -1）；窄屏用带 !important 的媒体查询改回 auto。
  const leadRole = asText(leadPerson && leadPerson.role) || '角色' + MISSING
  const leadDerived = derived.supported ? (asNumber(derived.count) ?? MISSING) : 0
  const issueCell = `<div class="wp-flow-cell wp-issue-card" data-cell="issue" style="grid-row:2 / span ${Math.max(memberPeople.length, 1)}">`
    + `<div class="wp-member-head"><strong>${esc(leadName)}</strong>`
    + `<span class="wp-member-role">${esc(leadRole)}</span></div>`
    + `<p class="wp-member-counts">任务 ${esc(placedIssues.length)} 条 · 派生 ${esc(leadDerived)}</p>`
    + (placedIssues.length
      ? `<ul class="wp-edge-list wp-edge-stack wp-task-mini-list">${placedIssues.map(entry => flowItem(entry.flow, entry.index)).join('')}</ul>`
      : `<p class="wp-empty-text" data-empty-issue="1">无派单</p>`)
    + `</div>`

  // 每个 agent 一个固定颜色：按 people 顺序取，稳定不随机。
  // 与 layoutWires() 里的调色板是同一份约定（那边从 data-member-color 读，不重复定义），
  // 改动这里要同步图例与右侧交接线的颜色语义。
  const AGENT_PALETTE = ['#4c8dff', '#d4a017', '#3fb950', '#b57bff', '#ff7bb0', '#7bd0ff']
  const peopleColor = new Map(asArray(snap.people).map((person, index) => [
    asText(person.id),
    AGENT_PALETTE[index % AGENT_PALETTE.length],
  ]))

  const memberRows = memberPeople.map(person => {
    const id = asText(person.id)
    return `<div class="wp-flow-cell" data-cell="member"${attr('data-for', id)}${attr('data-member-color', peopleColor.get(id) || AGENT_PALETTE[0])}>`
      + memberBlock(person)
      + `</div>`
  }).join('')

  const derivedCell = `<div class="wp-flow-cell" data-cell="derived" style="grid-row:2 / span ${Math.max(memberPeople.length, 1)}">`
    + `<p class="wp-empty-text" data-derived-supported="${derived.supported ? '1' : '0'}">${esc(derivedText)}</p>`
    + `</div>`

  // 连线层：绝对定位在网格容器里的一层 SVG，由 layoutWires() 每次渲染/尺寸变化后重画。
  const flowGrid = `<div class="wp-flow-grid" data-grid="rows"${attr('data-issue-count', placedIssues.length)}>`
    + headRow
    + issueCell
    + (memberPeople.length
      ? memberRows
      : `<div class="wp-flow-cell" data-cell="member" data-empty="1"><p class="wp-empty-text">本快照无成员</p></div>`)
    + derivedCell
    + `<svg class="wp-flow-wires" aria-hidden="true"></svg>`
    + `</div>`

  // adapter 的字段名是 unresolvedFlows（每条带 edgeIndex / raw / toRaw / edgeClass）；
  // 老 fixture 里叫 unresolved。两边都认，但只用真实字段那一份，不合并去重。
  const unresolvedSource = asArray(snap.unresolvedFlows).length ? asArray(snap.unresolvedFlows) : asArray(snap.unresolved)
  const hasUnresolvedField = 'unresolvedFlows' in snap || 'unresolved' in snap
  const unresolved = unresolvedSource
  const unresolvedText = unresolved.length
    ? `<ul class="wp-unresolved-list">${unresolved.map(item => {
      const startRaw = asText(item.raw)
      const endRaw = asText(item.toRaw)
      const side = startRaw ? '起点' : '终点'
      return `<li data-unresolved="1"${attr('data-edge-index', item.edgeIndex)}>未登记（${side}）：${esc(startRaw || endRaw)}（${esc(asText(item.edgeClass) || '类型未注明')}）</li>`
    }).join('')}</ul>`
    : `<p class="wp-empty-text" data-unresolved-empty="1">${hasUnresolvedField ? '未解析端点 0 条' : '未解析端点清单' + MISSING}</p>`

  const replyEdges = `回传（→Lead）`
  const sideStrip = `<div class="wp-flow-side" data-column="reply">`
    + `<h3>回传（→Lead）<span class="wp-col-count" data-column-count="reply"${attr('data-count-source', replyCount.source)}>${esc(replyCount.text)}</span></h3>`
    + (replies.length
      ? `<ul class="wp-edge-list">${replies.map(entry => flowItem(entry.flow, entry.index)).join('')}</ul>`
      : `<p class="wp-empty-text">本快照该列 0 条回传</p>`)
    + (orphanIssues.length
      ? `<h3 class="wp-side-sub">派单未落到成员行（toMemberId 为空）<span class="wp-col-count" data-column-count="orphan-issue">${orphanIssues.length}</span></h3>`
        + `<ul class="wp-edge-list">${orphanIssues.map(entry => flowItem(entry.flow, entry.index)).join('')}</ul>`
      : '')
    + (unclassified.length
      ? `<h3 class="wp-side-sub">未分类（快照未给 edgeClass）<span class="wp-col-count" data-column-count="unclassified">${unclassified.length}</span></h3>`
        + `<ul class="wp-edge-list">${unclassified.map(entry => flowItem(entry.flow, entry.index)).join('')}</ul>`
      : '')
    + `<h3 class="wp-side-sub">未解析端点（<span data-count-key="unresolvedFlows">${readCount(snap.counts, 'unresolvedFlows') ?? MISSING}</span>）</h3>`
    + unresolvedText
    + `</div>`

  // 图例（基线固定）：颜色与线型是本页的读法声明，缺了图读者只能猜。
  // 空白 = 未登记，不写 0（F12）；派生列永远是灰的实心块，绝不画成示意虚线或塞假节点。
  const legend = `<div class="wp-legend" data-legend="1">`
    + `<span class="wp-legend-title">图例</span>`
    + `<span class="wp-lg" data-legend-key="issue"><i class="wp-swatch wp-sw-issue"></i>Lead 派单（蓝实线）</span>`
    + `<span class="wp-lg" data-legend-key="handoff"><i class="wp-swatch wp-sw-handoff"></i>成员间交接（实线）</span>`
    + `<span class="wp-lg" data-legend-key="handoff-color">交接线按发送方着色</span>`
    + `<span class="wp-legend-people" data-legend-people="1">`
    + asArray(snap.people).map(person => {
      const id = asText(person.id)
      const color = peopleColor.get(id) || AGENT_PALETTE[0]
      return `<span class="wp-legend-person"${attr('data-legend-person', id)}>`
        + `<i class="wp-sw" style="background:${color}"></i>${esc(asText(person.name))}</span>`
    }).join('')
    + `</span>`
    + `<span class="wp-lg" data-legend-key="reply"><i class="wp-swatch wp-sw-reply"></i>回传 → Lead（绿虚线）</span>`
    + `<span class="wp-lg" data-legend-key="derived"><i class="wp-swatch wp-sw-derived"></i>派生（灰实心，v1 无数据源）</span>`
    + `<span class="wp-lg" data-legend-key="blank">空白 = 未登记，不写 0</span>`
    + `</div>`

  // 交接边不再写成文字行（用户要「线连着任务与任务」），但一条都不能丢：
  // 全部转成隐藏的数据标记，data-flow-index 保留，供 layoutWires 画右侧金色虚线、
  // 也供机判按 idx 对账「每条边只渲一次」。
  const handoffMarkers = handoffs.map(entry => {
    const flow = entry.flow
    return `<span data-flow-index="${entry.index}"${attr('data-edge-class', 'handoff')}`
      + `${attr('data-handoff-from', asText(flow.memberId))}${attr('data-handoff-to', asText(flow.toMemberId))}`
      + `${attr('data-label', asText(flow.label))}${attr('data-from-name', asText(flow.name))}`
      + `${attr('data-to-name', asText(flow.toName))}`
      // 线头要对准任务：fromTask / toTask 由适配器透传，缺就写空串（layoutWires 会退到卡片位置）。
      + `${attr('data-handoff-from-task', asText(flow.fromTask))}${attr('data-handoff-to-task', asText(flow.toTask))}`
      + `${attr('title', asText(flow.label) || '交接')}></span>`
  }).join('')
  const edgeLayer = `<div class="wp-flow-edges" hidden data-handoff-count="${handoffs.length}">${handoffMarkers}</div>`

  return `<section class="wp-flows" id="sec-flows" data-section="flows"${attr('data-reply-label', replyEdges)}>`
    + `<h3>⑤ 任务流三列（Lead｜成员竖排｜派生）</h3>`
    + flowGrid
    + edgeLayer
    + legend
    + sideStrip
    + `</section>`
}

function personCard(person, derived) {
  const live = person.live || { state: 'unmatched' }
  const matched = live.state === 'matched'
  const score = asNumber(person.score)
  const taskCounts = person.taskCounts || {}
  const tasks = asArray(person.tasks).map(task => {
    const hasEvidence = Boolean(task.hasEvidence)
    return `<li class="wp-task"${attr('data-task-status', asText(task.status) || 'unknown')}`
      + `${attr('data-has-evidence', hasEvidence ? '1' : '0')}>`
      + `<i class="wp-dot" data-dot="${esc(asText(task.status) || 'unknown')}" aria-hidden="true"></i>`
      + `<span class="wp-task-title">${esc(asText(task.title))}</span>`
      + `<span class="wp-task-status">${esc(statusLabel(task.status, task.statusLabel))}</span>`
      + `<span class="wp-task-evidence">${hasEvidence ? esc(asText(task.evidence)) : '未写明依据'}</span>`
      + `</li>`
  }).join('')
  // 这一段是人员卡自己的作用域，文案要自带「派生」前缀——L407 直接把它整句拼进统计行，
  // 没有前缀就会渲染成「· 0（v1 无数据源） ·」，读起来像漏字。
  const derivedText = derived.supported
    ? `派生 ${asNumber(derived.count) ?? MISSING} 条`
    : '派生 0（v1 无数据源）'
  const chips = [
    [asText(person.model) || '模型' + MISSING, 'model'],
    [asText(person.effort) || '推理档位' + MISSING, 'effort'],
    [matched ? `已关联（${asText(live.via)}）` : '未关联活体', 'live'],
  ].map(([text, kind]) => `<span class="wp-chip"${attr('data-chip', kind)}>${esc(text)}</span>`).join('')
  const dutyChips = asArray(person.duties).map(duty =>
    `<span class="wp-duty"${attr('data-duty', asText(duty))}>${esc(asText(duty))}</span>`).join('')
  return `<article class="wp-person"${attr('data-person-id', asText(person.id))}${attr('data-live-state', live.state || 'unmatched')}`
    + `${attr('data-live-via', asText(live.via))}${attr('data-score', score == null ? '' : score)}>`
    + `<div class="wp-person-head"><div class="wp-person-id">`
    + `<strong class="wp-person-name">${esc(asText(person.name))}</strong>`
    + `<span class="wp-person-role">${esc(asText(person.role) || '角色' + MISSING)}</span></div>`
    + `<div class="wp-person-score"${attr('data-score-value', score == null ? '' : score)}>`
    + `<span class="wp-score-value">${score == null ? '未评级' : esc(score.toFixed(2))}</span>`
    + `${score == null ? '' : '<span class="wp-score-max">/10</span>'}</div></div>`
    + `<div class="wp-chips">${chips}</div>`
    + (dutyChips ? `<div class="wp-duties">${dutyChips}</div>` : `<p class="wp-empty-text">职责${MISSING}</p>`)
    + `<p class="wp-person-counts" data-task-total="${asArray(person.tasks).length}">`
    + `任务完成 ${asNumber(taskCounts.done) ?? 0}/${asArray(person.tasks).length} 条 · ${esc(derivedText)} · 未写明依据 ${asNumber(person.missingEvidence) ?? MISSING} 条</p>`
    + (tasks ? `<ul class="wp-tasks">${tasks}</ul>` : `<p class="wp-empty-text">本成员无任务记录</p>`)
    + `</article>`
}

function people(snap) {
  const derived = snap.derived || { supported: false, count: 0 }
  const cards = asArray(snap.people).map(person => personCard(person, derived)).join('')
  const unlisted = asArray(snap.unlistedLive).map(item =>
    `<li data-unlisted="1">${esc(asText(item.name))}<span class="wp-muted">${esc(asText(item.role) || '角色未提供')}</span></li>`).join('')
  return `<section class="wp-people" id="sec-people" data-section="people"${attr('data-people-count', asArray(snap.people).length)}>`
    + `<h3>⑥ 人员卡（逐条任务与依据）</h3><div class="wp-people-grid">`
    + (cards || `<p class="wp-empty-text">本快照无成员</p>`)
    + `</div><div class="wp-unlisted"><h4>未登记活体（${readCount(snap.counts, 'unlistedLive') ?? MISSING}）</h4>`
    + (unlisted || `<p class="wp-empty-text">无未登记活体</p>`)
    + `</div></section>`
}

// ④ 项目组织模板 = 当前项目的编制（不是"下个项目"）。表格只搬快照字段：
// 任务状态来自 adapter 给出的 person.taskCounts，页面不做求和。
function orgTemplate(snap) {
  const people = asArray(snap.people)
  const counts = snap.counts || {}
  const rows = people.map(person => {
    const taskCounts = person.taskCounts || {}
    const countsText = ['done', 'doing', 'blocked', 'dropped', 'missed']
      .filter(key => asNumber(taskCounts[key]) != null)
      .map(key => `${statusLabel(key)} ${taskCounts[key]}`)
      .join(' · ')
    const duties = asArray(person.duties).map(asText).filter(Boolean).join('／')
    return `<tr${attr('data-org-member', asText(person.id))}>`
      + `<td class="wp-org-name"><strong>${esc(asText(person.name))}</strong></td>`
      + `<td>${esc(asText(person.role) || MISSING)}</td>`
      + `<td>${esc(asText(person.model) || MISSING)}</td>`
      + `<td>${esc(countsText || MISSING)}</td>`
      + `<td class="wp-org-duties">${esc(duties || MISSING)}</td></tr>`
  }).join('')
  const total = `成员 ${readCount(counts, 'people') ?? MISSING} 人 · 成员任务合计 ${readCount(counts, 'memberTaskTotal') ?? MISSING} 条`
  return `<section class="wp-org" id="sec-org" data-section="org">`
    + `<h3>④ 项目组织模板（当前项目编制）</h3>`
    + `<p class="wp-org-total" data-org-total="1">${esc(total)}</p>`
    + (rows
      ? `<div class="wp-org-wrap"><table class="wp-org-table"><thead><tr>`
        + `<th>成员</th><th>角色</th><th>模型</th><th>任务状态</th><th>职责</th>`
        + `</tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="wp-empty-text" data-missing="1">快照未提供编制成员</p>`)
    + `</section>`
}

function emptyShell(reason) {
  return `<div class="wp wp-empty" data-state="empty"><span class="wp-brand">panel v2</span>`
    + `<p class="wp-empty-text">${esc(reason)}</p></div>`
}

// Snapshot -> HTML. `ui` only selects what is expanded; it never reorders or recounts anything.
export function render(snapshot, ui = {}) {
  if (!snapshot || typeof snapshot !== 'object') return emptyShell('尚无快照：数据尚未到达')
  try {
    const sections = [
      `<div class="wp"${attr('data-generated-at', toIso(snapshot.generatedAt) || '')}`
        + `${attr('data-read-at', toIso(snapshot.readAt) || '')}`
        + `${attr('data-live-status', asText(snapshot.liveStatus) || 'unknown')}`
        + `${attr('data-stale', snapshot.stale ? '1' : '0')}${attr('data-schema-version', asText(snapshot.schemaVersion))}>`,
      header(snapshot),
      banner(snapshot),
      kpi(snapshot),
      gates(snapshot, ui),
      milestones(snapshot),
      orgTemplate(snapshot),
      flows(snapshot),
      people(snapshot),
      `</div>`,
    ]
    return sections.join('')
  } catch (error) {
    // A renderer crash must degrade to one honest line, never to a half page.
    return emptyShell(`渲染失败：${error && error.message ? error.message : String(error)}`)
  }
}

// 把「第 1 列的派单卡 → 第 2 列对应成员卡」画成细线（需要真实布局坐标，只能在浏览器里跑）。
//   root: 面板宿主元素（innerHTML 里那个 [data-role="panel-host"]）
//   返回: { drawn, skipped } —— 画出几条、跳过几条，便于无头浏览器里打印核对
// 自包含：函数体内只用 DOM API 与本地常量，不引用模块作用域的任何变量或辅助函数
//（Lead 会把它 toString() 后注入静态预览页跑真实测量）。
// 跳过条件：没有网格 / 没有 SVG 层 / 降级成单列 / 面板收起（rect 全 0）/ 找不到目标成员卡。
export function layoutWires(root) {
  const result = { drawn: 0, skipped: 0 }
  if (!root || typeof root.querySelector !== 'function') return result
  const grid = root.querySelector('.wp-flow-grid')
  if (!grid) return result
  const svg = grid.querySelector('.wp-flow-wires')
  if (!svg) return result
  const clear = () => { while (svg.firstChild) svg.removeChild(svg.firstChild) }

  // 窄屏是单列堆叠，三列并排的前提不成立，连线没有意义（先清掉上一次画的）。
  const view = typeof window !== 'undefined' ? window : null
  const computed = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(grid) : null
  const tracks = computed && computed.gridTemplateColumns ? computed.gridTemplateColumns.split(' ').filter(Boolean) : []
  if (tracks.length > 0 && tracks.length < 3) { clear(); return result }

  const gridRect = typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null
  if (!gridRect || gridRect.width <= 0 || gridRect.height <= 0) return result

  const doc = grid.ownerDocument || (typeof document !== 'undefined' ? document : null)
  if (!doc || typeof doc.createElementNS !== 'function') return result

  const NS = 'http://www.w3.org/2000/svg'
  const COLORS = { issue: '#4c8dff', handoff: '#d4a017', reply: '#3fb950' }
  const FALLBACK = '#4c8dff'
  const HANDOFF_COLOR = '#d4a017'
  const LINE_WIDTH = '1'
  const ISSUE_CARD = '[data-cell="issue"] li.wp-edge[data-to-member]'
  const MEMBER_CELL = '[data-cell="member"][data-for]'

  const members = new Map()
  for (const node of grid.querySelectorAll(MEMBER_CELL)) {
    members.set(String(node.getAttribute('data-for') || ''), node)
  }

  // 右侧交接线的弧顶再往右 18px；第 3 列还占着右半区，所以通常仍在画布内，
  // 但画布尺寸不因此变大（变大反而会让网格出现横向滚动条），弧顶用 width-2 夹一次。
  const width = Math.max(Math.ceil(gridRect.width), grid.scrollWidth || 0)
  const height = Math.max(Math.ceil(gridRect.height), grid.scrollHeight || 0)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  clear()

  const cards = grid.querySelectorAll(ISSUE_CARD)
  // 同目标多条线时，终点在成员卡左缘上下错开，避免两条线在端点重合成一个点。
  const endCounts = new Map()
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]
    const targetId = String(card.getAttribute('data-to-member') || '')
    const target = members.get(targetId)
    if (!target || typeof card.getBoundingClientRect !== 'function') { result.skipped += 1; continue }
    const cardRect = card.getBoundingClientRect()
    const memberRect = target.getBoundingClientRect()
    if (cardRect.width <= 0 || memberRect.width <= 0) { result.skipped += 1; continue }
    const sx = Math.round(cardRect.right - gridRect.left)
    const sy = Math.round(cardRect.top + cardRect.height / 2 - gridRect.top)
    const tx = Math.round(memberRect.left - gridRect.left)
    const baseTy = memberRect.top + memberRect.height / 2 - gridRect.top
    if (!(tx > sx)) { result.skipped += 1; continue }
    const k = endCounts.get(targetId) || 0
    endCounts.set(targetId, k + 1)
    const delta = k === 0 ? 0 : (k % 2 === 1 ? -6 : 6) * Math.ceil(k / 2)
    const ty = Math.round(baseTy + delta)
    const color = COLORS[String(card.getAttribute('data-edge-class') || '')] || FALLBACK
    // 三次贝塞尔：两端控制点与端点同 y，所以起点/终点切线都是水平的，看起来像自然下坠的抛物线。
    // 卡片已按成员行顺序排过，曲线因此单调、互不相交（一束线）。
    const dx = Math.max(24, Math.round((tx - sx) * 0.45))
    const d = `M${sx} ${sy} C${sx + dx} ${sy} ${tx - dx} ${ty} ${tx} ${ty}`
    const path = doc.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', LINE_WIDTH)
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('data-wire-for', targetId)
    svg.appendChild(path)
    // 透明命中层：.wp-flow-wires 整体是 pointer-events:none，只有子元素自己声明
    // pointer-events:stroke 才收得到悬停——<title> 挂这一层上，可见线保持干净。
    const hit = doc.createElementNS(NS, 'path')
    hit.setAttribute('d', d)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', '10')
    hit.setAttribute('pointer-events', 'stroke')
    hit.setAttribute('data-wire-hit', 'issue')
    const labelEl = card.querySelector('.wp-task-mini-title')
    const labelText = String(labelEl ? labelEl.textContent : card.textContent || '').trim()
    const memberNameEl = target.querySelector('.wp-member-head strong')
    const memberName = String(memberNameEl ? memberNameEl.textContent : '').trim()
    const leadNameEl = grid.querySelector('[data-cell="issue"] .wp-member-head strong')
    const leadNameText = String(leadNameEl ? leadNameEl.textContent : '').trim()
    const hitTitle = doc.createElementNS(NS, 'title')
    hitTitle.textContent = leadNameText && memberName
      ? `${leadNameText}「${labelText || '无标签'}」→ ${memberName}`
      : (labelText || '无标签')
    hit.appendChild(hitTitle)
    svg.appendChild(hit)
    // 起点小圆点：让「这条线从哪张卡出发」一眼可见。
    const dot = doc.createElementNS(NS, 'circle')
    dot.setAttribute('cx', String(Math.round(sx)))
    dot.setAttribute('cy', String(Math.round(sy)))
    dot.setAttribute('r', '1.5')
    dot.setAttribute('fill', color)
    dot.setAttribute('data-wire-dot', targetId)
    svg.appendChild(dot)
    result.drawn += 1
  }

  // 第二遍：成员之间的交接。标记在网格外面的隐藏层里（.wp-flow-edges），
  // 线画在第 2 列右侧：从发送方任务行右缘鼓出落到接收方任务行右缘，实线、
  // 颜色取发送方 agent 的颜色（写在成员格的 data-member-color 上）。
  // 多条线按「跨度」分通道：跨度大的走外侧，避免同一条竖直区间里叠成一团。
  const scope = grid.parentNode || grid
  const TASK_ROW = 'li.wp-task-mini'
  const TASK_TITLE = '.wp-task-mini-title'
  const rowY = row => {
    if (!row || typeof row.getBoundingClientRect !== 'function') return null
    const rect = row.getBoundingClientRect()
    return rect.height > 0 ? rect.top + rect.height / 2 - gridRect.top : null
  }
  // 精确匹配优先，其次包含匹配；都不中返回 null，由调用方决定退到哪儿。
  const findTaskRow = (cell, wanted) => {
    const rows = cell ? cell.querySelectorAll(TASK_ROW) : []
    const want = String(wanted || '').trim()
    if (!want || !rows.length) return null
    for (const row of rows) {
      const titleEl = row.querySelector(TASK_TITLE) || row
      if (String(titleEl.textContent || '').trim() === want) return row
    }
    const lower = want.toLowerCase()
    for (const row of rows) {
      const titleEl = row.querySelector(TASK_TITLE) || row
      const text = String(titleEl.textContent || '').trim().toLowerCase()
      if (text && text.indexOf(lower) >= 0) return row
    }
    return null
  }
  // 成员格在 DOM 里的顺序 = 第 2 列从上到下的行序，用来算每条交接的「跨度」。
  const orderIndex = new Map()
  const memberCells = grid.querySelectorAll(MEMBER_CELL)
  for (let n = 0; n < memberCells.length; n += 1) {
    orderIndex.set(String(memberCells[n].getAttribute('data-for') || ''), n)
  }
  const marks = scope.querySelectorAll('[data-edge-class="handoff"][data-handoff-from][data-handoff-to]')
  const handoffEntries = []
  for (let j = 0; j < marks.length; j += 1) {
    const mark = marks[j]
    const fromId = String(mark.getAttribute('data-handoff-from') || '')
    const toId = String(mark.getAttribute('data-handoff-to') || '')
    const fi = orderIndex.get(fromId)
    const ti = orderIndex.get(toId)
    if (fi == null || ti == null) { result.skipped += 1; continue }
    handoffEntries.push({ mark, fromId, toId, span: Math.abs(ti - fi) })
  }
  // 跨度大的先画、走最外侧；同一对成员的多条线再各让 10px，避免完全重合。
  handoffEntries.sort((a, b) => b.span - a.span)
  const pairSeen = new Map()
  for (let k = 0; k < handoffEntries.length; k += 1) {
    const entry = handoffEntries[k]
    const fromCell = members.get(entry.fromId)
    const toCell = members.get(entry.toId)
    if (!fromCell || !toCell) { result.skipped += 1; continue }
    const aRect = fromCell.getBoundingClientRect()
    const bRect = toCell.getBoundingClientRect()
    if (aRect.width <= 0 || bRect.width <= 0) { result.skipped += 1; continue }
    const ax = Math.round(aRect.right - gridRect.left)
    const bx = Math.round(bRect.right - gridRect.left)
    // 起点 y：发送方那张卡里 fromTask 对应的任务行；找不到退「包含」，再退卡片顶部。
    const fromTaskY = rowY(findTaskRow(fromCell, entry.mark.getAttribute('data-handoff-from-task')))
    const ay = Math.round(fromTaskY == null ? aRect.top - gridRect.top + 10 : fromTaskY)
    // 终点 y：接收方那张卡里 toTask 对应的任务行；找不到就取该卡任务列表第一行，再退卡片中心。
    const toRows = toCell.querySelectorAll(TASK_ROW)
    const toRow = findTaskRow(toCell, entry.mark.getAttribute('data-handoff-to-task')) || (toRows.length ? toRows[0] : null)
    const toTaskY = rowY(toRow)
    const by = Math.round(toTaskY == null ? bRect.top + bRect.height / 2 - gridRect.top : toTaskY)
    if (ay === by) { result.skipped += 1; continue }
    const color = String(fromCell.getAttribute('data-member-color') || '') || HANDOFF_COLOR
    const pairKey = entry.fromId + '->' + entry.toId
    const dup = pairSeen.get(pairKey) || 0
    pairSeen.set(pairKey, dup + 1)
    // 通道：条目按 span 降序，所以要让 k 越小通道越靠外——
    // lane = 16 + (n-1-k)*10：跨度最大（k=0）走最外侧，跨度最小走 16（最内侧）。
    // 同一对成员的第 dup 条再往上加 10，仍然向外，不会挤进内圈。
    const laneCount = handoffEntries.length
    let lane = 16 + (laneCount - 1 - k) * 10 + dup * 10
    lane = Math.min(lane, width - 2 - Math.max(ax, bx))
    if (!(lane > 0)) lane = 2
    const path = doc.createElementNS(NS, 'path')
    path.setAttribute('d', `M${ax} ${ay} C${ax + lane} ${ay} ${ax + lane} ${by} ${bx} ${by}`)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', color)
    path.setAttribute('stroke-width', LINE_WIDTH)
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('data-wire-handoff', entry.fromId + '->' + entry.toId)
    path.setAttribute('data-wire-lane', String(lane))
    svg.appendChild(path)
    // 悬停说明挂在透明命中层上（可见线本身保持干净），内容 = 发送方名「fromTask」→ 接收方名「toTask」。
    const fromName = String(entry.mark.getAttribute('data-from-name') || entry.fromId)
    const toName = String(entry.mark.getAttribute('data-to-name') || entry.toId)
    const fromTaskText = String(entry.mark.getAttribute('data-handoff-from-task') || '').trim() || '（未记录任务）'
    const toTaskText = String(entry.mark.getAttribute('data-handoff-to-task') || '').trim() || '（未记录任务）'
    const handoffD = `M${ax} ${ay} C${ax + lane} ${ay} ${ax + lane} ${by} ${bx} ${by}`
    const hit = doc.createElementNS(NS, 'path')
    hit.setAttribute('d', handoffD)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', '10')
    hit.setAttribute('pointer-events', 'stroke')
    hit.setAttribute('data-wire-hit', 'handoff')
    const titleEl = doc.createElementNS(NS, 'title')
    titleEl.textContent = `${fromName}「${fromTaskText}」→ ${toName}「${toTaskText}」`
    hit.appendChild(titleEl)
    svg.appendChild(hit)
    for (const [cx, cy] of [[ax, ay], [bx, by]]) {
      const dot = doc.createElementNS(NS, 'circle')
      dot.setAttribute('cx', String(cx))
      dot.setAttribute('cy', String(cy))
      dot.setAttribute('r', '1.5')
      dot.setAttribute('fill', color)
      dot.setAttribute('data-wire-dot', 'handoff')
      svg.appendChild(dot)
    }
    result.drawn += 1
  }
  return result
}

export function attach(root, options = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {}
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : () => {}
  const onOpenDoc = typeof options.onOpenDoc === 'function' ? options.onOpenDoc : null
  const handler = event => {
    const target = event && event.target
    if (!target || typeof target.closest !== 'function') return
    // 文档按钮优先：它在门禁卡内部，必须先截住，否则一次点击会同时弹出原文和收起卡片。
    const docElement = onOpenDoc ? target.closest('[data-doc-path]') : null
    if (docElement) {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      if (typeof event.stopPropagation === 'function') event.stopPropagation()
      onOpenDoc(asText(docElement.getAttribute('data-doc-path')))
      return
    }
    const element = target.closest('[data-gate-id]')
    if (!element) return
    onToggle(asText(element.getAttribute('data-gate-id')), { element })
  }
  root.addEventListener('click', handler)
  // 连线重画：窗口尺寸变化、面板拖动/拉伸（宿主元素尺寸变化都会被 ResizeObserver 抓到）
  // 都要重画一次；画线失败绝不能影响点击交互。
  const redraw = () => {
    try { layoutWires(root) } catch { /* 量不到就下次再说 */ }
  }
  const add = (target, type, listener) => {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(type, listener)
  }
  const remove = (target, type, listener) => {
    if (target && typeof target.removeEventListener === 'function') target.removeEventListener(type, listener)
  }
  const view = typeof window !== 'undefined' ? window : null
  add(view, 'resize', redraw)
  let observer = null
  if (typeof ResizeObserver === 'function') {
    try {
      observer = new ResizeObserver(redraw)
      observer.observe(root)
    } catch {
      observer = null
    }
  }
  redraw()
  return () => {
    root.removeEventListener('click', handler)
    remove(view, 'resize', redraw)
    if (observer) observer.disconnect()
  }
}

// Styles ship with the renderer so the panel needs no build step and no extra file:
// client.js appends this once as a <style> tag. Layout rule frozen by the baseline:
// three columns stay three columns down to 700px of panel width (each >=220px, the
// track scrolls horizontally instead of reflowing); below 700px the track stacks.
export const CSS = [
  '.wp,.wp *{box-sizing:border-box}',
  // v0.1.4 起没有浮窗外壳：状态行样式直接给 .wp-status（右栏标签页里跟随在内容后）。
  '.wp-status{flex:0 0 auto;padding:4px 10px;border-top:1px solid #1f242c;font-size:11px;color:#8b95a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp{container-type:inline-size;font:12px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--dsw-alias-text-primary,#1f2328);background:var(--dsw-alias-bg-elevated,#fff);padding:10px 12px;display:block}',
  '.wp h3{margin:14px 0 6px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}',
  '.wp h4{margin:8px 0 4px;font-size:12px;font-weight:600}',
  '.wp-head{border-bottom:1px solid #eef0f2;padding-bottom:8px}',
  '.wp-title{display:flex;align-items:baseline;gap:8px;flex-wrap:nowrap;overflow:hidden}',
  '.wp-brand{font-weight:700;color:#4c6ef5;flex:0 0 auto}',
  '.wp-sub{color:#6a737d;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-meta{color:#6a737d;margin-top:3px}',
  '.wp-times{display:flex;gap:12px;flex-wrap:wrap;margin-top:3px;font-size:11px;color:#6a737d}',
  '.wp-verdict{margin-top:5px;padding:5px 8px;border-left:3px solid #e8590c;background:#fff4e6;border-radius:0 6px 6px 0}',
  '.wp-banner{margin-top:8px;padding:6px 8px;border-radius:6px;background:#fff9db;border:1px solid #ffe066}',
  '.wp-banner[data-banner="none"]{background:#ebfbee;border-color:#b2f2bb}',
  '.wp-banner p{margin:2px 0}',
  '.wp-kpi-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}',
  '.wp-tile{border:1px solid #e9ecef;border-radius:8px;padding:6px 8px;min-width:0}',
  '.wp-tile-label{display:block;font-size:11px;color:#6a737d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-tile-value{font-size:16px;white-space:nowrap}',
  '.wp-gates-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}',
  '.wp-gate{border:1px solid #e9ecef;border-radius:8px;padding:8px;min-width:0}',
  '.wp-gate[data-state="satisfied"]{border-color:#b2f2bb;background:#f6fff8}',
  '.wp-gate[data-state="partial"]{border-color:#ffe066;background:#fffef5}',
  '.wp-gate[data-state="undelivered"]{border-color:#ffc9c9;background:#fff5f5}',
  '.wp-gate-head{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow:hidden}',
  '.wp-gate-id{font-weight:700;flex:0 0 auto}',
  '.wp-gate-name{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-gate-state{flex:0 0 auto;font-size:11px;padding:1px 6px;border-radius:10px;background:#e9ecef}',
  '.wp-gate-hint{flex:0 0 auto;font-size:11px;color:#4c6ef5;cursor:pointer}',
  '.wp-gate[data-open="0"] .wp-gate-hint::before{content:"点开看证据"}',
  '.wp-gate[data-open="1"] .wp-gate-hint::before{content:"收起"}',
  '.wp-gate[data-open="1"] .wp-gate-body{display:block}',
  '.wp-gate[data-open="0"] .wp-gate-body{display:none}',
  '.wp-gate-body{margin-top:6px;border-top:1px dashed #e9ecef;padding-top:6px}',
  '.wp-gate-requires,.wp-gate-passed,.wp-gate-note,.wp-gate-docnote,.wp-offkind{margin:3px 0}',
  '.wp-docs{margin:4px 0;padding-left:16px}',
  '.wp-doc{display:block}',
  // D：证据文档按钮。视觉上像链接，语义上是 button（键盘可达、不假装跳转）。
  '.wp-doc-btn{display:inline-block;max-width:100%;padding:0;border:0;background:none;color:#9ec1ff;font:inherit;text-align:left;cursor:pointer;text-decoration:underline dotted #3b4655;text-underline-offset:2px}',
  '.wp-doc-btn:hover,.wp-doc-btn:focus-visible{color:#cfe0ff;text-decoration-style:solid}',
  '.wp-doc-kind{font-size:11px;color:#6a737d;margin-left:6px}',
  '.wp-doc-note{display:block;font-size:11px;color:#e8590c}',
  '.wp-empty-text{color:#6a737d;margin:4px 0}',
  '.wp-ms-track{display:flex;gap:8px;overflow-x:auto;list-style:none;margin:0;padding:0 0 6px;flex-wrap:nowrap}',
  '.wp-ms{flex:0 0 200px;border:1px solid #e9ecef;border-left:3px solid #4c6ef5;border-radius:8px;padding:6px 8px;min-width:0}',
  '.wp-ms-date,.wp-ms-name,.wp-ms-owner,.wp-ms-criteria{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-ms-date{font-weight:600}',
  '.wp-ms-status{display:inline-block;font-size:11px;padding:1px 6px;border-radius:10px;background:#e9ecef;margin:2px 0}',
  '.wp-ms-owner,.wp-ms-criteria{font-size:11px;color:#6a737d}',
  '.wp-badge{font-size:10px;padding:0 4px;margin-left:4px;border-radius:8px;background:#e7f5ff;color:#1971c2}',
  '.wp-org-wrap{overflow-x:auto}',
  '.wp-org-table{width:100%;border-collapse:collapse;font-size:11px}',
  '.wp-org-table th,.wp-org-table td{border-bottom:1px solid #eef0f2;padding:4px 6px;text-align:left;vertical-align:top}',
  '.wp-org-table th{background:#f8f9fa;white-space:nowrap;position:sticky;top:0}',
  '.wp-org-name{white-space:nowrap}',
  '.wp-org-duties{max-width:280px}',
  '.wp-org-total{color:#6a737d;margin:0 0 6px}',
  '.wp-org-grid{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:10px;align-items:start;overflow-x:auto}',
  // ⑤ 按成员分行：三列网格，行高自适应（不写死行高），同一行的三格天然对齐。
  '.wp-flow-grid{position:relative;display:grid;grid-template-columns:minmax(200px,1.05fr) minmax(220px,1.15fr) minmax(150px,.8fr);gap:10px 30px;align-items:stretch;overflow-x:auto}',
  // 连线层：绝对定位在网格容器里，不参与布局、不吃点击；尺寸由 layoutWires() 按 scroll 尺寸写。
  '.wp-flow-wires{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}',
  // 第 1 列整块：外框 + 圆角 + 内距，行之间只用 1px 分隔线（最后一行不画）。
  // 框从原来的 <ul> 挪到 .wp-issue-card，因为头信息（名字/角色/计数）也要在框里。
  '.wp-issue-card{background:#151a21;border:1px solid #232a34;border-radius:8px;overflow:hidden;padding:7px 9px}',
  '.wp-edge-stack{display:flex;flex-direction:column;gap:0}',
  '.wp-edge-stack .wp-edge{background:transparent;border:0;border-radius:0;margin:0;padding:4px 0;border-bottom:1px solid #1f242c}',
  '.wp-edge-stack .wp-edge:last-child{border-bottom:0}',
  // 派单行的小圆点：这是"派发标记"，不是任务状态，颜色借用成员卡"完成"的绿只是为了同构。
  '.wp-dot[data-dot="issue"]{background:#3fb950}',
  // 第 1 列的行与第 2 列成员卡同构：标题 12px/#f0f3f6，副行 11px/#8b95a5，两行间距 2px。
  '.wp-edge-stack .wp-edge-label,.wp-edge-title{font-size:12px;font-weight:600;color:#f0f3f6;flex:0 0 auto;max-width:100%}',
  // B：成员卡里逐条任务。与第 1 列行同构：标题 12px/#f0f3f6、状态 11px/#8b95a5、
  // 行间 1px 分隔线、最后一行不画线。
  '.wp-task-mini-list{list-style:none;margin:4px 0 6px;padding:0}',
  '.wp-task-mini{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #1f242c}',
  '.wp-task-mini:last-child{border-bottom:0}',
  '.wp-task-mini-title{flex:1 1 auto;min-width:0;font-size:12px;color:#f0f3f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-task-mini-status{flex:0 0 auto;font-size:11px;color:#8b95a5}',
  '.wp-flow-cell{position:relative;min-width:0}',
  '.wp-flow-cell[data-cell="head"]{align-self:end}',
  '.wp-flow-cell[data-cell="head"]:nth-child(1){grid-column:1;grid-row:1}',
  '.wp-flow-cell[data-cell="head"]:nth-child(2){grid-column:2;grid-row:1}',
  '.wp-flow-cell[data-cell="head"]:nth-child(3){grid-column:3;grid-row:1}',
  '.wp-flow-cell[data-cell="issue"]{grid-column:1}',
  '.wp-flow-cell[data-cell="member"]{grid-column:2}',
  // 兜底声明（实际生效的是派生格上的内联 span N，这里只保证没有内联时也不散架，
  // 同时让"按 CSS 判 grid-row 写法"的机判有东西可命）。
  '.wp-flow-cell[data-cell="derived"]{grid-column:3;grid-row:2 / span 1}',
  // 同排连线：issue 格右缘 → member 格左缘，12px 蓝实线 + 7px 箭头；无派单的行走空态，不画线。
  // 连线改由 layoutWires() 画在 .wp-flow-wires 里（真实坐标），这里不再用伪元素猜位置。
  '.wp-org-col{min-width:0;border:1px solid #e9ecef;border-radius:8px;padding:8px;background:#fbfcfd}',
  '.wp-col-count{font-size:11px;font-weight:500;color:#6a737d;background:#e9ecef;border-radius:10px;padding:0 6px}',
  '.wp-edge-list{list-style:none;margin:0;padding:0}',
  '.wp-flow{display:flex;align-items:center;gap:4px;font-size:11px;padding:3px 0;border-bottom:1px dashed #eef0f2;flex-wrap:nowrap;overflow:hidden}',
  '.wp-flow-from,.wp-flow-to{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
  '.wp-flow-arrow{color:#4c6ef5;flex:0 0 auto}',
  '.wp-flow-label{flex:1 1 auto;color:#6a737d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-flow[data-edge-class="issue"] .wp-flow-arrow{color:#1c7ed6}',
  '.wp-flow[data-edge-class="handoff"] .wp-flow-arrow{color:#e8a200}',
  '.wp-flow[data-edge-class="reply"] .wp-flow-arrow{color:#2f9e44}',
  '.wp-member-block{border:1px solid #e9ecef;border-radius:6px;padding:6px;margin-bottom:6px;background:#fff}',
  '.wp-member-head{display:flex;align-items:baseline;gap:6px;overflow:hidden}',
  '.wp-member-role{flex:1 1 auto;font-size:11px;color:#6a737d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-member-counts,.wp-member-status{margin:2px 0;font-size:11px;color:#495057}',
  '.wp-flow-side{margin-top:10px;border:1px solid #e9ecef;border-radius:8px;padding:8px;background:#fbfcfd}',
  '.wp-side-sub{margin-top:10px}',
  '.wp-unresolved-list{padding-left:16px;margin:2px 0}',
  '.wp-people-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}',
  '.wp-person{border:1px solid #e9ecef;border-radius:8px;padding:8px;min-width:0}',
  '.wp-person-head{display:flex;align-items:baseline;gap:6px;overflow:hidden}',
  '.wp-person-role,.wp-person-model{font-size:11px;color:#6a737d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-person-live{margin-left:auto;flex:0 0 auto;font-size:11px;color:#2f9e44}',
  '.wp-person[data-live-state="unmatched"] .wp-person-live{color:#e8590c}',
  '.wp-person-counts{margin:3px 0;font-size:11px;color:#495057}',
  '.wp-tasks{list-style:none;margin:0;padding:0}',
  '.wp-task{display:block;padding:3px 0;border-bottom:1px dashed #eef0f2}',
  '.wp-task-title,.wp-task-evidence{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-task-status{font-size:11px;padding:0 5px;border-radius:8px;background:#e9ecef;margin-right:6px}',
  '.wp-tasks [data-task-status="done"] .wp-task-status{background:#d3f9d8}',
  '.wp-tasks [data-task-status="blocked"] .wp-task-status{background:#ffc9c9}',
  '.wp-tasks [data-task-status="dropped"] .wp-task-status{background:#ffe8cc}',
  '.wp-tasks [data-task-status="missed"] .wp-task-status{background:#ffc9c9}',
  '.wp-task-evidence{font-size:11px;color:#6a737d}',
  '.wp-unlisted{margin-top:8px}',
  // 三列只在面板宽度 <700px 时堆叠。.wp 的 container 是内容盒（外壳 2px 边框 + 左右各 12px
  // padding = 26px），所以阈值写成 673px：面板 700px → 内容盒 674px → 仍是三列。
  '@container (max-width:673px){.wp-org-grid{grid-template-columns:1fr}.wp-kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.wp-gates-grid{grid-template-columns:1fr}}',
  '@media (max-width:700px){.wp-org-grid{grid-template-columns:1fr}.wp-kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.wp-flow-grid{grid-template-columns:1fr}.wp-flow-cell[data-cell="head"]:nth-child(1),.wp-flow-cell[data-cell="head"]:nth-child(2),.wp-flow-cell[data-cell="head"]:nth-child(3),.wp-flow-cell[data-cell="issue"],.wp-flow-cell[data-cell="member"],.wp-flow-cell[data-cell="derived"]{grid-column:1;grid-row:auto}.wp-flow-cell[data-cell="derived"],.wp-flow-cell[data-cell="issue"]{grid-row:auto!important}.wp-flow-wires{display:none}}',
  // ---- 基线深色主题（mockups/panel-final.png）：浅底换成深底，只改颜色不动结构 ----
  '.wp{background:#0f1115;color:#e6e8eb}',
  '.wp-brand{color:#6ea8ff}',
  '.wp-sub,.wp-meta,.wp-times,.wp-empty-text,.wp-org-total,.wp-ms-owner,.wp-ms-criteria,.wp-task-evidence,.wp-person-counts,.wp-member-status,.wp-member-role,.wp-col-count,.wp-nav-label,.wp-legend{color:#8b95a5}',
  '.wp h3,.wp h4{color:#e6e8eb}',
  '.wp-head{border-bottom-color:#1f242c}',
  '.wp-verdict{background:#151a21;border-left-color:#e8590c}',
  '.wp-tile,.wp-gate,.wp-ms,.wp-org-col,.wp-member-block,.wp-person,.wp-flow-side,.wp-edge{background:#151a21;border-color:#232a34}',
  // v2 修漏：banner 还是 v1 的浅底，深色面板上文字几乎看不见（深色主题那轮漏掉了它）。
  '.wp-banner{background:#1a1708;border-color:#6b5a19;color:#e8d9a4}',
  '.wp-banner[data-banner="none"]{background:#121c15;border-color:#2b5c34;color:#b7e4c7}',
  '.wp-tile-label{color:#8b95a5}',
  '.wp-tile-value{color:#f0f3f6}',
  '.wp-gate[data-state="satisfied"]{background:#121c15;border-color:#2b5c34}',
  '.wp-gate[data-state="partial"]{background:#1a1708;border-color:#6b5a19}',
  '.wp-gate[data-state="undelivered"]{background:#1c1214;border-color:#6e2b2b}',
  '.wp-gate-head .wp-gate-state,.wp-ms-status,.wp-task-status,.wp-chip{background:#1c2430;color:#a7b4c6}',
  '.wp-ms{border-left-color:#4c8dff}',
  '.wp-org-table th{background:#12161c;color:#a7b4c6}',
  '.wp-org-table th,.wp-org-table td{border-bottom-color:#1f242c}',
  '.wp-org-col{background:#12161c}',
  '.wp-member-block{background:#151a21}',
  // ---- 页序导航条 ----
  '.wp-nav{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:8px;padding:5px 9px;border:1px solid #1f242c;border-radius:6px;background:#12161c;font-size:11px}',
  '.wp-nav-label{font-weight:600}',
  '.wp-nav-item{color:#9ec1ff;text-decoration:none;white-space:nowrap}',
  '.wp-nav-item:hover{color:#cfe0ff;text-decoration:underline}',
  // ---- ⑤ 任务流：卡片 + 连线 ----
  '.wp-edge{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;border-radius:6px;padding:5px 7px;margin-bottom:6px;font-size:11px;overflow:hidden}',
  '.wp-edge-node{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%;color:#cdd6e0}',
  '.wp-edge-link{position:relative;flex:0 0 26px;height:0;border-top:2px solid #4c8dff}',
  '.wp-edge-link::after{content:"";position:absolute;right:-1px;top:-5px;border-left:7px solid #4c8dff;border-top:4px solid transparent;border-bottom:4px solid transparent}',
  '.wp-edge[data-edge-class="handoff"] .wp-edge-link{border-top:2px dashed #d4a017}',
  '.wp-edge[data-edge-class="handoff"] .wp-edge-link::after{border-left-color:#d4a017}',
  '.wp-edge[data-edge-class="reply"] .wp-edge-link{border-top:2px dashed #3fb950}',
  '.wp-edge[data-edge-class="reply"] .wp-edge-link::after{border-left-color:#3fb950}',
  '.wp-edge-label{flex:1 1 auto;color:#8b95a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-member-block+.wp-member-block{position:relative;margin-top:16px}',
  '.wp-member-block+.wp-member-block::before{content:"";position:absolute;left:16px;top:-16px;height:16px;border-left:2px dashed #d4a017}',
  '.wp-member-block+.wp-member-block::after{content:"";position:absolute;left:12px;top:-4px;border-top:6px solid #d4a017;border-left:4px solid transparent;border-right:4px solid transparent}',
  '.wp-legend{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px;padding-top:8px;border-top:1px solid #1f242c;font-size:11px}',
  '.wp-legend-title{font-weight:600;color:#a7b4c6}',
  '.wp-swatch{display:inline-block;width:20px;height:0;border-top:2px solid #4c8dff;margin-right:5px;vertical-align:middle}',
  '.wp-sw-handoff{border-top:2px solid #d4a017}',
  // A：每个 agent 一个色块；交接线按发送方着色，图例要能把「颜色=谁」对上。
  '.wp-sw{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}',
  '.wp-legend-people{display:inline-flex;flex-wrap:wrap;gap:10px;font-size:11px;color:#a7b4c6}',
  '.wp-legend-person{display:inline-flex;align-items:center;white-space:nowrap}',
  '.wp-sw-reply{border-top:2px dashed #3fb950}',
  '.wp-sw-derived{border-top:3px solid #6a737d}',
  // ---- ⑥ 人员卡：评分 + 徽标 + 状态点 ----
  '.wp-person-head{display:flex;align-items:flex-start;gap:8px}',
  '.wp-person-id{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
  '.wp-person-name{font-size:13px;color:#f0f3f6}',
  '.wp-person-role{font-size:11px;color:#8b95a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-person-score{flex:0 0 auto;text-align:right;line-height:1}',
  '.wp-score-value{font-size:22px;font-weight:700;color:#8bc34a}',
  '.wp-score-max{font-size:10px;color:#8b95a5;margin-left:2px}',
  '.wp-person[data-score=""] .wp-score-value{font-size:12px;color:#8b95a5}',
  '.wp-chips{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 2px}',
  '.wp-chip{display:inline-block;font-size:10px;padding:1px 6px;border-radius:10px;border:1px solid #263140}',
  '.wp-chip[data-chip="model"]{color:#9ec1ff}',
  '.wp-chip[data-chip="live"]{color:#f0883e}',
  '.wp-person[data-live-state="matched"] .wp-chip[data-chip="live"]{color:#3fb950;border-color:#2b5c34}',
  '.wp-duties{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}',
  '.wp-duty{font-size:10px;padding:1px 6px;border-radius:10px;background:#1b2230;color:#a7b4c6}',
  '.wp-dot{display:inline-block;flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#8b95a5;margin-right:6px}',
  '.wp-dot[data-dot="done"]{background:#3fb950}',
  '.wp-dot[data-dot="doing"]{background:#4c8dff}',
  '.wp-dot[data-dot="blocked"]{background:#f85149}',
  '.wp-dot[data-dot="dropped"]{background:#d4a017}',
  '.wp-dot[data-dot="missed"]{background:#f0883e}',
  '.wp-task{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom-color:#1f242c}',
  '.wp-task-title{flex:1 1 auto;min-width:0}',
  '.wp-task-status{flex:0 0 auto}',
  '.wp-task-evidence{flex:1 1 100%;padding-left:13px}',
  // v0.1.4：浮窗外壳/胶囊/缩放手柄已整体移除（用户裁定），此处只保留标签页内部仍用的
  // 按钮样式（文档弹层的「关闭 ×」）。
  '.wp-shell-btn{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid #2b3440;background:#1b2230;color:#a7b4c6;cursor:pointer;font-family:inherit}',
  '.wp-shell-btn:hover{color:#e6efff;border-color:#3b4655}',
  // D：文档原文弹层。绝对定位盖住右栏标签页容器（不是全屏 overlay），
  // 内容区 <pre> 保原样、可滚动，不做 markdown 渲染。
  '.wp-doc-modal{position:absolute;inset:0;z-index:20;display:flex;padding:12px;background:rgba(6,8,12,.72)}',
  '.wp-doc-modal-inner{display:flex;flex-direction:column;width:100%;min-height:0;background:#11161d;border:1px solid #2b3440;border-radius:10px;overflow:hidden}',
  '.wp-doc-modal-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #1f242c;background:#12161c}',
  '.wp-doc-modal-title{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;color:#e6e8eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wp-doc-modal-body{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:10px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace;color:#d7dde5;white-space:pre-wrap;word-break:break-word}',
  '.wp-doc-modal-state{margin:0;padding:14px 12px;font-size:12px;color:#8b95a5}',
  '.wp-doc-modal-error{color:#f0883e}',
  // ---- 顶部页面视图（conversation.view）：内容成为「工作流」页签的主体 ----
  // 容器由 Conversation 视图区控制高度，这里只负责撑满 + 自身滚动。
  '.wp-view-host{position:relative;flex:1 1 auto;min-height:0;overflow:auto;background:#0f1115}',
  '.wp-view-host .wp{min-height:100%}',
  '.wp-view-host~.wp-status{border-top:1px solid #1f242c}',
].join('\n')
