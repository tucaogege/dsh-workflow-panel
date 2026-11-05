// dsh-workflow-panel — host half (M1 shell).
//
// Two exact Fetch routes, both GET only, read-only by construction: the only file
// access here is read. The browser half polls the snapshot route and paints
// whatever comes back; the doc route returns the raw text of one evidence file
// so a gate card can show it in place. Nothing in this plugin ever writes to
// state.json, project.json, the ledger or a doc.
//
// Three timestamps travel with every response, each from a different source.
// The acceptance script proves they differ (they answer three different
// questions, so collapsing two of them would hide the interesting case):
//   loadedAt    — when this plugin instance was mounted (host process)
//   generatedAt — when this snapshot was assembled (per response)
//   readAt      — when the source files were last actually read (cache hits
//                 keep the old value on purpose: that is how a silent writer
//                 is detected)
//
// Data sources are injectable so acceptance can point at fixtures instead of
// the live system (`DWP_STATE_PATH` / `DWP_PROJECT_PATH` / `DWP_LEDGER_DIR`,
// env first, plugin config second, then workspace auto-discovery).
import { readdirSync, statSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { buildSnapshot } from './adapter.js'

export const name = 'dsh-workflow-panel'
export const inject = ['connection']
export const ROUTE = '/api/workflow-panel'
// Second route: evidence text for the gate cards. Kept separate from the snapshot
// route on purpose — one request per clicked doc, not one per poll, and a huge or
// private file cannot delay the board.
export const DOC_ROUTE = '/api/workflow-panel/doc'
export const PLUGIN_VERSION = '0.1.5'
// Hard ceiling for a doc body. Evidence files are meeting notes and plans; a file
// past this is not something a card should inline, and reading it would block the
// host process while it happens.
export const DOC_MAX_BYTES = 256 * 1024
// Whitelist, not blacklist: only text the panel can render. Anything else (an
// executable, a database, an office archive) is refused even inside the project.
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.json'])
// Mount time, not response time: this is the third time the panel marks, and it
// is the only one that can show "the plugin is older than the data".
const LOADED_AT = Date.now()

// NOTE: no `HERE`-relative project path any more. The plugin is installed under a
// profile's node_modules, so "the file next to the plugin" only works on the
// machine that developed it. Resolution is env -> config -> workspace discovery.
// A read older than this is reported as stale. The browser half polls every
// 15 s, so three missed writes in a row is a stopped writer, not a blip.
export const READ_STALE_MS = 45000

const expandHome = value => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Auto-discover the project file when neither env nor config names one.
 *
 * Why this exists: the plugin is installed under some profile's node_modules,
 * so a path relative to the plugin (`HERE/../project.json`) is wrong on every
 * other machine. The one thing a project always has is its own workspace.
 *
 * Rules (deliberately boring, and deterministic):
 *   - scan `<DSH_HOME>/bot/workspace/<dir>/project.json` — ONE level only, no
 *     recursion, so a nested node_modules can never be walked;
 *   - skip any candidate whose path contains a `node_modules` segment (a
 *     directory literally named node_modules can sit directly under workspace);
 *   - newest `mtimeMs` wins; an exact tie breaks by path order, so two files
 *     written in the same millisecond still resolve the same way twice.
 */
export function discoverProject(dshHome) {
  const root = join(dshHome, 'bot', 'workspace')
  const scanned = []
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    entries = [] // an absent workspace is "no candidates", not a crash
  }
  for (const entry of entries) {
    let isDir = false
    try {
      isDir = entry.isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    const candidate = join(root, entry.name, 'project.json')
    if (candidate.split(/[\\/]+/).includes('node_modules')) continue
    try {
      const info = statSync(candidate)
      if (!info.isFile()) continue
      scanned.push({ path: candidate, mtimeMs: info.mtimeMs })
    } catch {
      // Not every workspace directory is a project; a miss is the common case.
    }
  }
  const sorted = [...scanned].sort((a, b) => (b.mtimeMs - a.mtimeMs)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { root, scanned: sorted.map(candidate => candidate.path), picked: sorted[0]?.path ?? null }
}

/**
 * Resolve the three data sources, in a fixed priority order (highest first):
 *   1. env `DWP_PROJECT_PATH`
 *   2. plugin config `projectPath`
 *   3. workspace auto-discovery (see discoverProject)
 *   4. nothing → throw, carrying what was scanned
 *
 * It throws instead of returning an empty path on purpose: a silent default is
 * how a panel ends up painting "0 projects" and nobody knows why.
 */
export function pathsOf(config = {}, env = process.env) {
  const dshHome = expandHome(env.DSH_HOME) || join(homedir(), '.dsh')
  const statePath = resolve(
    expandHome(env.DWP_STATE_PATH) || expandHome(config.statePath) || join(dshHome, 'bot', 'state.json'),
  )
  const discovery = discoverProject(dshHome)
  const explicit = expandHome(env.DWP_PROJECT_PATH) || expandHome(config.projectPath)
  if (!explicit && discovery.picked === null) {
    const error = new Error(`未找到项目文件：已扫描 ${discovery.root}（${discovery.scanned.length} 个候选），请在插件配置里填 projectPath`)
    error.scannedRoot = discovery.root
    error.scannedCount = discovery.scanned.length
    throw error
  }
  const projectPath = resolve(explicit || discovery.picked)
  const ledgerDir = resolve(
    expandHome(env.DWP_LEDGER_DIR) || expandHome(config.ledgerDir) || join(dirname(projectPath), 'ledger'),
  )
  return { statePath, projectPath, ledgerDir, discovery }
}

const readIsStale = readAt => readAt > 0 && Date.now() - readAt > READ_STALE_MS

// state.json is written non-atomically by another process, so a read can land
// mid-write. One short retry keeps that from being reported as a broken file.
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function readJson(path) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { value: JSON.parse(await readFile(path, 'utf8')) }
    } catch (error) {
      lastError = error
      if (error?.code === 'ENOENT') return { missing: true }
      if (attempt === 0) await sleep(12)
    }
  }
  return { broken: true, reason: String(lastError?.message ?? lastError) }
}

/**
 * Ledger presence, in the three states the org view needs. They are three
 * different management situations (this agent is working but not accounting /
 * the ledger exists and nobody wrote / this person was never wired in) and must
 * never collapse into "no data".
 */
async function ledgerState(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', label: '未建立', files: 0, lastUpdatedAt: null }
    return { state: 'error', label: '不可读', files: 0, lastUpdatedAt: null, reason: String(error?.message ?? error) }
  }
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
  if (files.length === 0) return { state: 'empty', label: '空账本', files: 0, lastUpdatedAt: null }
  let newest = 0
  for (const entry of files) {
    try {
      newest = Math.max(newest, (await stat(join(dir, entry.name))).mtimeMs)
    } catch { /* a file that vanished mid-listing is not new evidence */ }
  }
  return { state: 'present', label: '有记录', files: files.length, lastUpdatedAt: newest || null }
}

// Resolution happens on first use, not at apply(): a plugin that throws while
// being mounted is a plugin the host drops, and the contract says an unresolvable
// source is a 503 WITH A REASON the panel can print. Memoised so a throw is not
// re-thrown from a half-initialised state on every poll.
function lazyPaths(config) {
  let resolved = null
  let failure = null
  return () => {
    if (resolved !== null) return resolved
    if (failure !== null) throw failure
    try {
      resolved = pathsOf(config)
      return resolved
    } catch (error) {
      failure = error
      throw error
    }
  }
}

function createSnapshotter(config = {}) {
  const getPaths = lazyPaths(config)
  // `readAt` rides in the cache on purpose: a cache hit means the files did not
  // change, which is exactly when the age of the last real read must be kept.
  let cache = { key: '', data: null, readAt: 0 }

  return async function snapshot() {
    const resolved = getPaths()
    // `paths` is part of the frozen contract: exactly three absolute path strings.
    // Discovery is diagnostics, not a path, so it travels BESIDE paths — that also
    // keeps it available when projectPath itself is missing or unusable.
    const paths = { statePath: resolved.statePath, projectPath: resolved.projectPath, ledgerDir: resolved.ledgerDir }
    const discovery = resolved.discovery
    const stateInfo = await stat(paths.statePath).catch(() => null)
    const projectInfo = await stat(paths.projectPath).catch(() => null)
    const key = [
      stateInfo ? `${stateInfo.mtimeMs}:${stateInfo.size}` : 'no-state',
      projectInfo ? `${projectInfo.mtimeMs}:${projectInfo.size}` : 'no-project',
    ].join('|')

    if (cache.data && cache.key === key) {
      return {
        ...cache.data,
        generatedAt: Date.now(),
        readAt: cache.readAt,
        stale: readIsStale(cache.readAt),
      }
    }

    if (!projectInfo) {
      return {
        ok: false,
        reason: `项目文件不存在：${paths.projectPath}`,
        paths,
        discovery,
        loadedAt: LOADED_AT,
        generatedAt: Date.now(),
        readAt: 0,
        stale: true,
      }
    }

    const projectRead = await readJson(paths.projectPath)
    if (projectRead.missing || projectRead.broken) {
      return {
        ok: false,
        reason: projectRead.missing ? '项目文件不存在' : `项目文件不可读：${projectRead.reason}`,
        paths,
        discovery,
        loadedAt: LOADED_AT,
        generatedAt: Date.now(),
        readAt: 0,
        stale: true,
      }
    }

    // A missing live layer is a supported state, not an error: the project half
    // still renders and the response says why the live half is absent.
    const stateRead = stateInfo ? await readJson(paths.statePath) : { missing: true }
    const liveStatus = stateRead.missing || stateRead.broken ? 'unavailable' : 'ok'
    const readAt = Date.now()

    const snapshot = buildSnapshot(projectRead.value, liveStatus === 'ok' ? stateRead.value : null, {
      liveStatus,
      readAt,
      stale: false,
    })
    const ledger = await ledgerState(paths.ledgerDir)
    const data = {
      ...snapshot,
      ok: true,
      plugin: { name, version: PLUGIN_VERSION },
      loadedAt: LOADED_AT,
      generatedAt: Date.now(),
      readAt,
      liveStatus,
      stale: false,
      paths,
      discovery,
      ledger,
    }
    cache = { key, data, readAt }
    return data
  }
}

const DOC_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const docJson = (status, body) => new Response(JSON.stringify(body), { status, headers: DOC_HEADERS })
const docError = (status, reason) => docJson(status, { ok: false, reason })

/**
 * Resolve one requested doc path against the project root, or explain why not.
 * Pure + exported so the boundary rules can be tested without HTTP.
 *
 * Order is deliberate: every syntactic rejection happens before any filesystem
 * call, so a hostile path is never even stat'ed outside the project. The final
 * containment test uses `path.relative` rather than startsWith, because Windows
 * paths are case-insensitive and a startsWith check would be wrong when the root
 * is spelled with different case.
 */
export function resolveDocPath(root, requested) {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  if (!raw) return { status: 400, reason: '缺少 path 参数' }
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return { status: 400, reason: 'path 参数不是合法的 URL 编码' }
  }
  if (!decoded.trim()) return { status: 400, reason: '缺少 path 参数' }
  // 绝对路径 / 盘符 / UNC：一律拒绝，不让它们走到 resolve。
  if (isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded) || decoded.startsWith('\\') || decoded.startsWith('//')) {
    return { status: 403, reason: '路径必须是项目内的相对路径' }
  }
  // 任何一段是 .. 就拒绝（不是字符串包含判断，避免把 a..b.md 这种正常文件名误杀）。
  if (decoded.split(/[\\/]+/).some(segment => segment === '..')) {
    return { status: 403, reason: '路径不许包含 ..' }
  }
  const absolute = resolve(root, decoded)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { status: 403, reason: '路径越出项目根目录' }
  }
  const ext = extname(absolute).toLowerCase()
  if (!DOC_EXTENSIONS.has(ext)) {
    return { status: 403, reason: `只允许 ${[...DOC_EXTENSIONS].join(' / ')} 文件` }
  }
  return { status: 200, absolute, relativePath: rel.split(/[\\/]+/).join('/') }
}

/**
 * One reader per mounted plugin. Returns a Response so the route body stays a
 * single expression, and every failure carries a human reason (the browser half
 * has nothing but the status code to show otherwise).
 */
function createDocReader(config = {}) {
  const getPaths = lazyPaths(config)
  // root 的 realpath 只算一次（懒加载并缓存）：项目根本身可能就是一串 junction，
  // 每次请求都解析一遍纯属浪费。解析失败就退回字面根——那不会放宽校验，只会让
  // 后面的比较更严格。
  let rootReal = null
  const realRoot = async projectRoot => (rootReal ??= await realpath(projectRoot).catch(() => projectRoot))

  return async function readDoc(request) {
    // Resolved lazily per reader: when no project can be found at all this throws,
    // and the route turns it into a 503 carrying the scan summary (never a blank 500).
    const projectRoot = dirname(getPaths().projectPath)
    const requested = new URL(request.url).searchParams.get('path')
    const target = resolveDocPath(projectRoot, requested)
    if (target.status !== 200) return docError(target.status, target.reason)

    // 字面包含校验挡不住符号链接：本项目自己就是靠 junction 挂进 profile 的，
    // 说明这台机器上 junction 是常态，所以「只能读项目内」必须在 realpath 之后再判一次。
    let realTarget
    try {
      realTarget = await realpath(target.absolute)
    } catch (error) {
      const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      return docError(missing ? 404 : 500, missing ? '文件不存在' : `文件不可读：${String(error?.message ?? error)}`)
    }
    const root = await realRoot(projectRoot)
    const relReal = relative(root, realTarget)
    if (!relReal || relReal.startsWith('..') || isAbsolute(relReal)) {
      return docError(403, '路径经符号链接指向项目外')
    }

    let info
    try {
      info = await stat(realTarget)
    } catch (error) {
      const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      return docError(missing ? 404 : 500, missing ? '文件不存在' : `文件不可读：${String(error?.message ?? error)}`)
    }
    // A directory (or a device) is not a document; 404 keeps it indistinguishable
    // from "no such file", which is what the caller actually needs to know.
    if (!info.isFile()) return docError(404, '不是普通文件')
    if (info.size > DOC_MAX_BYTES) {
      return docError(413, `文件 ${info.size} 字节，超过上限 ${DOC_MAX_BYTES} 字节`)
    }

    let content
    try {
      // 读的是 realTarget，不是字面路径：两处路径不一致时以校验通过的那个为准。
      content = await readFile(realTarget, 'utf8')
    } catch (error) {
      return docError(500, `文件读取失败：${String(error?.message ?? error)}`)
    }
    return docJson(200, { ok: true, path: target.relativePath, bytes: info.size, content })
  }
}

export function apply(ctx, config = {}) {
  const warn = (message, ...args) => {
    try { ctx.logger?.warn?.(message, ...args) } catch { /* logging must never break the route */ }
  }
  const snapshot = createSnapshotter(config)

  const registerRoute = host => {
    if (!host?.connection?.fetch?.register) {
      warn('workflow-panel: connection.fetch is unavailable; %s was not registered', ROUTE)
      return
    }
    host.effect(() => host.connection.fetch.register({
      path: ROUTE,
      // GET only. Read-only is proven by the registration, not by a promise:
      // the host returns 404 for any method a route did not claim (verified in
      // dsh-client-connection/lib/index.js:829-835), so a POST here cannot reach
      // a handler even if someone adds one later.
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const body = await snapshot()
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        } catch (error) {
          // Never a blank 500: the browser half can only say "HTTP 500", which
          // tells the reader nothing. The reason travels in the body instead.
          warn('workflow-panel: snapshot failed: %s', String(error?.message ?? error))
          return new Response(JSON.stringify({
            ok: false,
            reason: `快照构建失败：${String(error?.message ?? error)}`,
            // 前端已经会读它并显示「扫描根目录：…」——四级解析全落空时，用户需要
            // 知道到底扫了哪里才判断得出该往配置里填什么路径。
            scannedRoot: error?.scannedRoot ?? null,
            loadedAt: LOADED_AT,
            generatedAt: Date.now(),
          }), {
            status: 503,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
      },
    }), 'workflow-panel: snapshot route')
  }

  registerRoute(ctx)

  // 文档原文路由：同样是精确 GET 路由、同样只读。拒绝逻辑全在 resolveDocPath 里，
  // 这里只负责兜住意外异常——绝不让一个读文件失败变成空白 500。
  const registerDocRoute = host => {
    if (!host?.connection?.fetch?.register) {
      warn('workflow-panel: connection.fetch is unavailable; %s was not registered', DOC_ROUTE)
      return
    }
    const readDoc = createDocReader(config)
    host.effect(() => host.connection.fetch.register({
      path: DOC_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        try {
          return await readDoc(request)
        } catch (error) {
          warn('workflow-panel: doc read failed: %s', String(error?.message ?? error))
          return docError(503, `文档读取失败：${String(error?.message ?? error)}`)
        }
      },
    }), 'workflow-panel: doc route')
  }

  registerDocRoute(ctx)
}
