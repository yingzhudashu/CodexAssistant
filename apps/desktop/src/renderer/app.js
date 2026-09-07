const root = document.querySelector('#app');
const state = { tasks: [], connection: null, syncStatus: 'connecting', error: '', lastSync: null, selected: null, filter: 'all' };
const labels = { active: '进行中', paused: '已暂停', blocked: '已阻塞', usage_limited: '用量受限', budget_limited: '预算受限', waiting: '等待中', idle: '空闲', complete: '已完成', failed: '失败' };
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  const active = state.tasks.filter((task) => ['active', 'waiting', 'blocked', 'paused'].includes(task.status));
  const visible = state.filter === 'all' ? state.tasks : state.tasks.filter((task) => task.status === state.filter);
  const connectionLabel = !state.connection?.configured ? '未配置' : ({ connecting: '连接中', syncing: '同步中', connected: '已连接', offline: '离线' }[state.syncStatus] || '未知状态');
  root.innerHTML = `<main><header><div><div class="eyebrow">LOCAL CODEX MONITOR</div><h1>CodexAssistant</h1><div class="muted">${active.length} 个进行中 · ${state.tasks.length} 个任务</div></div><span class="connection ${state.syncStatus === 'connected' ? 'online' : 'offline'}"><i></i>${connectionLabel}</span></header>
    ${state.connection?.configured ? '' : `<form id="connect"><input name="apiUrl" placeholder="https://server.example.com" required><input name="token" type="password" placeholder="访问 Token" required><button>连接</button></form>`}
    ${state.error ? `<div class="error">${escape(state.error)}</div>` : ''}
    <nav class="filters">${['all','active','waiting','blocked','complete','failed'].map((value) => `<button class="filter ${state.filter === value ? 'selected' : ''}" data-filter="${value}">${value === 'all' ? '全部' : labels[value]}</button>`).join('')}</nav>
    <div class="section-title">任务列表</div>${renderTasks(visible)}
    ${state.selected ? renderDetail(state.selected) : ''}
    <footer class="muted">${state.lastSync ? `最后同步 ${new Date(state.lastSync).toLocaleTimeString()}` : '等待首次同步'}</footer></main>`;
  document.querySelector('#connect')?.addEventListener('submit', async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { await window.codexAssistant.saveConnection({ apiUrl: data.get('apiUrl'), token: data.get('token') }); state.connection = await window.codexAssistant.getConnection(); state.error = ''; render(); } catch (error) { state.error = error.message; render(); } });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; render(); }));
  document.querySelectorAll('[data-task-id]').forEach((card) => card.addEventListener('click', () => { state.selected = state.tasks.find((task) => task.id === card.dataset.taskId) || null; render(); }));
  document.querySelector('[data-close]')?.addEventListener('click', () => { state.selected = null; render(); });
}

function renderTasks(tasks) {
  return tasks.length ? tasks.map((task) => {
    const step = task.plan.find((item) => item.id === task.currentStepId);
    const done = task.plan.filter((item) => item.status === 'completed').length;
    const progress = task.plan.length ? Math.round(done / task.plan.length * 100) : 0;
    return `<article class="task" data-task-id="${escape(task.id)}"><div class="task-title">${escape(task.title)}</div><div class="meta"><span class="status status-${escape(task.status)}">${labels[task.status] || escape(task.status)}</span><span>${escape(task.runtimeStatus)}</span><span>${task.freshness === 'fresh' ? '实时' : '缓存'}</span></div>${task.plan.length ? `<div class="progress"><i style="width:${progress}%"></i></div>` : ''}${step ? `<div class="step">${escape(step.title)}</div>` : ''}<div class="task-time">${new Date(task.updatedAt).toLocaleTimeString()}</div></article>`;
  }).join('') : '<div class="empty">暂无任务</div>';
}

function renderDetail(task) {
  const turn = task.latestTurn;
  return `<aside class="detail"><button class="close" data-close>关闭</button><div class="eyebrow">TASK DETAIL</div><h2>${escape(task.title)}</h2><p class="detail-status">${labels[task.status] || escape(task.status)} · 线程 ${escape(task.runtimeStatus)}</p>${task.goal ? `<p>${escape(task.goal.objective)}</p><p class="muted">Token ${task.goal.tokensUsed}${task.goal.tokenBudget ? `/${task.goal.tokenBudget}` : ''} · ${task.goal.timeUsedSeconds}s</p>` : ''}${turn ? `<p class="muted">最近回合：${escape(turn.status)}${turn.durationMs ? ` · ${turn.durationMs}ms` : ''}</p>` : ''}${task.error ? `<div class="error">${escape(task.error.message)}</div>` : ''}<div class="detail-plan">${task.plan.map((step) => `<div>${step.status === 'completed' ? '✓' : '•'} ${escape(step.title)}</div>`).join('')}</div></aside>`;
}

async function boot() {
  try {
    if (!window.codexAssistant) throw new Error('桌面桥接未加载，请重启 CodexAssistant');
    state.connection = await window.codexAssistant.getConnection();
    state.tasks = await window.codexAssistant.getTasks();
    state.syncStatus = await window.codexAssistant.getSyncStatus();
    window.codexAssistant.onTasks((tasks) => { state.tasks = tasks; state.lastSync = Date.now(); render(); });
    window.codexAssistant.onSyncStatus((status) => { state.syncStatus = status; render(); });
  } catch (error) { state.connection = { configured: false }; state.error = error instanceof Error ? error.message : '桌面端初始化失败'; }
  render();
}
void boot();
