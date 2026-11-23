const KEY = 'aiops-admin-key';
let adminKey = localStorage.getItem(KEY) || 'change-me-local-admin-key';
document.getElementById('adminKey').value = adminKey;

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  setTimeout(() => (el.className = 'toast'), 2500);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey, ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({ error: 'invalid json' }));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function refreshAll() {
  try {
    await Promise.all([refreshSummary(), refreshAccounts(), refreshTasks(), refreshHealth(), refreshUsage(), refreshAdapters(), refreshAgents(), refreshRecords(), refreshDoctor()]);
  } catch (err) { toast(err.message, 'error'); }
}

async function refreshSummary() {
  const data = await api('/api/summary');
  $('summaryCards').innerHTML = [
    ['账号总数', data.accounts.total],
    ['今日成功签到', data.today.success],
    ['今日奖励', data.today.reward],
    ['积分合计', data.points_total],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('');
  $('recentEvents').innerHTML = data.recent_events.length
    ? data.recent_events.map((e) => `<div class="item"><b>[${esc(e.level)}]</b> ${esc(e.message)} <small>${esc(e.at)}</small></div>`).join('')
    : '<p class="muted">暂无事件</p>';
  $('healthBadge').textContent = '服务在线';
  $('healthBadge').className = 'badge ok';
}

async function refreshAccounts() {
  const data = await api('/api/accounts');
  const platforms = await api('/api/adapters');
  const select = $('newPlatform');
  select.innerHTML = platforms.adapters.map((a) => `<option value="${esc(a.platform)}">${esc(a.label)}</option>`).join('');
  $('accountTable').querySelector('tbody').innerHTML = data.accounts.map((a) => `
    <tr><td>${a.id}</td><td>${esc(a.name)}</td><td><span class="chip">${esc(a.platform)}</span></td>
    <td>${esc(a.status)}</td><td>${esc(a.health)}</td><td>${a.points}</td><td>${esc((a.groups || []).join(', '))}</td>
    <td class="actions"><button data-act="switch" data-id="${a.id}" class="mini">切换</button>
    <button data-act="checkin" data-id="${a.id}" class="mini">签到</button>
    <button data-act="points" data-id="${a.id}" class="mini">积分</button></td></tr>`).join('');
  document.querySelectorAll('#accountTable button[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.id);
      const endpoint = btn.dataset.act === 'checkin' ? '/api/checkin' : btn.dataset.act === 'points' ? '/api/points' : '/api/switch';
      try {
        const result = await api(endpoint, { method: 'POST', body: JSON.stringify({ account_id: id }) });
        toast(`${btn.dataset.act}: ${result.status || 'ok'}`, 'ok');
        await refreshAll();
      } catch (err) { toast(err.message, 'error'); }
    };
  });
}

async function refreshTasks() {
  const data = await api('/api/tasks');
  $('taskTable').querySelector('tbody').innerHTML = data.tasks.map((t) => `
    <tr><td>${esc(t.id)}</td><td>${esc(t.name)}</td><td>${esc(t.type)}</td><td>${esc(t.time || `每 ${t.interval_hours}h`)}</td>
    <td>${t.enabled ? '是' : '否'}</td><td>${t.last_run ? new Date(t.last_run).toLocaleString() : '-'}</td></tr>`).join('');
}

async function refreshHealth() {
  const data = await api('/api/health');
  $('healthList').innerHTML = data.items.map((h) => `<div class="item"><b>#${h.id} ${esc(h.name)}</b> · ${esc(h.platform)} · ${esc(h.health)} · ${h.fail_streak} 连败</div>`).join('') || '<p class="muted">暂无账号</p>';
}

async function refreshUsage() {
  const data = await api('/api/usage');
  $('usageOut').innerHTML = `<div class="item">调用 <b>${data.calls}</b> 次 · Token <b>${data.tokens}</b></div>` +
    Object.entries(data.by_model || {}).map(([k, v]) => `<div class="item">${esc(k)}: ${v}</div>`).join('');
}

async function refreshAdapters() {
  const data = await api('/api/adapters');
  $('adapterList').innerHTML = data.adapters.map((a) => `<div class="item"><b>${esc(a.label)}</b> · ${esc(a.platform)} · ${esc(a.checkin_mode)} · ${esc(a.credential_dir)}</div>`).join('');
}

async function refreshAgents() {
  const data = await api('/api/agents');
  $('agentsOut').innerHTML = (data.agents || []).map((a) => {
    const online = a.online ? '<span class="chip">在线</span>' : '<span class="chip">离线</span>';
    return `<div class="item"><b>${esc(a.machine_id)}</b> · ${esc(a.platform)} · ${online} · ${esc(a.id)} · last_seq=${esc((a.context || {}).last_seq || 0)}</div>`;
  }).join('') || '<p class="muted">暂无 Agent</p>';
  $('commandsOut').textContent = (data.commands || []).map((c) => JSON.stringify(c)).join('\n');
}

async function refreshRecords() {
  const data = await api('/api/records?limit=100');
  $('recordsOut').textContent = data.records.map((r) => JSON.stringify(r)).join('\n');
}

async function refreshDoctor() {
  try { const data = await api('/api/doctor'); $('doctorOut').textContent = JSON.stringify(data, null, 2); } catch (_) {}
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.tab).classList.add('active');
  };
});

$('saveKey').onclick = () => { adminKey = $('adminKey').value; localStorage.setItem(KEY, adminKey); toast('管理密钥已保存'); refreshAll(); };
$('initBtn').onclick = async () => {
  try { const data = await api('/api/init', { method: 'POST', body: JSON.stringify({ password: $('initPassword').value }) });
    $('initResult').textContent = JSON.stringify(data, null, 2); toast('初始化完成'); await refreshAll();
  } catch (err) { toast(err.message, 'error'); }
};
$('addBtn').onclick = async () => {
  try { await api('/api/add', { method: 'POST', body: JSON.stringify({ name: $('newName').value || 'account', platform: $('newPlatform').value, groups: $('newGroups').value.split(',').map(s => s.trim()).filter(Boolean) }) });
    toast('账号已添加'); await refreshAll();
  } catch (err) { toast(err.message, 'error'); }
};
$('refreshAccounts').onclick = refreshAll;
$('runTasks').onclick = async () => {
  try { const data = await api('/api/task/run', { method: 'POST', body: JSON.stringify({}) }); $('taskResult').textContent = JSON.stringify(data, null, 2); toast('任务已执行'); await refreshAll(); }
  catch (err) { toast(err.message, 'error'); }
};
$('refreshReport').onclick = async () => {
  try { const data = await api('/api/report?month=' + encodeURIComponent($('reportMonth').value)); $('reportOut').textContent = JSON.stringify(data, null, 2); }
  catch (err) { toast(err.message, 'error'); }
};
$('refreshRecords').onclick = refreshRecords;
$('refreshAgents').onclick = refreshAgents;
$('doctorBtn').onclick = refreshDoctor;
$('gatewayTest').onclick = async () => {
  try {
    const data = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': $('gatewayKey').value }, body: JSON.stringify({ model: $('gatewayModel').value, messages: [{ role: 'user', content: 'hello' }] }) }).then((r) => r.json());
    $('gatewayOut').textContent = JSON.stringify(data, null, 2); toast('网关调用完成'); await refreshUsage();
  } catch (err) { toast(err.message, 'error'); }
};

refreshAll();
setInterval(refreshSummary, 10000);
