const root = document.querySelector("#app");
const labels = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  needs_action: "待确认",
};
const steps = {
  pending: "待开始",
  in_progress: "执行中",
  completed: "完成",
  failed: "失败",
};
const fresh = { fresh: "近期采集", stale: "上次同步", unavailable: "无法采集" };
const turns = {
  inProgress: "进行中",
  completed: "回合完成",
  interrupted: "回合中断",
  failed: "回合失败",
};
const s = {
  interactions: [],
  tasks: [],
  connection: null,
  sync: "connecting",
  ready: false,
  loaded: false,
  page: "tasks",
  selected: null,
  tab: "plan",
  detail: null,
  cursor: null,
  epoch: 0,
  loading: false,
  error: "",
  detailError: "",
  notice: "",
  lastSync: null,
  query: "",
  filter: "all",
  theme: localStorage.getItem("ca.theme") || "system",
  draft: new Map(),
  pending: new Set(),
  sent: new Map(),
  form: null,
  saving: false,
  reveal: false,
  discard: false,
  update: null,
  checking: false,
  menu: false,
};
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "long",
});
const fmt = (v) =>
  v && Number.isFinite(new Date(v).getTime())
    ? dateFormat.format(new Date(v))
    : "未提供";
const paths = {
  tasks: "M4 5h16v15H4z M8 3v4 M16 3v4 M8 12h8 M8 16h5",
  connection: "M8 12h8 M9 7H6a5 5 0 000 10h3 M15 7h3a5 5 0 010 10h-3",
  appearance: "M12 3a9 9 0 109 9h-9z",
  about: "M12 8v.1 M12 11v6 M21 12a9 9 0 11-18 0 9 9 0 0118 0",
  back: "M14 5l-7 7 7 7",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  search: "M21 21l-5-5 M18 10a8 8 0 11-16 0 8 8 0 0116 0",
};
const icon = (n) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n] || paths.tasks}"/></svg>`;
const status = () =>
  !s.connection?.configured
    ? "未配置"
    : {
        connecting: "连接中",
        syncing: "同步中",
        connected: "已连接",
        offline: "离线",
      }[s.sync] || "未提供";
const card = (title, body) =>
  `<section class="surface"><h2>${title}</h2>${body}</section>`;
const pair = (name, value) =>
  `<div><dt>${name}</dt><dd>${esc(value ?? "未提供")}</dd></div>`;
function theme() {
  document.documentElement.dataset.theme =
    s.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : s.theme;
}
function auth() {
  const d = s.form || { apiUrl: s.connection?.apiUrl || "", token: "" };
  return `<section class="connection-page" data-screen="CA-01 CA-02"><div class="brand">${icon("connection")}<strong>CodexAssistant</strong></div><div class="surface auth-card"><span class="eyebrow">连接工作站</span><h1>${s.connection?.configured ? "编辑连接" : "让进度随时可见"}</h1><p class="muted">连接你的服务，查看 Codex 任务进度与回合摘要。</p><form id="connect"><label for="api-url">服务地址</label><input id="api-url" name="apiUrl" type="url" value="${esc(d.apiUrl)}" placeholder="https://your-server.example" required><small>使用 HTTPS 站点根地址。本机调试支持回环 HTTP。</small><label for="token">访问令牌</label><div class="secret-field"><input id="token" name="token" type="${s.reveal ? "text" : "password"}" value="${esc(d.token)}" minlength="16" maxlength="4096" required autocomplete="off"><button type="button" data-reveal>${s.reveal ? "隐藏" : "显示"}</button></div><small>已有令牌不会回填，请重新输入。</small>${s.error ? `<p class="error" role="alert">${esc(s.error)}</p>` : ""}<div class="actions"><button class="primary" ${s.saving ? "disabled" : ""}>${s.saving ? "保存中…" : s.connection?.configured ? "保存并重连" : "保存并连接"}</button>${s.connection?.configured ? '<button type="button" data-cancel>取消</button>' : ""}</div></form></div><p class="muted">Windows 工作站 · Android 手机和平板</p></section>`;
}
function list() {
  const q = s.query.trim().toLocaleLowerCase();
  const tasks = s.tasks.filter(
    (t) =>
      (s.filter === "all" || t.status === s.filter) &&
      (!q ||
        `${t.title} ${t.projectName || ""} ${labels[t.status] || ""}`
          .toLocaleLowerCase()
          .includes(q)),
  );
  return `<section class="task-list" data-screen="CA-03 CA-13"><div class="list-tools"><label class="search">${icon("search")}<input id="search" type="search" value="${esc(s.query)}" placeholder="搜索任务、项目或状态" aria-label="搜索任务"></label><select id="filter" aria-label="筛选任务状态">${["all", ...Object.keys(labels)].map((v) => `<option value="${v}" ${s.filter === v ? "selected" : ""}>${v === "all" ? "全部状态" : labels[v]}</option>`).join("")}</select>${s.query || s.filter !== "all" ? "<button data-clear-filters>清除筛选</button>" : ""}</div><div class="section-heading"><h2>任务列表</h2><small>${tasks.length} 项</small></div><div class="task-scroll" data-scroll="list">${
    !s.loaded
      ? '<p class="skeleton" role="status">正在读取任务…</p>'
      : tasks.length
        ? tasks
            .map((t) => {
              const p = t.plan || [];
              const done = p.filter((x) => x.status === "completed").length;
              return `<button class="task-card ${s.selected === t.id ? "selected" : ""}" data-task="${esc(t.id)}" aria-pressed="${s.selected === t.id}"><span class="card-top"><small>${esc(t.projectName || "Codex 工作站")}</small><span class="status ${esc(t.status)}">${labels[t.status] || esc(t.status)}</span></span><strong>${esc(t.title)}</strong>${p.length ? `<small>${done} / ${p.length} 步骤完成</small><progress max="${p.length}" value="${done}" aria-label="执行计划进度"></progress>` : ""}<small>${fresh[t.freshness] || "未提供"} · ${fmt(t.updatedAt)}</small></button>`;
            })
            .join("")
        : `<div class="empty">${icon("tasks")}<h3>${!s.tasks.length && !s.lastSync ? "等待首次同步" : "暂无符合条件的任务"}</h3><p>任务采集后会显示在这里，可调整搜索与筛选条件。</p></div>`
  }</div></section>`;
}
function readable(turn) {
  if (!turn || typeof turn !== "object") return "此内容请在工作站查看";
  return (
    (Array.isArray(turn.items) ? turn.items : [turn])
      .filter((i) =>
        [
          "userMessage",
          "agentMessage",
          "assistantMessage",
          "user_message",
          "assistant_message",
        ].includes(i?.type),
      )
      .flatMap((i) =>
        typeof i.text === "string"
          ? [i.text]
          : typeof i.content === "string"
            ? [i.content]
            : Array.isArray(i.content)
              ? i.content
                  .filter(
                    (c) => c?.type === "text" && typeof c.text === "string",
                  )
                  .map((c) => c.text)
              : [],
      )
      .join("\n\n") || "此内容请在工作站查看"
  );
}
const rich = (text) => window.renderRichText(text);
function detail() {
  const t = s.tasks.find((t) => t.id === s.selected);
  if (!t) return "";
  return `<section class="task-detail" data-screen="CA-04 CA-05 CA-06 CA-07"><div class="detail-heading"><button class="icon" data-close aria-label="返回任务列表">${icon("back")}</button><div><span class="eyebrow">任务详情</span><h2>${esc(t.title)}</h2></div></div><div class="detail-meta"><span class="status ${esc(t.status)}">${labels[t.status] || esc(t.status)}</span><small>${fresh[t.freshness]}</small></div><nav class="tabs" aria-label="任务详情分区">${[
    ["plan", "执行计划"],
    ["history", "回合摘要"],
    ["message", "发送消息"],
  ]
    .map(
      ([id, label]) =>
        `<button data-tab="${id}" aria-current="${s.tab === id ? "page" : "false"}">${label}</button>`,
    )
    .join(
      "",
    )}</nav><div class="detail-scroll" data-scroll="detail">${window.interactionForms.render(
    s.interactions.filter((r) => r.threadId === t.id),
    s.ready,
  )}${t.error ? `<p class="error" role="alert">${esc(t.error.message)}</p>` : ""}${t.activeFlags?.includes("waitingOnApproval") ? '<p class="notice">请在工作站处理审批</p>' : ""}${s.tab === "plan" ? `${card("任务目标", `<p>${esc(t.goal?.objective || "未提供目标说明")}</p>${t.goal ? `<dl>${pair("已使用 Token", `${t.goal.tokensUsed}${t.goal.tokenBudget ? ` / ${t.goal.tokenBudget}` : ""}`)}${pair("运行时长", `${t.goal.timeUsedSeconds} 秒`)}</dl>` : ""}`)}${card("执行计划", t.plan.length ? `<ol class="plan-list">${t.plan.map((p, i) => `<li><span class="step-number ${p.status}">${p.status === "completed" ? "✓" : i + 1}</span><div><strong>${esc(p.title)}</strong><small>${steps[p.status] || esc(p.status)}</small></div></li>`).join("")}</ol>` : '<p class="muted">此任务未提供执行计划。</p>')}${card("最近回合", `<dl>${pair("状态", turns[t.latestTurn?.status] || "未提供")}${pair("状态变化", fmt(t.changedAt))}${pair("回合开始", fmt(t.latestTurn?.startedAt))}</dl><details><summary>诊断详情</summary><p>${esc(t.id)}</p><p>线程：${esc(t.runtimeStatus)}</p></details>`)}` : ""}${s.tab === "history" ? `<div class="section-heading"><h3>回合摘要</h3><button data-copy-summary>复制摘要</button><button data-refresh-detail ${s.loading ? "disabled" : ""}>刷新</button></div>${s.detailError ? `<p class="error" role="alert">${esc(s.detailError)}</p>` : ""}${s.loading && !s.detail ? '<p role="status" class="skeleton">正在读取回合…</p>' : (s.detail?.turns || []).map((t) => `<article class="surface turn"><span class="status">${esc(turns[t?.status] || t?.status || "未提供")}</span><div class=\"rich-text\">${rich(readable(t))}</div></article>`).join("") || '<div class="empty"><h3>暂无回合摘要</h3><p>工作站连接后可手动刷新。</p></div>'}${s.cursor ? `<button data-history ${s.loading ? "disabled" : ""}>${s.loading ? "加载中…" : "加载更早回合"}</button>` : ""}` : ""}${s.tab === "message" ? card("向工作站发送消息", `<p class="muted">Enter 发送，Shift+Enter 换行。</p>${s.sent.has(t.id) ? `<p class="notice" role="status">${esc(s.sent.get(t.id))}</p>` : ""}<form id="message-form"><label for="message">消息正文</label><textarea id="message" rows="5" maxlength="20000" placeholder="补充需求或继续当前任务…">${esc(s.draft.get(t.id) || "")}</textarea><div class="actions"><small id="count">${(s.draft.get(t.id) || "").length} / 20000</small><button type="button" data-clear-draft>清空草稿</button><button id="send" class="primary" ${!s.ready || s.pending.has(t.id) || !s.draft.get(t.id)?.trim() ? "disabled" : ""}>发送消息</button></div>${!s.ready ? '<p class="notice">本机 Codex 服务尚未就绪。草稿已保留，就绪后请手动发送。</p>' : ""}</form>`) : ""}</div></section>`;
}
function content() {
  if (s.page === "tasks")
    return `<div class="tasks-workspace ${s.selected ? "with-detail" : ""}">${list()}${detail()}</div>`;
  if (s.page === "connection")
    return `<section class="page-content" data-screen="CA-12">${card("连接状态", `<dl>${pair("同步状态", status())}${pair("服务地址", s.connection?.apiUrl)}${pair("上次采集", fmt(s.lastSync))}</dl><div class="actions"><button class="primary" data-refresh-state>重新读取状态</button><button data-edit>编辑连接</button></div>`)}${card("Windows 工作站", `<p>关闭窗口后继续在托盘运行。双击托盘图标恢复窗口，右键菜单选择“退出”停止采集。</p><details><summary>诊断详情</summary><p>设备 ${esc(s.connection?.deviceId || "未提供")}</p><p>协议 codex-assistant.v3</p></details>`)}</section>`;
  if (s.page === "appearance")
    return `<section class="page-content" data-screen="CA-09">${card(
      "外观",
      `<p class="muted">仅保存此电脑的显示偏好。</p><fieldset><legend>颜色主题</legend><div class="theme-options">${[
        ["light", "浅色"],
        ["dark", "深色"],
        ["system", "跟随系统"],
      ]
        .map(
          ([id, label]) =>
            `<label><span class="theme-preview ${id}"></span><input type="radio" name="theme" value="${id}" ${s.theme === id ? "checked" : ""}>${label}</label>`,
        )
        .join("")}</div></fieldset>`,
    )}</section>`;
  return `<section class="page-content" data-screen="CA-11 CA-08">${card("关于与更新", `<div class="brand">${icon("tasks")}<strong>CodexAssistant</strong></div><p class="muted">Windows 工作站与 Android 任务进度助手</p><dl>${pair("当前 Windows 版本", s.update?.currentVersion || "检查更新以读取版本")}${pair("协议版本", "codex-assistant.v3")}</dl><button class="primary" data-update ${s.checking ? "disabled" : ""}>${s.checking ? "检查中…" : "检查更新"}</button>${s.update ? `<p class="notice">${s.update.available ? `发现版本 ${esc(s.update.latestVersion)}` : "当前没有可用更新"}</p><div class="actions">${s.update.windowsUrl ? '<button data-download="windows">下载 Windows 版本</button>' : ""}${s.update.androidUrl ? '<button data-download="android">下载 Android 版本</button>' : ""}</div><p class="muted">下载在系统浏览器中打开，安装需手动完成。</p>` : ""}`)}</section>`;
}
function render() {
  theme();
  const focus = document.activeElement;
  const id = focus?.id;
  const selection =
    (focus instanceof HTMLInputElement ||
      focus instanceof HTMLTextAreaElement) &&
    ["search", "text", "password", "textarea"].includes(focus.type)
      ? [focus.selectionStart, focus.selectionEnd]
      : null;
  const scroll = new Map(
    [...root.querySelectorAll("[data-scroll]")].map((e) => [
      e.dataset.scroll,
      e.scrollTop,
    ]),
  );
  root.innerHTML =
    !s.connection?.configured || s.page === "edit"
      ? auth()
      : `<div class="app-shell"><aside class="sidebar ${s.menu ? "open" : ""}"><div class="brand">${icon("tasks")}<strong>CodexAssistant</strong></div><nav aria-label="主导航">${[
          ["tasks", "任务"],
          ["connection", "连接状态"],
          ["appearance", "外观"],
          ["about", "关于"],
        ]
          .map(
            ([id, label]) =>
              `<button data-page="${id}" title="${label}" aria-current="${s.page === id ? "page" : "false"}">${icon(id)}<span>${label}</span></button>`,
          )
          .join(
            "",
          )}</nav><div class="sidebar-foot"><i class="connection-dot ${s.sync}"></i><span>${status()}</span></div></aside>${s.menu ? '<button class="nav-backdrop" data-menu aria-label="关闭导航"></button>' : ""}<main class="main-workspace"><header class="app-header"><button class="icon mobile-menu" data-menu aria-label="打开导航">${icon("menu")}</button><h1>${{ tasks: "任务工作台", connection: "连接与诊断", appearance: "设置与外观", about: "关于与更新" }[s.page]}</h1><span class="connection"><i class="connection-dot ${s.sync}"></i>${status()}</span></header>${s.error ? `<p class="error global-error" role="alert">${esc(s.error)}</p>` : ""}${content()}<footer>${s.lastSync ? `上次采集 ${fmt(s.lastSync)}` : "等待首次同步"}</footer></main></div>`;
  if (s.notice)
    root.insertAdjacentHTML(
      "beforeend",
      `<output class="toast" role="status">${esc(s.notice)}<button data-dismiss aria-label="关闭提示">×</button></output>`,
    );
  if (s.discard)
    root.insertAdjacentHTML(
      "beforeend",
      '<dialog open aria-labelledby="discard-title"><h2 id="discard-title">放弃未保存内容？</h2><p>离开后，本次未保存的修改将丢失。</p><div class="actions"><button data-keep>继续编辑</button><button data-discard class="danger">放弃并离开</button></div></dialog><div class="modal-backdrop"></div>',
    );
  bind();
  root.querySelectorAll("[data-scroll]").forEach((e) => {
    if (scroll.has(e.dataset.scroll))
      e.scrollTop = scroll.get(e.dataset.scroll);
  });
  if (id) {
    const next = document.getElementById(id);
    next?.focus({ preventScroll: true });
    if (selection && selection[0] !== null && next?.setSelectionRange)
      next.setSelectionRange(...selection);
  }
}
function closeDetail() {
  s.selected = null;
  s.detail = null;
  s.cursor = null;
  s.detailError = "";
  s.loading = false;
  s.epoch++;
  render();
}
async function load(more = false) {
  if (!s.selected || s.loading) return;
  const id = s.selected;
  const epoch = s.epoch;
  s.loading = true;
  s.detailError = "";
  render();
  try {
    const result = await window.codexAssistant.getTaskDetail({
      threadId: id,
      ...(more && s.cursor ? { cursor: s.cursor } : {}),
    });
    if (s.selected !== id || s.epoch !== epoch) return;
    const all = more
      ? [...(s.detail?.turns || []), ...(result.turns || [])]
      : result.turns || [];
    const seen = new Set();
    s.detail = {
      turns: all.filter((t) => {
        if (!t?.id) return true;
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      }),
    };
    s.cursor = result.cursor;
  } catch (e) {
    if (s.epoch === epoch) s.detailError = e.message || "读取失败";
  } finally {
    if (s.epoch === epoch) {
      s.loading = false;
      render();
    }
  }
}
function bind() {
  window.interactionForms.bind(root, async (request, value) => {
    const result = await window.codexAssistant.submitInteraction({
      requestId: request.requestId,
      threadId: request.threadId,
      value,
    });
    s.interactions = await window.codexAssistant.getInteractions();
    render();
    return result;
  });
  const on = (sel, event, fn) =>
    root.querySelectorAll(sel).forEach((e) => e.addEventListener(event, fn));
  on("[data-page]", "click", (e) => {
    s.page = e.currentTarget.dataset.page;
    s.menu = false;
    s.error = "";
    if (s.page !== "tasks") closeDetail();
    else render();
  });
  on("[data-menu]", "click", () => {
    s.menu = !s.menu;
    render();
  });
  on("#search", "input", (e) => {
    s.query = e.currentTarget.value;
    render();
  });
  on("#filter", "change", (e) => {
    s.filter = e.currentTarget.value;
    render();
  });
  on("[data-task]", "click", (e) => {
    s.selected = e.currentTarget.dataset.task;
    s.tab = "plan";
    s.detail = null;
    s.cursor = null;
    s.epoch++;
    s.loading = false;
    render();
    void load();
  });
  on("[data-close]", "click", closeDetail);
  on("[data-tab]", "click", (e) => {
    s.tab = e.currentTarget.dataset.tab;
    render();
  });
  on("[data-refresh-detail]", "click", () => void load());
  on("[data-clear-filters]", "click", () => {
    s.query = "";
    s.filter = "all";
    render();
  });
  on("[data-clear-draft]", "click", () => {
    s.draft.delete(s.selected);
    render();
  });
  on("[data-copy-summary]", "click", async () => {
    try {
      const text = (s.detail?.turns || []).map(readable).join("\n\n");
      if (!text) {
        s.notice = "暂无可复制摘要";
        render();
        return;
      }
      await navigator.clipboard.writeText(text);
      s.notice = "摘要已复制";
    } catch {
      s.notice = "无法访问剪贴板，请选择正文复制";
    }
    render();
  });
  on("[data-history]", "click", () => void load(true));
  on("#message", "input", (e) => {
    const value = e.currentTarget.value;
    s.draft.set(s.selected, value);
    root.querySelector("#count").textContent = `${value.length} / 20000`;
    root.querySelector("#send").disabled =
      !s.ready || s.pending.has(s.selected) || !value.trim();
  });
  on("#message", "keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      root.querySelector("#message-form")?.requestSubmit();
    }
  });
  on("#message-form", "submit", async (e) => {
    e.preventDefault();
    const id = s.selected;
    const text = s.draft.get(id)?.trim();
    if (!text || text.length > 20000 || !s.ready || s.pending.has(id)) return;
    s.pending.add(id);
    s.sent.set(id, "正在发送…");
    render();
    try {
      const r = await window.codexAssistant.sendTaskMessage({
        threadId: id,
        text,
      });
      if (r.status === "started" && s.draft.get(id)?.trim() === text)
        s.draft.delete(id);
      s.sent.set(
        id,
        r.status === "started"
          ? "Codex Desktop 已接受消息，可继续发送；进展请查看回合摘要。"
          : "发送未确认",
      );
    } catch (e) {
      s.sent.set(id, e.message || "结果尚未确认，请读取回合摘要核实后再发送。");
    } finally {
      s.pending.delete(id);
      render();
    }
  });
  on("[data-edit]", "click", () => {
    s.page = "edit";
    s.form = { apiUrl: s.connection?.apiUrl || "", token: "" };
    s.error = "";
    render();
  });
  on("#connect input", "input", () => {
    s.form = {
      apiUrl: root.querySelector("#api-url").value,
      token: root.querySelector("#token").value,
    };
  });
  on("[data-reveal]", "click", () => {
    s.reveal = !s.reveal;
    render();
  });
  on("#connect", "submit", async (e) => {
    e.preventDefault();
    if (s.saving) return;
    const data = new FormData(e.currentTarget);
    const apiUrl = String(data.get("apiUrl")).trim();
    const token = String(data.get("token")).trim();
    try {
      const u = new URL(apiUrl);
      if (
        u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
        )
      )
        throw new Error("服务地址必须使用 HTTPS 或本机回环 HTTP。");
      if (token.length < 16 || token.length > 4096)
        throw new Error("访问令牌长度应为 16–4096。");
      s.saving = true;
      s.error = "";
      render();
      await window.codexAssistant.saveConnection({ apiUrl, token });
      s.connection = await window.codexAssistant.getConnection();
      s.page = "tasks";
      s.form = null;
      s.reveal = false;
      s.draft.clear();
      s.sent.clear();
      closeDetail();
    } catch (e) {
      s.error = e.message || "保存失败";
    } finally {
      s.saving = false;
      render();
    }
  });
  on("[data-cancel]", "click", () => {
    if (s.form?.token || s.form?.apiUrl !== s.connection?.apiUrl) {
      s.discard = true;
      render();
      root.querySelector("[data-keep]")?.focus();
    } else {
      s.page = "connection";
      render();
    }
  });
  on("[data-keep]", "click", () => {
    s.discard = false;
    render();
  });
  on("[data-discard]", "click", () => {
    s.discard = false;
    s.form = null;
    s.page = "connection";
    s.error = "";
    render();
  });
  on("[name=theme]", "change", (e) => {
    s.theme = e.currentTarget.value;
    localStorage.setItem("ca.theme", s.theme);
    render();
  });
  on("[data-refresh-state]", "click", async () => {
    try {
      s.sync = await window.codexAssistant.getSyncStatus();
      s.ready = (await window.codexAssistant.getWorkstationStatus()).ready;
      s.notice = "已重新读取本机同步状态";
    } catch (e) {
      s.error = e.message;
    }
    render();
  });
  on("[data-update]", "click", async () => {
    if (s.checking) return;
    s.checking = true;
    s.error = "";
    render();
    try {
      s.update = await window.codexAssistant.checkUpdate();
    } catch (e) {
      s.error = e.message || "检查失败";
    } finally {
      s.checking = false;
      render();
    }
  });
  on("[data-download]", "click", async (e) => {
    try {
      const r = await window.codexAssistant.downloadUpdate(
        e.currentTarget.dataset.download,
      );
      if (r.opened) s.notice = "已在系统浏览器打开下载";
    } catch (e) {
      s.error = e.message;
    }
    render();
  });
  on("[data-dismiss]", "click", () => {
    s.notice = "";
    render();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (s.discard) {
      s.discard = false;
      render();
    } else if (s.menu) {
      s.menu = false;
      render();
    } else if (s.selected) closeDetail();
  }
  if (e.key === "Tab" && s.discard) {
    const b = [...root.querySelectorAll("dialog button")];
    if (e.shiftKey && document.activeElement === b[0]) {
      e.preventDefault();
      b.at(-1).focus();
    } else if (!e.shiftKey && document.activeElement === b.at(-1)) {
      e.preventDefault();
      b[0].focus();
    }
  }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
// 周期性同步只更新状态区域；未变化的列表不替换 DOM，保留滚动、输入法和表单焦点。
function renderConnection() {
  root
    .querySelectorAll(".sidebar-foot,.app-header .connection")
    .forEach((element) => {
      element.innerHTML = `<i class="connection-dot ${s.sync}"></i><span>${status()}</span>`;
    });
  root.querySelectorAll("footer").forEach((element) => {
    element.textContent = s.lastSync
      ? `上次采集 ${fmt(s.lastSync)}`
      : "等待首次同步";
  });
  if (s.page === "connection") render();
}
async function boot() {
  try {
    if (!window.codexAssistant)
      throw new Error("桌面桥接未加载，请重启 CodexAssistant");
    s.connection = await window.codexAssistant.getConnection();
    s.tasks = await window.codexAssistant.getTasks();
    s.interactions = await window.codexAssistant.getInteractions();
    s.sync = await window.codexAssistant.getSyncStatus();
    s.ready = (await window.codexAssistant.getWorkstationStatus()).ready;
    s.loaded = true;
    let taskSignature = JSON.stringify(s.tasks);

    let statusEpoch = 0;
    window.codexAssistant.onTasks((tasks) => {
      const signature = JSON.stringify(tasks);
      s.loaded = true;
      s.lastSync = Date.now();
      if (signature === taskSignature) {
        renderConnection();
        return;
      }
      taskSignature = signature;
      s.tasks = tasks;
      if (s.selected && !tasks.some((t) => t.id === s.selected)) closeDetail();
      else render();
    });
    window.codexAssistant.onSyncStatus(async (status) => {
      const epoch = ++statusEpoch;
      s.sync = status;
      try {
        const [interactions, workstation] = await Promise.all([
          window.codexAssistant.getInteractions(),
          window.codexAssistant.getWorkstationStatus(),
        ]);
        if (epoch !== statusEpoch) return;
        const signature = JSON.stringify(interactions);
        const changed =
          signature !== JSON.stringify(s.interactions) ||
          s.ready !== workstation.ready;
        s.interactions = interactions;

        s.ready = workstation.ready;
        if (changed) render();
        else renderConnection();
      } catch {
        if (epoch === statusEpoch) {
          s.ready = false;
          render();
        }
      }
    });
  } catch (e) {
    s.error = e.message || "初始化失败";
  }
  render();
}
void boot();
window.addEventListener("interactions-updated", render);
