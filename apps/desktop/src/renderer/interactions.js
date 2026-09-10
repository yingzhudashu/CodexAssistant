// Per-request drafts are memory-only; never persist or log answers.
window.interactionForms = (() => {
  const drafts = new Map(), pending = new Set(), errors = new Map();
  let requests = [];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render(items, ready) {
    requests = items;
    return items.map(r => {
      const disabled = !ready || pending.has(r.requestId) ? 'disabled' : '';
      const answers = drafts.get(r.requestId) || {};
      return `<section class="surface"><span class="eyebrow">待确认</span><h2>${esc(r.title)}</h2><p>${esc(r.description)}</p><form data-interaction="${esc(r.requestId)}">${r.kind === 'confirm' ? (r.options || []).map(o => `<button type="button" data-decision="${esc(o.id)}" ${disabled}>${esc(o.label)}</button><p>${esc(o.description)}</p>`).join('') : (r.questions || []).map((q, i) => `<fieldset><legend>${esc(q.header)}${q.required ? ' · 必填' : ''}</legend><p>${esc(q.question)}</p>${(q.options || []).map((o, j) => `<label><input type="${q.multiple ? 'checkbox' : 'radio'}" name="q-${i}" data-question="${i}" data-option="${j}" ${answers[q.id]?.includes(o.label) ? 'checked' : ''} ${disabled}>${esc(o.label)} <small>${esc(o.description)}</small></label>`).join('')}${!q.options?.length || q.isOther ? `<label>填写回答<input type="${q.isSecret ? 'password' : 'text'}" data-text="${i}" value="${esc(answers[q.id]?.filter(x => !(q.options || []).some(o => o.label === x)).join('') || '')}" maxlength="20000" ${disabled} autocomplete="off"></label>` : ''}</fieldset>`).join('')}${r.kind === 'unsupported' ? '<p>此请求无法在当前客户端处理，可取消后在工作站重新发起。</p>' : r.kind !== 'confirm' ? `<button class="primary" ${disabled}>提交全部回答</button>` : ''}<button type="button" data-cancel-request ${disabled}>取消请求</button><p role="status">${pending.has(r.requestId) ? '正在提交…' : esc(errors.get(r.requestId))}</p></form></section>`;
    }).join('');
  }
  function bind(root, submit) {
    root.querySelectorAll('[data-interaction]').forEach(form => {
      const request = requests.find(r => r.requestId === form.dataset.interaction);
      const save = () => {
        const answers = Object.create(null);
        (request.questions || []).forEach((q, i) => {
          const input = form.querySelector(`[data-text="${i}"]`);
          const selected = [...form.querySelectorAll(`[data-question="${i}"]:checked`)].map(el => q.options[Number(el.dataset.option)].label);
          if (input?.value) answers[q.id] = [input.value];
          else if (selected.length) answers[q.id] = selected;
        });
        drafts.set(request.requestId, answers);
        return answers;
      };
      form.addEventListener('input', save);
      const send = async value => {
        if (pending.has(request.requestId)) return;
        pending.add(request.requestId);
        form.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
        try {
          const result = await submit(request, value);
          if (result.status === 'failed') errors.set(request.requestId, result.error);
          else { drafts.delete(request.requestId); errors.delete(request.requestId); }
        } catch { errors.set(request.requestId, '结果尚未确认，请核实后重试'); }
        finally { pending.delete(request.requestId); window.dispatchEvent(new Event('interactions-updated')); }
      };
      form.addEventListener('submit', event => { event.preventDefault(); const answers = save(); if (request.questions.some(q => q.required && !answers[q.id]?.some(x => x.trim()))) { errors.set(request.requestId, '请完成所有必填问题'); window.dispatchEvent(new Event('interactions-updated')); return; } void send({ answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { answers: v }])) }); });
      form.querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', () => void send({ decision: button.dataset.decision })));
      form.querySelector('[data-cancel-request]').addEventListener('click', () => void send({ cancel: true }));
    });
  }
  return { render, bind };
})();
