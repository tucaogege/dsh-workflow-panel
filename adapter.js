// Workflow panel — data adapter (host half, pure functions).
// Sole job: turn one project file + one live roster into one snapshot the client can render.
// Everything here is pure so it can be tested without DSH running; reading files is the only I/O.
//
// Matching rule (fixed by G0 decision, 2026-11-01):
//   liveId -> aliases -> name, and "unmatched" is a real state, never null/''.
// `via` records which rule won so the UI can explain a match instead of hiding it.

export const SCHEMA_VERSION = 1

// The vocabulary actually present in real data (6), kept open: unknown values pass through
// and are rendered from their raw string, so adding a state never needs a plugin release.
export const STATUS_LABELS = {
  done: '完成',
  dropped: '降级/取代',
  blocked: '阻塞',
  doing: '进行中',
  missing: '跳步/缺失',
  missed: '未达标',
}

const text = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const asArray = v => (Array.isArray(v) ? v : [])
// ?? and || cannot share one expression without parentheses; one helper keeps it honest.
const labelOf = status => {
  const s = text(status)
  return STATUS_LABELS[s] ?? (s || '未知')
}

// Milestone dates arrive as "11-01 01:05" today (no year) or as ISO once the field is cleaned up.
// Ordering is the whole value of a timeline, so it is decided here once — never in the view,
// where a second sort order would eventually disagree with this one.
// Result is always one of: parsed | unparsable | missing (three states, not two).
export function parseWhen(value) {
  const s = text(value)
  if (!s) return { whenIso: null, whenMissing: true, whenFormat: 'missing', whenInferred: false }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'))
    return Number.isNaN(t)
      ? { whenIso: null, whenMissing: false, whenFormat: 'unknown', whenInferred: false }
      : { whenIso: new Date(t).toISOString(), whenMissing: false, whenFormat: 'iso', whenInferred: false }
  }
  const m = s.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)
  if (m) {
    const year = new Date().getUTCFullYear()
    const t = Date.UTC(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]))
    // No year in the field: the year below is this machine's guess, so the view has to say so
    // instead of presenting a possibly wrong date as fact.
    return { whenIso: new Date(t).toISOString(), whenMissing: false, whenFormat: 'md-hm', whenInferred: true }
  }
  // A value that exists but cannot be read is NOT the same as a missing one: one is a data bug,
  // the other is a process gap. Both sort after real dates, and they sort differently to each other.
  return { whenIso: null, whenMissing: false, whenFormat: 'unknown', whenInferred: false }
}

const whenRank = m => (m.whenIso ? 0 : m.whenFormat === 'unknown' ? 1 : 2)

// Document kinds are the join key between what a gate must produce and what it did produce.
// A Chinese label in `requires` can never match a `kind`, so the pair is enum-to-enum only.
export const DOC_KIND_LABELS = {
  meeting: '会议记录',
  plan: '计划书',
  'milestone-table': '里程碑约束表',
  acceptance: '验收报告',
  'probe-report': '探测报告',
}

// Six gate states. They are counted separately and must never be merged into one "未产出":
// the first three mean different things to different people, and merging them is how an audit
// view starts lying.
export const GATE_STATES = {
  notDue: '暂不要求',      // requiresAfterStart 且项目未启动 —— 不是缺口
  satisfied: '已满足',     // requires 的每个 kind 都有对应文档
  partial: '部分满足',     // 有文档，但缺某个必需的 kind
  undelivered: '未产出',   // requires 非空，docs 为空 —— 流程缺口
  undefined: '应产出未定义', // requires 为空 —— 规范缺口，无法判定
  docError: '路径不存在',   // 数据错误；v1 只显示路径不校验文件（P15），故暂不会出现
}

const kindLabel = kind => DOC_KIND_LABELS[kind] ?? kind

// A doc entry may be a plain path string (early data) or an object with kind/label/note.
function normalizeDoc(entry) {
  if (typeof entry === 'string') {
    const path = text(entry)
    return path ? { path, kind: null, label: path.split(/[\\/]/).pop(), note: null } : null
  }
  if (!entry || typeof entry !== 'object') return null
  const path = text(entry.path)
  if (!path) return null
  return {
    path,
    kind: text(entry.kind) || null,
    label: text(entry.label) || path.split(/[\\/]/).pop(),
    note: text(entry.note) || null,
  }
}

// `requiresAfterStart` means "this gate is only judged once the project is formally started";
// `dependsOn` (optional) names the prerequisite gate explicitly. Only the former charges the
// conflict rule, so the two can exist without ever producing two answers.
function evaluateGate(g, context) {
  const requires = asArray(g?.requires).map(text).filter(Boolean)
  const docs = asArray(g?.docs).map(normalizeDoc).filter(Boolean)
  const legacy = text(g?.doc)
  if (legacy) docs.push({ path: legacy, kind: null, label: legacy.split(/[\\/]/).pop(), note: null })
  const docKinds = [...new Set(docs.map(d => d.kind).filter(Boolean))]
  const satisfiedKinds = requires.filter(k => docKinds.includes(k))
  const missingKinds = requires.filter(k => !docKinds.includes(k))
  const notDue = Boolean(g?.requiresAfterStart) && !context.started

  let state
  // requires empty is a spec gap and outranks everything: nothing can be judged against it.
  if (requires.length === 0) state = 'undefined'
  else if (notDue) state = 'notDue'
  else if (docs.length === 0) state = 'undelivered'
  else if (missingKinds.length === 0) state = 'satisfied'
  else state = 'partial'

  return {
    id: text(g?.id) || null,
    name: text(g?.name) || '(未命名门)',
    status: text(g?.status) || 'unknown',
    statusLabel: labelOf(g?.status),
    note: text(g?.note) || null,
    docs,
    requires,
    requiresLabel: requires.map(kindLabel),
    requiresAfterStart: Boolean(g?.requiresAfterStart),
    dependsOn: text(g?.dependsOn) || null,
    // Gate pass is declared by a human, never derived from how many documents exist (C27).
    passed: text(g?.status) === 'done',
    hasDoc: docs.length > 0,
    docKinds,
    satisfiedKinds,
    missingKinds,
    missingKindLabels: missingKinds.map(kindLabel),
    // A doc that exists but is not the kind this gate needs is trace, not evidence — say so.
    offKindDocs: docs.filter(d => d.kind && requires.length > 0 && !requires.includes(d.kind)),
    state,
    stateLabel: GATE_STATES[state],
  }
}


// Build lookup tables over the live roster. `id` in state.json is a uuid, while a project's
// member id is a stable slug ("lead") — two different namespaces, so they are never compared
// directly; only an explicit `liveId` bridges them.
export function indexLive(state) {
  const bots = Object.values(state?.bots ?? {}).filter(b => b && typeof b === 'object' && b.id !== undefined)
  const byLiveId = new Map()
  const byName = new Map()
  for (const bot of bots) {
    if (typeof bot.id === 'string') byLiveId.set(bot.id, bot)
    const name = text(bot.name)
    if (name) byName.set(name, bot)
  }
  return { bots, byLiveId, byName }
}

// aliases hold every historical name: the current name, next_name, and any earlier name.
// next_name is folded in here as well, so today's prototype data works before the field patch lands.
export function aliasesOf(member) {
  const list = [...asArray(member?.aliases), member?.next_name, member?.name]
  return [...new Set(list.map(text).filter(Boolean))]
}

/**
 * @returns {{ state: 'matched', via: 'liveId'|'aliases'|'name', bot: object }
 *          | { state: 'unmatched', via: null, bot: null }}
 */
export function matchMember(member, index) {
  const liveId = text(member?.liveId)
  if (liveId && index.byLiveId.has(liveId)) {
    return { state: 'matched', via: 'liveId', bot: index.byLiveId.get(liveId) }
  }
  for (const alias of aliasesOf(member)) {
    if (index.byName.has(alias)) return { state: 'matched', via: 'aliases', bot: index.byName.get(alias) }
  }
  // `name` is already inside aliasesOf(); the step is spelled out so the code order matches
  // the documented rule instead of being implied by one merged list.
  const name = text(member?.name)
  if (name && index.byName.has(name)) return { state: 'matched', via: 'name', bot: index.byName.get(name) }
  return { state: 'unmatched', via: null, bot: null }
}

// A task without evidence is the exact thing this panel exists to expose, so it is modelled
// as a first-class flag rather than an empty string that reads like "fine".
function normalizeTask(task) {
  const evidence = text(task?.evidence) || text(task?.note)
  return {
    title: text(task?.title) || '(未命名任务)',
    status: text(task?.status) || 'unknown',
    statusLabel: labelOf(task?.status),
    evidence: evidence || null,
    hasEvidence: Boolean(evidence),
    updatedAt: Number(task?.updatedAt) || null,
  }
}

/**
 * 成员 id 的唯一生成规则（契约 §13 L84：非空且稳定，禁止数组下标）。
 * 优先 raw.id；没有就 `m:` + 显示名（含 `(未命名)` 退化名，仍然非空）。
 * **people[].id 与 flows[].memberId/toMemberId 必须走这一个函数**，否则同一个成员会在
 * people 里是 null、在 flows 里是 `m:Chief`，任何按 id 的关联都会断（Lead 21:5x 实测抓到）。
 */
export function memberIdOf(member) {
  const raw = text(member?.id)
  if (raw) return raw
  return 'm:' + (text(member?.name) || '(未命名)')
}

function normalizeMember(member, index, warnings, isLead = false) {
  const match = matchMember(member, index)
  const tasks = asArray(member?.tasks).map(normalizeTask)
  const missingEvidence = tasks.filter(t => !t.hasEvidence).length
  const displayName = text(member?.name) || text(member?.id) || '(未命名)'
  if (match.state === 'unmatched') warnings.push(`成员 ${displayName} 未关联活体`)
  if (missingEvidence) warnings.push(`成员 ${displayName} 有 ${missingEvidence} 条任务未写明依据`)
  return {
    // 同一套规则（memberIdOf）：无 raw.id 时是 'm:'+显示名，绝不为 null、绝不用下标。
    id: memberIdOf(member),
    name: displayName,
    // 身份标记，不是推断：只有 project.lead 那一条为 true（Lead 21:47 裁定）。
    // 渲染器靠它把 Lead 从第 2 列成员卡里排除，不许拿 id === 'lead' 硬编码去猜。
    isLead: isLead === true,
    role: text(member?.role),
    model: text(member?.model) || null,
    effort: text(member?.effort) || null,
    score: typeof member?.score === 'number' ? member.score : null,
    duties: asArray(member?.duties).map(text).filter(Boolean),
    tasks,
    taskCounts: tasks.reduce((acc, t) => ((acc[t.status] = (acc[t.status] ?? 0) + 1), acc), {}),
    missingEvidence,
    // Always an object: 'unmatched' is a state, not null, so no caller can coerce it to ''.
    live: match.state === 'matched'
      ? {
          state: 'matched',
          via: match.via,
          botId: text(match.bot.id) || null,
          name: text(match.bot.name) || null,
          role: text(match.bot.role) || null,
          model: text(match.bot.model) || null,
          sessionId: text(match.bot.sessionId) || null,
          color: text(match.bot.color) || null,
        }
      : { state: 'unmatched', via: null, botId: null, name: null, role: null, model: null, sessionId: null, color: null },
  }
}

// nextProject 只是项目文件里的一块留档数据（下一项目的组织模板），照常透出、只做形状归一。
// 第四段「组织模板」渲染的是当前编制 people[]，不是这个字段——两者别混（Lead 18:13 裁定）。
// 空块必须读成「未填报」而不是消失，消失看起来像渲染 bug。
export function normalizeNextProject(value) {
  const empty = { present: false, note: null, roles: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty
  const roles = asArray(value.roles)
    .map(entry => (typeof entry === 'string'
      ? { name: text(entry) || null, role: null }
      : { name: text(entry?.name) || null, role: text(entry?.role) || null }))
    .filter(r => r.name || r.role)
  const note = text(value.note) || null
  if (!roles.length && !note) return empty
  return { present: true, note, roles }
}

/**
 * Merge project semantics with the live roster.
 * Live layer is optional by design: if state.json is missing, unreadable, or an unknown
 * version, the project half still renders — degraded and labelled, never blank, never fake.
 */
export function buildSnapshot(project, state, meta = {}) {
  const warnings = []
  const liveStatus = meta.liveStatus ?? 'ok' // 'ok' | 'unavailable' | 'unsupported'
  const index = liveStatus === 'ok' ? indexLive(state) : { bots: [], byLiveId: new Map(), byName: new Map() }

  // 「谁是 Lead」必须是数据给的事实，不是渲染器的猜测：唯一的标记源是 project.lead 这一段。
  // leadId 来自 project.lead.id（无 id 时为 null），people[].isLead 标在那一条成员上，
  // 其余全 false。两者只增不改，其余字段一律不动（向后兼容）。
  const leadHasSection = Boolean(project?.lead)
  // leadId 与 people[].id 必须逐字相等，所以同样走 memberIdOf：project.json 里有 raw.id 就是
  // "lead"，没有就是 "m:Chief"。若这里单独写 text(id)||null，lead 段无 id 的项目会得到
  // leadId=null 而 people[0].id="m:Chief"，渲染器按 leadId 排除就会漏掉 Lead。
  const leadId = leadHasSection ? memberIdOf(project.lead) : null
  const lead = leadHasSection ? [project.lead] : []
  const memberList = asArray(project?.agents)
  const people = [
    ...lead.map(m => normalizeMember(m, index, warnings, true)),
    ...memberList.map(m => normalizeMember(m, index, warnings, false)),
  ]

  // 契约 §4：同名成员必须由 raw.id / aliases 区分。撞成同一个 id 就是数据错误——静默合并
  // 成一个人是这类错误里最难查的（任务、证据、连线全糊在一起，看不出少了谁）。所以这里
  // 直接抛错并点名，宿主的 host.js 会把构造失败兜成 503 + 可读 reason，不会变成空白 500。
  const idOwner = new Map()
  for (const person of people) {
    const prior = idOwner.get(person.id)
    if (prior !== undefined) {
      throw new Error(`id 冲突：${person.id} 同时属于 ${prior.name} / ${person.name}（契约 §4：同名成员必须改用 raw.id 或 aliases 区分）`)
    }
    idOwner.set(person.id, person)
  }

  const matchedIds = new Set(people.filter(p => p.live.state === 'matched').map(p => p.live.botId))
  // Live people with no project entry are an audit finding in their own right: they are listed,
  // never silently dropped, and never added to the roster as if they belonged to the project.
  const unlistedLive = index.bots
    .filter(bot => !matchedIds.has(text(bot.id)))
    .map(bot => ({ botId: text(bot.id) || null, name: text(bot.name) || '(未命名)', role: text(bot.role) || null }))

  if (liveStatus === 'unavailable') warnings.push('实时层不可用：state.json 读不到，仅显示项目数据')
  if (liveStatus === 'unsupported') warnings.push('实时层版本不支持：state.json 的 version 不是 1，已停用实时匹配')
  if (unlistedLive.length) warnings.push(`有 ${unlistedLive.length} 个活体人员未在项目登记`)

  const started = Boolean(project?.started)
  const startedAt = text(project?.startedAt) || null
  const sourceGates = asArray(project?.gates)
  const gates = sourceGates.map((g, i) => evaluateGate(g, { started, sourceIndex: i }))

  // C26: the project claims to be started while a prerequisite gate has not passed. That is not
  // "not applicable" — it is a contradiction, and naming the gate is the whole finding.
  const startConflicts = []
  if (started) {
    for (const [i, g] of sourceGates.entries()) {
      if (!g?.requiresAfterStart) continue
      const prereqGateId = text(g?.dependsOn) || text(sourceGates[i - 1]?.id)
      const prereq = sourceGates.find(x => text(x?.id) === prereqGateId)
      if (prereq && text(prereq.status) !== 'done') {
        startConflicts.push({
          gateId: text(g?.id) || null,
          prereqGateId,
          prereqName: text(prereq?.name) || null,
          prereqStatus: text(prereq?.status) || 'unknown',
        })
      }
    }
  }
  // Sorted here so the timeline never re-invents order in the view. Real dates first (ascending),
  // then unreadable dates, then missing ones; ties fall back to source order so nothing dances
  // between polls.
  const milestones = asArray(project?.milestones)
    .map((m, sourceIndex) => ({
      name: text(m?.name) || '(未命名里程碑)',
      status: text(m?.status) || 'unknown',
      statusLabel: labelOf(m?.status),
      criteria: text(m?.criteria) || null,
      owner: text(m?.owner) || null,
      when: text(m?.when) || null,
      ...parseWhen(m?.when),
      sourceIndex,
    }))
    .sort((a, b) => whenRank(a) - whenRank(b)
      || (a.whenIso && b.whenIso ? a.whenIso.localeCompare(b.whenIso) : 0)
      || a.sourceIndex - b.sourceIndex)
  // Task flow: three columns need BOTH endpoints resolved, not just the source. Resolving only
  // `from` made every "对方" cell fall into 未分类 — that is why both sides are resolved here, by
  // the same id -> aliases -> name rule, and why `raw` is kept verbatim (renaming source data
  // would falsify the history).
  const byMemberKey = new Map()
  for (const member of [...lead, ...memberList]) {
    // 与 normalizeMember 用同一个 memberIdOf，两处 id 才会逐字相等。
    const memberId = memberIdOf(member)
    if (!memberId) continue
    for (const key of aliasesOf(member)) if (!byMemberKey.has(key)) byMemberKey.set(key, memberId)
    if (!byMemberKey.has(memberId)) byMemberKey.set(memberId, memberId)
  }
  const resolveEndpoint = raw => {
    const s = text(raw)
    if (!s) return { raw: null, name: null, memberId: null, resolvedBy: null }
    const member = [...lead, ...memberList].find(m => (text(m?.id) === s) || aliasesOf(m).includes(s))
    if (!member) return { raw: s, name: null, memberId: null, resolvedBy: null }
    const resolvedBy = text(member?.id) === s ? 'id' : (aliasesOf(member).includes(s) ? 'aliases' : 'name')
    // 解析不到就 null（进 unresolvedFlows），绝不给一个 people 里不存在的合成 id。
    return { raw: s, name: text(member?.name) || s, memberId: memberIdOf(member), resolvedBy }
  }
  // `edgeClass` — not `kind` — is the single classification the view is allowed to use; the
  // adapter decides it once so three columns can never disagree.
  const edgeClassOf = (kind, fromName, toEndpoint) => {
    const k = text(kind)
    // A handoff that lands back on the Lead is a report, not a handoff — checked BEFORE the enum
    // passthrough, otherwise `kind:'handoff'` would return early and reply edges would vanish.
    const leadKey = lead[0] ? memberIdOf(lead[0]) : ''
    if (k === 'handoff' && leadKey && toEndpoint.memberId === leadKey) return 'reply'
    if (k === 'issue' || k === 'handoff' || k === 'reply') return k
    // Unknown kind: an edge that came back to the Lead is still a report.
    if (leadKey && toEndpoint.memberId === leadKey) return 'reply'
    return 'handoff'
  }
  const flows = asArray(project?.flows).map(f => {
    const from = resolveEndpoint(f?.from)
    const to = resolveEndpoint(f?.to)
    return {
      raw: from.raw,
      name: from.name,
      memberId: from.memberId,
      resolvedBy: from.resolvedBy,
      toRaw: to.raw,
      toName: to.name,
      toMemberId: to.memberId,
      toResolvedBy: to.resolvedBy,
      edgeClass: edgeClassOf(f?.kind, from.name, to),
      label: text(f?.label) || null,
      // 任务级锚点（可选）：线头要指向具体任务，就必须由数据说清是哪一条。
      // 纯展示字段——不参与 edgeClass 判定，也不影响 resolvedBy；缺省一律 null
      // （不是 undefined，否则渲染器要写两套判空）。
      fromTask: text(f?.fromTask) || null,
      toTask: text(f?.toTask) || null,
    }
  })
  // Named, never dropped: an edge with an unresolved endpoint stays in `flows` (memberId null) AND
  // is listed here so the view can say 「未登记：<raw>」. The two lists are complementary views of
  // the same edges — flows.length stays === 源头边数.
  const unresolvedFlows = flows
    .map((f, i) => ({ i, ...f }))
    .filter(f => !f.memberId || (f.toRaw !== null && !f.toMemberId))
    .map(f => ({
      edgeIndex: f.i,
      raw: f.memberId ? null : f.raw,
      toRaw: f.toMemberId ? null : f.toRaw,
      edgeClass: f.edgeClass,
      label: f.label,
    }))
  const edgeCounts = { issue: 0, handoff: 0, reply: 0 }
  for (const f of flows) edgeCounts[f.edgeClass] += 1

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: Date.now(),
    readAt: meta.readAt ?? null,   // when state.json was actually read (may be older than generatedAt)
    stale: Boolean(meta.stale),    // live layer went quiet / could not be re-read
    liveStatus,
    // Whether the project is formally started is a project-side fact: it decides which gates are
    // judged at all, so the view must never infer it from document counts.
    started,
    startedAt,
    project: {
      name: text(project?.project) || '(未命名项目)',
      subtitle: text(project?.subtitle) || null,
      period: text(project?.period) || null,
      verdict: text(project?.verdict) || null,
      budget: project?.budget ?? null,
    },
    // The counting rule ships inside the payload, so no view can invent its own:
    // taskTotal includes the Lead; memberTaskTotal does not.
    // M2 freeze (Lead 17:12): the six task states are shipped as a block of their own, always all
    // six keys, zero included — a view may not compute them, and a missing key is a red.
    counts: {
      taskTotal: people.reduce((n, p) => n + p.tasks.length, 0),
      memberTaskTotal: memberList.reduce((n, m) => n + asArray(m?.tasks).length, 0),
      byStatus: people.flatMap(p => p.tasks).reduce((acc, t) => {
        if (Object.hasOwn(acc, t.status)) acc[t.status] += 1
        return acc
      }, { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0, missed: 0 }),
      people: people.length,
      gates: gates.length,
      milestones: milestones.length,
      flows: flows.length,
      flowsIssue: edgeCounts.issue,
      flowsHandoff: edgeCounts.handoff,
      flowsReply: edgeCounts.reply,
      unresolvedFlows: unresolvedFlows.length,
      liveBots: index.bots.length,
      unmatchedPeople: people.filter(p => p.live.state === 'unmatched').length,
      unlistedLive: unlistedLive.length,
      tasksWithoutEvidence: people.reduce((n, p) => n + p.missingEvidence, 0),
      // Audit ratios the 异常条 needs; each gate state is counted on its own, never merged.
      gatesWithoutDoc: gates.filter(g => !g.hasDoc).length,
      gatesNotDue: gates.filter(g => g.state === 'notDue').length,
      gatesSatisfied: gates.filter(g => g.state === 'satisfied').length,
      gatesPartial: gates.filter(g => g.state === 'partial').length,
      gatesUndelivered: gates.filter(g => g.state === 'undelivered').length,
      gatesUndefined: gates.filter(g => g.state === 'undefined').length,
      gatesDocError: gates.filter(g => g.state === 'docError').length,
      startConflicts: startConflicts.length,
    },
    people,
    // ⑤ 第 2 列的排除依据（Lead 21:47）：渲染器只许读这两个字段，不许自造 'lead' 字面量。
    // 规则见 docs/adapter-interface-v1.md §13.6：第 2 列 = people 中 isLead === false 的成员。
    leadId,
    gates,
    startConflicts,
    milestones,
    flows,
    unresolvedFlows,
    // ⚠️ 不是第四段的数据源（Lead 18:13 裁定）。第四段「组织模板」渲染的是**当前项目编制**
    // （成员/角色/模型/任务状态/职责，来自 people[]），开发组按 G4 页序实现的那版是对的。
    // 本字段只是把项目文件里的 nextProject 块照常透出，供结项复盘/模板留档用；
    // 别因为它叫 nextProject 就把第四段改成读它。
    nextProject: normalizeNextProject(project?.nextProject ?? project?.next_project),
    // 派生列（契约 §8）：v1 没有数据源，字段仍必须存在——出口少字段会被验收判红，
    // 且界面无法区分「0 条派生」与「这个功能还没做」。supported:false 是诚实口径。
    derived: { supported: false, count: 0 },
    unlistedLive,
    warnings,
  }
}
