'use strict'

/**
 * 电源定时 · preload 桥接层
 * 负责：跨平台电源命令构建、后台定时任务登记、到点执行、提醒与状态持久化。
 * 渲染层只做展示与交互，不直接接触 child_process。
 */

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PLATFORM = process.platform
// 旧版本把任务存在同步数据库里，此键仅用于一次性迁移
const LEGACY_STORAGE_KEY = 'powerTimer.task'
// 任务属于设备本地状态，按数据存储规范存放在插件应用本地数据目录，不参与 uTools 数据同步
const TASK_FILE = 'power-timer-task.json'
const SCHEDULE_PREFIX = 'power_timer_'
const FEATURE_CODE = 'power-timer'

// 到期后允许的迟到窗口：超过则视为错过，不再自动执行（避免打开插件时突然关机）
const GRACE_MS = 2 * 60 * 1000
const MIN_AHEAD_MS = 5 * 1000
const MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000

const ACTIONS = {
  shutdown: { label: '关机' },
  restart: { label: '重启' },
  sleep: { label: '睡眠' }
}

const ENV = {
  win32: {
    platformName: 'Windows 10 / 11',
    permission:
      '普通用户即可执行关机、重启；睡眠通过 powrprof.dll 的 SetSuspendState 触发，若系统已启用休眠，可能进入休眠而非睡眠。域策略、远程桌面会话或缺少「关闭系统」权限时会被系统拒绝。',
    reliability: 'uTools 需保持运行（托盘常驻），退出 uTools 后定时任务不会触发；提前提醒由插件进程发出，进程被彻底结束后可能收不到提醒，但到点执行仍由 uTools 唤醒。'
  },
  darwin: {
    platformName: 'macOS 12 及以上',
    permission:
      '首次执行会弹出「自动化」授权请求，需在 系统设置 → 隐私与安全性 → 自动化 中允许 uTools 控制 System Events；未授权、锁屏或受管理设备策略限制时可能失败。',
    reliability: 'uTools 需保持运行（托盘常驻），退出 uTools 后定时任务不会触发；提前提醒由插件进程发出，进程被彻底结束后可能收不到提醒，但到点执行仍由 uTools 唤醒。'
  },
  linux: {
    platformName: 'Linux（systemd）',
    permission:
      '关机、重启、睡眠通过 systemctl 交给 systemd-logind / Polkit 处理，需要本地活动会话。无图形会话、仅 SSH 会话或 Polkit 策略收紧时，可能要求认证或直接失败。',
    reliability: 'uTools 需保持运行（托盘常驻），退出 uTools 后定时任务不会触发；提前提醒由插件进程发出，进程被彻底结束后可能收不到提醒，但到点执行仍由 uTools 唤醒。'
  }
}

const ENV_INFO = ENV[PLATFORM] || {
  platformName: PLATFORM,
  permission: '当前系统不在已验证范围内，命令可能不可用。',
  reliability: 'uTools 需保持运行，退出后定时任务不会触发。'
}

let memoryTask = null

let timerRun = null
let timerLead = null
let timerFinal = null
let executing = false
let lastResult = null

const listeners = new Set()

/* ------------------------------ 命令构建 ------------------------------ */

function buildCommand(action, options) {
  const force = !!(options && options.force)

  if (PLATFORM === 'win32') {
    if (action === 'shutdown') {
      const args = ['/s', '/t', '0']
      if (force) args.push('/f')
      return { file: 'shutdown.exe', args, note: '调用系统 shutdown.exe 立即关机' }
    }
    if (action === 'restart') {
      const args = ['/r', '/t', '0']
      if (force) args.push('/f')
      return { file: 'shutdown.exe', args, note: '调用系统 shutdown.exe 立即重启' }
    }
    return {
      file: 'rundll32.exe',
      args: ['powrprof.dll,SetSuspendState', '0,1,0'],
      note: '调用 SetSuspendState 进入睡眠（若已启用休眠，可能进入休眠）'
    }
  }

  if (PLATFORM === 'darwin') {
    const script =
      action === 'shutdown'
        ? 'tell application "System Events" to shut down'
        : action === 'restart'
          ? 'tell application "System Events" to restart'
          : 'tell application "System Events" to sleep'
    return { file: 'osascript', args: ['-e', script], note: '通过 AppleScript 驱动 System Events' }
  }

  const systemctlAction = { shutdown: 'poweroff', restart: 'reboot', sleep: 'suspend' }[action]
  return { file: 'systemctl', args: [systemctlAction], note: '通过 systemd-logind / Polkit 执行' }
}

function quoteArg(arg) {
  if (!/[\s"']/.test(arg)) return arg
  if (arg.indexOf("'") === -1) return `'${arg}'`
  return `"${arg.replace(/"/g, '\\"')}"`
}

function commandText(cmd) {
  return [cmd.file, ...cmd.args.map(quoteArg)].join(' ')
}

function buildPreviews(force) {
  const previews = {}
  Object.keys(ACTIONS).forEach((action) => {
    const cmd = buildCommand(action, { force })
    previews[action] = { command: commandText(cmd), note: cmd.note }
  })
  return previews
}

/* ------------------------------ 任务存取 ------------------------------ */

function taskFilePath() {
  return path.join(utools.getPluginLocalDataPath(), TASK_FILE)
}

function readTaskFile() {
  try {
    const task = JSON.parse(fs.readFileSync(taskFilePath(), 'utf8'))
    return task && typeof task === 'object' ? task : null
  } catch (error) {
    return null
  }
}

function writeTaskFile(task) {
  try {
    const file = taskFilePath()
    if (task) fs.writeFileSync(file, JSON.stringify(task), 'utf8')
    else if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (error) {
    // 本地存储异常不应中断主流程
  }
}

// 迁移旧版本写在同步数据库里的任务，迁移后删除该键，避免它继续同步到其他设备
function migrateLegacyTask() {
  let legacy = null
  try {
    legacy = utools.dbStorage.getItem(LEGACY_STORAGE_KEY) || null
  } catch (error) {
    return null
  }
  if (!legacy) return null
  try {
    utools.dbStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch (error) {
    // 删除失败不影响本次迁移
  }
  writeTaskFile(legacy)
  return legacy
}

function loadTask() {
  memoryTask = readTaskFile() || migrateLegacyTask()
  return memoryTask
}

function readTask() {
  return memoryTask
}

// 安排、取消、执行等关键写入必须同步落盘：写入延迟会让已取消的任务在下次启动时复活
function persistNow(task) {
  memoryTask = task
  writeTaskFile(task)
}

/* ------------------------------ 定时任务登记 ------------------------------ */

function scheduleCodeOf(task) {
  return task ? `${SCHEDULE_PREFIX}${task.id}` : null
}

function hasSchedule(code) {
  if (!code) return false
  try {
    return (utools.getSchedules() || []).some((item) => item.code === code)
  } catch (error) {
    return false
  }
}

function removeScheduleSafe(code) {
  if (!code) return
  try {
    utools.removeSchedule(code)
  } catch (error) {
    // 任务不存在或已被自动删除时会抛异常，忽略即可
  }
}

function cleanupOrphanSchedules(currentTask) {
  const keep = scheduleCodeOf(currentTask)
  try {
    ;(utools.getSchedules() || []).forEach((item) => {
      if (item.code && item.code.indexOf(SCHEDULE_PREFIX) === 0 && item.code !== keep) {
        removeScheduleSafe(item.code)
      }
    })
  } catch (error) {
    // getSchedules 在旧版本 uTools 中不可用时忽略
  }
}

/* ------------------------------ 时间格式 ------------------------------ */

function pad(num) {
  return String(num).padStart(2, '0')
}

function formatDateTime(timestamp) {
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function scheduleLabel(task) {
  return `${ACTIONS[task.action].label} · ${formatDateTime(task.executeAt)}`
}

/* ------------------------------ 状态聚合 ------------------------------ */

function getState() {
  const task = readTask()
  const now = Date.now()
  let status = 'idle'

  if (task) {
    if (task.missedAt) status = 'missed'
    else if (task.executeAt <= now) status = 'overdue'
    else status = 'pending'
  }

  return {
    platform: PLATFORM,
    platformName: ENV_INFO.platformName,
    permission: ENV_INFO.permission,
    reliability: ENV_INFO.reliability,
    supportsBackgroundSchedule: typeof utools.requestSchedule === 'function',
    task,
    status,
    now,
    graceMs: GRACE_MS,
    persistent: hasSchedule(scheduleCodeOf(task)),
    lastResult
  }
}

function emit(event) {
  listeners.forEach((fn) => {
    try {
      fn(event || { type: 'state' })
    } catch (error) {
      // 渲染层回调异常不应影响主流程
    }
  })
}

/* ------------------------------ 提醒与执行 ------------------------------ */

function clearTimers() {
  if (timerRun) clearTimeout(timerRun)
  if (timerLead) clearTimeout(timerLead)
  if (timerFinal) clearTimeout(timerFinal)
  timerRun = null
  timerLead = null
  timerFinal = null
}

function formatLead(seconds) {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} 小时`
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`
  return `${seconds} 秒`
}

function notify(body) {
  try {
    utools.showNotification(`【电源定时】${body}`, FEATURE_CODE)
  } catch (error) {
    // 通知失败不影响定时
  }
}

function armTimers(task) {
  clearTimers()
  if (!task) return

  const delay = task.executeAt - Date.now()
  if (delay <= 0) return

  timerRun = setTimeout(() => {
    const current = readTask()
    if (!current || current.id !== task.id) return
    runTask(current, 'timer')
  }, delay)

  const lead = Number(task.remindLead) || 0
  if (lead > 0 && delay > lead * 1000 + 1000) {
    timerLead = setTimeout(() => {
      notify(`${formatLead(lead)}后将${ACTIONS[task.action].label}，点击打开可取消`)
    }, delay - lead * 1000)
  }

  if (delay > 12 * 1000) {
    timerFinal = setTimeout(() => {
      notify(`10 秒后将${ACTIONS[task.action].label}，点击打开可取消`)
    }, delay - 10 * 1000)
  }
}

function finishTask(task, result) {
  executing = false
  clearTimers()
  removeScheduleSafe(scheduleCodeOf(task))
  persistNow(null)
  lastResult = {
    action: task ? task.action : null,
    ok: !!result.ok,
    message: result.message,
    at: Date.now()
  }
  emit({ type: 'executed', result: lastResult })
  return lastResult
}

function markMissed(task, reason) {
  executing = false
  clearTimers()
  removeScheduleSafe(scheduleCodeOf(task))
  persistNow(Object.assign({}, task, { missedAt: Date.now(), missedReason: reason }))
  notify(`任务已错过，未执行：${reason}`)
  emit({ type: 'state' })
}

function runTask(task, source) {
  if (!task || executing) return Promise.resolve(null)
  if (task.missedAt && source !== 'manual') return Promise.resolve(null)

  const late = Date.now() - task.executeAt
  if (source !== 'manual' && late > GRACE_MS) {
    markMissed(task, '超过允许的迟到窗口')
    return Promise.resolve(null)
  }

  executing = true
  clearTimers()

  // 先落盘「已触发」标记：关机后若来不及清理，下次启动可据此静默回收
  persistNow(Object.assign({}, task, { firedAt: Date.now() }))

  const command = buildCommand(task.action, { force: task.force })
  const actionLabel = ACTIONS[task.action].label

  if (task.dryRun) {
    notify(`演练模式：跳过${actionLabel}（${commandText(command)}）`)
    return Promise.resolve(finishTask(task, { ok: true, message: '演练模式，未真正执行' }))
  }

  notify(`正在执行${actionLabel}…`)

  // 返回执行结果，供 onScheduleTrigger 把成功/失败如实回传给 uTools
  return new Promise((resolve) => {
    const onDone = (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim().slice(0, 120)
        notify(`${actionLabel}失败：${detail}`)
        resolve(finishTask(task, { ok: false, message: detail || '命令执行失败' }))
        return
      }
      resolve(finishTask(task, { ok: true, message: '系统指令已发送' }))
    }

    try {
      execFile(command.file, command.args, { windowsHide: true, timeout: 15000 }, onDone)
    } catch (error) {
      onDone(error)
    }
  })
}

/* ------------------------------ 对外接口 ------------------------------ */

async function arrange(config) {
  const action = config && config.action
  if (!ACTIONS[action]) throw new Error('未知的电源操作')

  const now = Date.now()
  const executeAt = Number(config.executeAt)
  if (!Number.isFinite(executeAt)) throw new Error('执行时间无效')
  if (executeAt - now < MIN_AHEAD_MS) throw new Error('执行时间需在当前时间 5 秒之后')
  if (executeAt - now > MAX_AHEAD_MS) throw new Error('最多只支持 7 天内的任务')

  const previous = readTask()
  const task = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    action,
    executeAt,
    createdAt: now,
    remindLead: Math.min(Math.max(Number(config.remindLead) || 0, 0), 3600),
    force: !!config.force,
    dryRun: !!config.dryRun
  }

  clearTimers()
  persistNow(task)

  // 先武装本机计时器：后台定时授权需要用户确认，耗时不可控，
  // 若等授权结束再武装，短倒计时任务会卡在「已到期」而永不执行
  armTimers(task)

  if (typeof utools.requestSchedule === 'function') {
    try {
      await utools.requestSchedule({
        code: scheduleCodeOf(task),
        label: scheduleLabel(task),
        trigger: executeAt
      })
    } catch (error) {
      // 用户拒绝授权时任务仍保留，只是仅在 uTools 运行期间有效
    }

    // 授权期间任务可能已执行、被取消或被替换，刚登记的后台定时已无意义
    const current = readTask()
    if (!current || current.id !== task.id) removeScheduleSafe(scheduleCodeOf(task))
  }

  if (previous && previous.id !== task.id) {
    removeScheduleSafe(scheduleCodeOf(previous))
  }

  emit({ type: 'state' })
  return getState()
}

function cancel() {
  const task = readTask()
  clearTimers()
  removeScheduleSafe(scheduleCodeOf(task))
  // 同步落盘：否则在写入前进程结束，会让已取消的任务在下次启动时复活并执行
  persistNow(null)
  lastResult = null
  emit({ type: 'state' })
  return getState()
}

function executeOverdue() {
  const task = readTask()
  if (!task) return getState()
  runTask(task, 'manual')
  return getState()
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* ------------------------------ 启动初始化 ------------------------------ */

function bootstrap() {
  const task = loadTask()
  cleanupOrphanSchedules(task)
  if (!task) return

  // 上次已发出指令但没来得及清理（关机/重启），静默回收
  if (task.firedAt) {
    removeScheduleSafe(scheduleCodeOf(task))
    persistNow(null)
    return
  }

  if (task.executeAt > Date.now()) {
    armTimers(task)
  }
  // 已到期的任务不自动执行：等待 uTools 定时任务触发，或由用户手动确认
}

if (typeof utools.onScheduleTrigger === 'function') {
  utools.onScheduleTrigger((action) => {
    const code = action && action.code
    if (!code || code.indexOf(SCHEDULE_PREFIX) !== 0) return
    const task = readTask()
    if (!task || scheduleCodeOf(task) !== code) return
    // uTools 依据回调是否抛错记录任务成功/失败，必须等命令结果再返回
    return runTask(task, 'schedule').then((result) => {
      if (result && !result.ok) throw new Error(result.message || '电源指令执行失败')
    })
  })
}

bootstrap()

window.powerAPI = {
  getState,
  getPreviews: (force) => buildPreviews(!!force),
  arrange,
  cancel,
  executeOverdue,
  subscribe
}
