'use strict'

;(function () {
  const $ = (id) => document.getElementById(id)

  const ACTION_META = {
    shutdown: {
      label: '关机',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v8.5"/><path d="M6.5 6.6a8 8 0 1 0 11 0"/></svg>'
    },
    restart: {
      label: '重启',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V10h-5.4"/></svg>'
    },
    sleep: {
      label: '睡眠',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.8A8.5 8.5 0 0 1 9.2 3.5a8.5 8.5 0 1 0 11.3 11.3z"/></svg>'
    }
  }

  if (!window.powerAPI) {
    document.body.innerHTML = '<p style="padding:24px;font-size:13px">preload 未加载，请检查 plugin.json 中的 preload 配置。</p>'
    return
  }

  const app = $('app')
  const taskCard = $('taskCard')
  const btnEdit = $('btnEdit')
  const btnCancel = $('btnCancel')
  const btnSubmit = $('btnSubmit')
  const formHint = $('formHint')
  const editBanner = $('editBanner')

  const form = {
    action: 'shutdown',
    mode: 'countdown',
    remindLead: 300,
    force: false,
    dryRun: false
  }

  let view = window.powerAPI.getState()
  let editing = false
  let confirmExecute = false
  let confirmTimer = null
  let toastTimer = null

  /* ------------------------------ 工具函数 ------------------------------ */

  function pad(num) {
    return String(num).padStart(2, '0')
  }

  function toLocalInput(timestamp) {
    const date = new Date(timestamp)
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function fmtDateTime(timestamp) {
    const date = new Date(timestamp)
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const dayDiff = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - startOfToday) / 86400000)
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
    if (dayDiff === 0) return `今天 ${clock}`
    if (dayDiff === 1) return `明天 ${clock}`
    if (dayDiff === 2) return `后天 ${clock}`
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    if (hours >= 24) return `${Math.floor(hours / 24)}天 ${pad(hours % 24)}:${pad(minutes)}:${pad(seconds)}`
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  }

  function fmtLead(seconds) {
    if (!seconds) return '无提前提醒'
    if (seconds >= 3600) return `提前 ${Math.round(seconds / 3600)} 小时提醒`
    if (seconds >= 60) return `提前 ${Math.round(seconds / 60)} 分钟提醒`
    return `提前 ${seconds} 秒提醒`
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  }

  function toast(message, type) {
    const el = $('toast')
    el.textContent = message
    el.className = 'toast' + (type ? ` ${type}` : '')
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.hidden = true
    }, 2800)
  }

  /* ------------------------------ 表单计算 ------------------------------ */

  function computeExecuteAt() {
    if (form.mode === 'countdown') {
      const raw = Number($('delayValue').value)
      if (!Number.isFinite(raw) || raw <= 0) return NaN
      const unit = $('delayUnit').value
      return Date.now() + raw * (unit === 'hour' ? 3600000 : 60000)
    }
    const value = $('datetime').value
    if (!value) return NaN
    const timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : NaN
  }

  function forceActive() {
    return view.platform === 'win32' && form.action !== 'sleep' && form.force
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function buildActions() {
    $('actionGroup').innerHTML = Object.keys(ACTION_META)
      .map(
        (key) =>
          `<button type="button" data-action="${key}" aria-pressed="false">${ACTION_META[key].icon}<span>${ACTION_META[key].label}</span></button>`
      )
      .join('')
  }

  function render() {
    app.dataset.action = form.action
    renderPlatform()
    renderTask()
    renderActions()
    renderMode()
    renderOptions()
    renderChips()
    renderPreview()
    renderEnv()
    renderSubmit()
    editBanner.hidden = !editing
  }

  function renderPlatform() {
    $('platformPill').textContent = view.platformName
    $('envPlatform').textContent = view.platformName
    $('envPermission').textContent = view.permission
    $('envReliability').textContent = view.reliability
  }

  function renderActions() {
    document.querySelectorAll('#actionGroup button').forEach((btn) => {
      const active = btn.dataset.action === form.action
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    })
  }

  function renderMode() {
    document.querySelectorAll('#modeTabs button').forEach((btn) => {
      const active = btn.dataset.mode === form.mode
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-selected', String(active))
    })
    $('countdownPanel').hidden = form.mode !== 'countdown'
    $('absolutePanel').hidden = form.mode !== 'absolute'
  }

  function renderOptions() {
    $('forceOpt').hidden = !(view.platform === 'win32' && form.action !== 'sleep')
    $('force').checked = form.force
    $('dryRun').checked = form.dryRun
    $('remindLead').value = String(form.remindLead)
  }

  function renderChips() {
    const value = Number($('delayValue').value)
    const unit = $('delayUnit').value
    const minutes = unit === 'hour' ? value * 60 : value
    document.querySelectorAll('#delayChips button').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.min) === minutes)
    })
  }

  function renderPreview() {
    const executeAt = computeExecuteAt()
    const valid = Number.isFinite(executeAt) && executeAt > Date.now() + 5000
    const tooFar = valid && executeAt - Date.now() > 7 * 86400000
    const text = !Number.isFinite(executeAt) ? '请输入有效时间' : tooFar ? '超出 7 天上限' : valid ? `预计 ${fmtDateTime(executeAt)} 执行` : '时间需晚于当前 5 秒'
    $('countdownPreview').textContent = text
    $('absolutePreview').textContent = text
  }

  function renderSubmit() {
    btnSubmit.textContent = editing ? '保存修改' : '安排任务'
    const hints = []
    if (editing) {
      hints.push('保存后将替换原任务，旧的后台定时会一并移除。')
    } else if (view.task) {
      hints.push('安排新任务会替换当前任务。')
    } else {
      hints.push('任务会登记到 uTools 定时任务，关闭插件界面后依然有效。')
    }
    if (form.dryRun) hints.push('演练模式下到点只弹提醒，不真正执行。')
    if (!view.supportsBackgroundSchedule) hints.push('当前 uTools 版本不支持后台定时任务，仅在插件运行期间有效。')
    formHint.textContent = hints.join(' ')
    formHint.classList.toggle('warn', !view.supportsBackgroundSchedule)
  }

  function renderEnv() {
    const previews = window.powerAPI.getPreviews(forceActive())
    $('envCommands').innerHTML = Object.keys(ACTION_META)
      .map(
        (key) =>
          `<div class="env-cmd"><span>${ACTION_META[key].label}</span><code title="${escapeHtml(previews[key].note)}">${escapeHtml(previews[key].command)}</code></div>`
      )
      .join('')
  }

  function renderTask() {
    const task = view.task
    if (!task) {
      taskCard.hidden = true
      return
    }

    taskCard.hidden = false
    taskCard.dataset.action = task.action
    $('taskBadge').textContent = ACTION_META[task.action].label
    $('taskTime').textContent = `${fmtDateTime(task.executeAt)} 执行`

    const note = $('taskNote')
    note.classList.remove('warn')

    if (view.status === 'pending') {
      btnEdit.textContent = '修改'
      btnCancel.textContent = '取消任务'
      if (!view.persistent) {
        note.textContent = '未获得后台定时授权，任务仅在 uTools 与插件运行期间有效。'
        note.classList.add('warn')
      } else if (task.dryRun) {
        note.textContent = '演练模式：到点只弹提醒，不真正执行。'
      } else {
        note.textContent = '已登记到 uTools 定时任务，关闭界面后仍会执行；随时可取消。'
      }
      $('taskCount').textContent = fmtClock(task.executeAt - Date.now())
      $('taskSub').textContent = fmtLead(task.remindLead)
    } else if (view.status === 'overdue') {
      btnEdit.textContent = confirmExecute ? '确认立即执行' : '立即执行'
      btnCancel.textContent = '放弃任务'
      note.textContent = '已到预定时间但尚未执行（可能当时 uTools 未运行），可立即执行或放弃。'
      note.classList.add('warn')
      $('taskCount').textContent = '已到期'
      $('taskSub').textContent = '等待处理'
    } else {
      btnEdit.textContent = confirmExecute ? '确认立即执行' : '立即执行'
      btnCancel.textContent = '移除记录'
      note.textContent = `已错过预定时间，未执行${task.missedReason ? `（${task.missedReason}）` : ''}。`
      note.classList.add('warn')
      $('taskCount').textContent = '已错过'
      $('taskSub').textContent = '未执行'
    }

    updateProgress()
  }

  function updateProgress() {
    const task = view.task
    if (!task) return
    const bar = $('taskProgress')
    if (view.status !== 'pending') {
      bar.style.width = '100%'
      return
    }
    const total = Math.max(1, task.executeAt - task.createdAt)
    const remaining = Math.max(0, task.executeAt - Date.now())
    bar.style.width = `${Math.min(100, Math.max(0, ((total - remaining) / total) * 100))}%`
  }

  function tick() {
    if (!view.task || view.status !== 'pending') return
    const remaining = view.task.executeAt - Date.now()
    if (remaining <= 0) {
      $('taskCount').textContent = '执行中'
      $('taskSub').textContent = '正在执行…'
      $('taskProgress').style.width = '100%'
      return
    }
    $('taskCount').textContent = fmtClock(remaining)
    updateProgress()
    if (form.mode === 'countdown') renderPreview()
  }

  /* ------------------------------ 交互 ------------------------------ */

  function startEdit() {
    const task = view.task
    if (!task) return
    editing = true
    form.action = task.action
    form.mode = 'absolute'
    form.remindLead = task.remindLead
    form.force = !!task.force
    form.dryRun = !!task.dryRun
    $('datetime').value = toLocalInput(task.executeAt)
    resetConfirmState()
    render()
  }

  function resetConfirmState() {
    confirmExecute = false
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = null
  }

  async function submit() {
    const executeAt = computeExecuteAt()
    if (!Number.isFinite(executeAt)) {
      toast('请选择有效的执行时间', 'error')
      return
    }
    if (executeAt - Date.now() < 5000) {
      toast('执行时间需在当前时间 5 秒之后', 'error')
      return
    }
    if (executeAt - Date.now() > 7 * 86400000) {
      toast('最多只支持 7 天内的任务', 'error')
      return
    }

    btnSubmit.disabled = true
    try {
      view = await window.powerAPI.arrange({
        action: form.action,
        executeAt,
        remindLead: Number($('remindLead').value),
        force: forceActive(),
        dryRun: form.dryRun
      })
      editing = false
      resetConfirmState()
      render()
      setTimeout(() => {
        view = window.powerAPI.getState()
        renderTask()
        if (!view.task) return // 授权耗时已越过执行时间，任务已执行完毕
        if (view.status === 'missed') toast('任务已错过，未执行，请重新安排', 'error')
        else if (view.persistent) toast('任务已安排')
        else toast('任务已安排，但未获得后台定时授权，仅在插件运行期间有效')
      }, 400)
    } catch (error) {
      toast(error && error.message ? error.message : '安排任务失败', 'error')
    } finally {
      btnSubmit.disabled = false
    }
  }

  function handleTaskButton(kind) {
    if (kind === 'edit') {
      if (view.status === 'pending') {
        startEdit()
        return
      }
      // 已到期/已错过：二次确认后立即执行
      if (!confirmExecute) {
        confirmExecute = true
        renderTask()
        confirmTimer = setTimeout(() => {
          confirmExecute = false
          renderTask()
        }, 4000)
        return
      }
      resetConfirmState()
      view = window.powerAPI.executeOverdue()
      render()
      return
    }

    const wasPending = view.status === 'pending'
    view = window.powerAPI.cancel()
    if (view.status === 'idle') editing = false
    resetConfirmState()
    render()
    toast(wasPending ? '已取消，任务不会执行' : '记录已清除')
  }

  function applyPreset(name) {
    const now = new Date()
    let date
    if (name === 'today2300') date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0, 0, 0)
    else if (name === 'tomorrow0700') date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 7, 0, 0, 0)
    else date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)

    if (date.getTime() - Date.now() < 60000) date.setDate(date.getDate() + 1)
    $('datetime').value = toLocalInput(date.getTime())
    renderPreview()
  }

  function bindEvents() {
    $('actionGroup').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]')
      if (!btn) return
      form.action = btn.dataset.action
      if (form.action === 'sleep') form.force = false
      render()
    })

    $('modeTabs').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-mode]')
      if (!btn) return
      form.mode = btn.dataset.mode
      render()
    })

    $('delayChips').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-min]')
      if (!btn) return
      const minutes = Number(btn.dataset.min)
      if (minutes % 60 === 0) {
        $('delayUnit').value = 'hour'
        $('delayValue').value = String(minutes / 60)
      } else {
        $('delayUnit').value = 'minute'
        $('delayValue').value = String(minutes)
      }
      renderChips()
      renderPreview()
    })

    $('delayValue').addEventListener('input', () => {
      renderChips()
      renderPreview()
    })

    $('delayUnit').addEventListener('change', () => {
      renderChips()
      renderPreview()
    })

    $('datetime').addEventListener('change', renderPreview)
    $('datetime').addEventListener('input', renderPreview)

    $('timeChips').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-preset]')
      if (!btn) return
      applyPreset(btn.dataset.preset)
    })

    $('remindLead').addEventListener('change', () => {
      form.remindLead = Number($('remindLead').value)
    })

    $('force').addEventListener('change', () => {
      form.force = $('force').checked
      renderEnv()
    })

    $('dryRun').addEventListener('change', () => {
      form.dryRun = $('dryRun').checked
      renderSubmit()
    })

    btnSubmit.addEventListener('click', submit)
    btnEdit.addEventListener('click', () => handleTaskButton('edit'))
    btnCancel.addEventListener('click', () => handleTaskButton('cancel'))

    $('btnCancelEdit').addEventListener('click', () => {
      editing = false
      render()
    })

    $('composer').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
        event.preventDefault()
        submit()
      }
    })
  }

  /* ------------------------------ 启动 ------------------------------ */

  function initDatetime() {
    const now = new Date()
    now.setSeconds(0, 0)
    now.setMinutes(Math.ceil((now.getMinutes() + 1) / 5) * 5)
    $('datetime').value = toLocalInput(now.getTime() + 3600000)
  }

  buildActions()
  bindEvents()
  initDatetime()
  render()

  const unsubscribe = window.powerAPI.subscribe((event) => {
    view = window.powerAPI.getState()
    render()
    if (event && event.type === 'executed') {
      const result = event.result || {}
      if (!result.ok) {
        toast(`执行失败：${result.message}`, 'error')
      } else if (String(result.message || '').indexOf('演练') === 0) {
        toast('演练完成，未真正执行', 'ok')
      } else {
        toast('系统指令已发送', 'ok')
      }
    }
  })

  window.addEventListener('beforeunload', unsubscribe)

  setInterval(() => {
    if (view.task && view.status === 'pending') tick()
  }, 250)

  if (typeof utools !== 'undefined' && utools.onPluginEnter) {
    utools.onPluginEnter(() => {
      view = window.powerAPI.getState()
      render()
    })
  }
})()
