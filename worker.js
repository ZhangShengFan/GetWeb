const CONFIG = {
  SITE_TITLE: 'ZSFan',
  SITE_SUBTITLE: '网页转EXE',
  DEFAULT_VERSION: '1.0.0',
  POLL_START_DELAY: 12000,
  POLL_INTERVAL: 6000,
}

let _env = {}

export default {
  async fetch(request, env) {
    _env = env
    const DB = env.DB
    const url = new URL(request.url)
    if (url.pathname === '/') return new Response(buildHTML(CONFIG), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (url.pathname === '/build' && request.method === 'POST') return handleBuild(request, DB)
    if (url.pathname.startsWith('/status/')) {
      const task_id = url.pathname.split('/').pop()
      const triggered_at = url.searchParams.get('t')
      const repo = url.searchParams.get('repo')
      return handleStatus(task_id, repo, triggered_at, DB)
    }
    if (url.pathname.startsWith('/logs/')) return handleLogs(url.pathname.split('/').pop(), new URL(request.url).searchParams.get('repo'), DB)
    if (url.pathname.startsWith('/download/')) return handleDownload(url.pathname.split('/').pop(), DB)
    if (url.pathname === '/history') return handleHistory(DB)
    if (url.pathname === '/token') return new Response(buildTokenHTML(CONFIG), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (url.pathname === '/token/list' && request.method === 'GET') return handleTokenList(DB)
    if (url.pathname === '/token/add' && request.method === 'POST') return handleTokenAdd(request, DB)
    if (url.pathname === '/token/delete' && request.method === 'POST') return handleTokenDelete(request, DB)
    return new Response('Not found', { status: 404 })
  },
}

async function getTokenEntries(DB) {
  if (DB) {
    const { results = [] } = await DB.prepare(`SELECT token, repo FROM tokens ORDER BY id ASC`).all()
    if (results.length > 0) return results
  }
  return []
}

async function getAvailableToken(DB) {
  const entries = await getTokenEntries(DB)
  if (!entries.length) throw new Error('没有可用的 Token，请在 /token 页面添加')
  for (const entry of entries) {
    const resp = await fetch('https://api.github.com/rate_limit', {
      headers: { Authorization: `Bearer ${entry.token}`, 'User-Agent': 'WebToEXE-Worker', Accept: 'application/vnd.github+json' },
    })
    if (!resp.ok) continue
    const { rate } = await resp.json()
    if (rate.remaining > 10) return entry
  }
  throw new Error('所有 Token 均已限速，请稍后重试或在 /token 添加更多 Token')
}

function ghFetch(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'WebToEXE-Worker' },
  })
}

async function getTokenForRepo(repo, DB) {
  const entries = await getTokenEntries(DB)
  const entry = entries.find(e => e.repo === repo)
  if (!entry) throw new Error(`找不到仓库 ${repo} 对应的 Token`)
  return entry.token
}

async function handleTokenList(DB) {
  if (!DB) return json({ tokens: [], count: 0 })
  const { results = [] } = await DB.prepare(`SELECT id, token, label, repo, added_at FROM tokens ORDER BY id ASC`).all()
  const masked = results.map(t => ({ id: t.id, label: t.label, repo: t.repo, added_at: t.added_at, token: t.token.slice(0, 8) + '…' + t.token.slice(-4) }))
  return json({ tokens: masked, count: masked.length })
}

async function handleTokenAdd(request, DB) {
  if (!DB) return json({ error: 'D1 未绑定' }, 500)
  const { token, label, repo } = await request.json()
  if (!token || (!token.startsWith('ghp_') && !token.startsWith('github_pat_'))) return json({ error: 'Token 格式不正确（应以 ghp_ / github_pat_ 开头）' }, 400)
  if (!repo || !repo.includes('/')) return json({ error: '仓库格式不正确，应为 username/repo-name' }, 400)
  const userResp = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'WebToEXE-Worker' } })
  if (!userResp.ok) return json({ error: 'Token 无效，GitHub 返回: ' + userResp.status }, 400)
  const user = await userResp.json()
  const wfResp = await ghFetch(`https://api.github.com/repos/${repo}/actions/workflows`, token)
  if (wfResp.status === 404) return json({ error: `仓库 ${repo} 不存在或无权访问` }, 400)
  if (wfResp.status === 403) return json({ error: `Token 对仓库 ${repo} 没有足够权限` }, 400)
  if (!wfResp.ok) return json({ error: `仓库验证失败: ${wfResp.status}` }, 400)
  const wfData = await wfResp.json()
  const hasBuildYml = wfData.workflows?.some(w => w.path.includes('build.yml'))
  if (!hasBuildYml) return json({ error: `仓库 ${repo} 中未找到 build.yml workflow` }, 400)
  const finalLabel = label || user.login
  await DB.prepare(`INSERT INTO tokens (token, label, repo, added_at) VALUES (?, ?, ?, ?)`).bind(token, finalLabel, repo, new Date().toISOString()).run()
  return json({ ok: true, label: finalLabel, login: user.login, repo })
}

async function handleTokenDelete(request, DB) {
  if (!DB) return json({ error: 'D1 未绑定' }, 500)
  const { id } = await request.json()
  await DB.prepare(`DELETE FROM tokens WHERE id = ?`).bind(id).run()
  return json({ ok: true })
}

async function handleBuild(request, DB) {
  const { url, appName, version, iconUrl } = await request.json()
  const task_id = crypto.randomUUID()
  const triggered_at = new Date().toISOString()
  let entry
  try { entry = await getAvailableToken(DB) } catch (e) { return json({ error: e.message }, 500) }
  const { token, repo } = entry
  if (DB) {
    await DB.prepare(`INSERT INTO builds (id,app_name,url,version,icon_url,status,triggered_at,created_at,repo) VALUES (?,?,?,?,?,'pending',?,?,?)`)
      .bind(task_id, appName, url, version, iconUrl || '', triggered_at, triggered_at, repo).run()
  }
  const resp = await ghFetch(`https://api.github.com/repos/${repo}/actions/workflows/build.yml/dispatches`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { url, app_name: appName, version, icon_url: iconUrl ?? '', task_id } }),
  })
  if (!resp.ok) { const msg = await resp.text(); return json({ error: `GitHub 触发失败: ${msg}` }, 500) }
  return json({ task_id, triggered_at, repo })
}

async function handleStatus(task_id, repo, triggered_at, DB) {
  if (!repo) return json({ ready: false, status: 'pending', step: '缺少仓库参数', progress: 0, steps: [] })
  let token
  try { token = await getTokenForRepo(repo, DB) } catch (e) { return json({ ready: false, status: 'pending', step: e.message, progress: 3, steps: [] }) }
  const [owner, repoName] = repo.split('/')
  const runsResp = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}/actions/workflows/build.yml/runs?per_page=20`, token)
  if (!runsResp.ok) return json({ ready: false, status: 'pending', step: '等待 GitHub 响应…', progress: 3, steps: [] })
  const { workflow_runs: runs = [] } = await runsResp.json()
  const triggeredTime = triggered_at ? new Date(triggered_at).getTime() : 0
  const relevantRuns = runs.filter(r => new Date(r.created_at).getTime() >= triggeredTime - 30000)
  for (const run of relevantRuns.filter(r => r.conclusion === 'success')) {
    const artResp = await ghFetch(run.artifacts_url, token)
    if (!artResp.ok) continue
    const { artifacts = [] } = await artResp.json()
    const art = artifacts.find(a => a.name === `exe-${task_id}`)
    if (!art) continue
    const steps = await getSteps(owner, repoName, run.id, token)
    if (DB) await DB.prepare(`UPDATE builds SET status='success',run_id=?,download_ready=1 WHERE id=?`).bind(String(run.id), task_id).run()
    return json({ ready: true, step: '构建完成', progress: 100, run_id: run.id, steps })
  }
  const failedRun = relevantRuns.find(r => r.conclusion === 'failure')
  if (failedRun) {
    const steps = await getSteps(owner, repoName, failedRun.id, token)
    if (DB) await DB.prepare(`UPDATE builds SET status='failed',run_id=? WHERE id=?`).bind(String(failedRun.id), task_id).run()
    return json({ ready: false, status: 'failed', step: '构建失败', progress: 0, run_id: failedRun.id, steps })
  }
  const queuedRun = relevantRuns.find(r => r.status === 'queued')
  if (queuedRun) return json({ ready: false, status: 'queued', step: '排队等待 runner…', progress: 5, steps: [] })
  const activeRun = relevantRuns.find(r => r.status === 'in_progress')
  if (!activeRun) return json({ ready: false, status: 'pending', step: '等待 Actions 启动…', progress: 5, steps: [] })
  const steps = await getSteps(owner, repoName, activeRun.id, token)
  if (DB) await DB.prepare(`UPDATE builds SET status='building',run_id=? WHERE id=?`).bind(String(activeRun.id), task_id).run()
  const stepProgressMap = {
    'Setup Node.js': { progress: 10, label: '初始化 Node.js 环境…' },
    'Init project': { progress: 25, label: '安装 Electron 依赖…' },
    'Generate main.js': { progress: 40, label: '生成应用入口文件…' },
    'Download custom icon': { progress: 48, label: '下载应用图标…' },
    'Generate package.json': { progress: 55, label: '生成 package.json…' },
    'Build EXE': { progress: 75, label: 'electron-builder 打包中…' },
    'Upload EXE as artifact': { progress: 92, label: '上传 EXE 到 GitHub…' },
    'Print artifact info': { progress: 97, label: '收尾处理…' },
  }
  const currentStep = steps.find(s => s.status === 'in_progress')
  const lastDone = [...steps].reverse().find(s => s.conclusion === 'success')
  const active = currentStep || lastDone
  const mapped = active ? stepProgressMap[active.name] : null
  return json({ ready: false, status: 'in_progress', step: mapped?.label ?? '构建中…', progress: mapped?.progress ?? 15, run_id: activeRun.id, steps })
}

async function handleDownload(task_id, DB) {
  let repo = null
  if (DB) { const row = await DB.prepare(`SELECT repo FROM builds WHERE id = ?`).bind(task_id).first(); repo = row?.repo }
  if (!repo) return new Response('找不到构建记录', { status: 404 })
  let token
  try { token = await getTokenForRepo(repo, DB) } catch (e) { return new Response(e.message, { status: 500 }) }
  const [owner, repoName] = repo.split('/')
  const runsResp = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}/actions/workflows/build.yml/runs?per_page=20`, token)
  if (!runsResp.ok) return new Response('找不到构建记录', { status: 404 })
  const { workflow_runs: runs = [] } = await runsResp.json()
  for (const run of runs.filter(r => r.conclusion === 'success')) {
    const artResp = await ghFetch(run.artifacts_url, token)
    if (!artResp.ok) continue
    const { artifacts = [] } = await artResp.json()
    const art = artifacts.find(a => a.name === `exe-${task_id}`)
    if (!art) continue
    const zipResp = await fetch(art.archive_download_url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'WebToEXE-Worker' },
      redirect: 'follow',
    })
    if (!zipResp.ok) return new Response('下载失败: ' + zipResp.status, { status: 502 })
    return new Response(zipResp.body, {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${art.name}.zip"`, 'Cache-Control': 'no-store' },
    })
  }
  return new Response('Artifact 不存在或已过期', { status: 404 })
}

async function handleLogs(run_id, repo, DB) {
  if (!repo) return json({ logs: '缺少仓库参数' })
  let token
  try { token = await getTokenForRepo(repo, DB) } catch (e) { return json({ logs: e.message }) }
  const [owner, repoName] = repo.split('/')
  const jobsResp = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run_id}/jobs`, token)
  if (!jobsResp.ok) return json({ logs: '无法获取日志' })
  const { jobs = [] } = await jobsResp.json()
  const job = jobs[0]
  if (!job) return json({ logs: '未找到 job' })
  const logResp = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}/actions/jobs/${job.id}/logs`, token, { headers: { 'Cache-Control': 'no-cache' } })
  if (!logResp.ok) {
    const doneSteps = job.steps?.filter(s => s.conclusion === 'success').map(s => '✓ ' + s.name) ?? []
    const runningStep = job.steps?.find(s => s.status === 'in_progress')
    const placeholder = [...doneSteps, runningStep ? '> ' + runningStep.name + '（运行中…）' : ''].filter(Boolean).join('\n')
    return json({ logs: placeholder || '日志生成中，请稍候…' })
  }
  const raw = await logResp.text()
  const lines = raw.split('\n').map(l => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '')).filter(l => l.trim()).slice(-300).join('\n')
  return json({ logs: lines })
}

async function handleHistory(DB) {
  if (!DB) return json({ records: [] })
  const { results = [] } = await DB.prepare(
    `SELECT id,app_name,url,version,icon_url,status,run_id,download_ready,created_at,repo FROM builds ORDER BY created_at DESC LIMIT 50`
  ).all()
  for (const rec of results) {
    if (rec.status !== 'building' && rec.status !== 'pending') continue
    try {
      const token = await getTokenForRepo(rec.repo, DB)
      const [owner, repoName] = rec.repo.split('/')
      const runsResp = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}/actions/workflows/build.yml/runs?per_page=20`, token)
      if (!runsResp.ok) continue
      const { workflow_runs: runs = [] } = await runsResp.json()
      let synced = false
      for (const run of runs.filter(r => r.conclusion === 'success')) {
        const artResp = await ghFetch(run.artifacts_url, token)
        if (!artResp.ok) continue
        const { artifacts = [] } = await artResp.json()
        const art = artifacts.find(a => a.name === `exe-${rec.id}`)
        if (!art) continue
        await DB.prepare(`UPDATE builds SET status='success',run_id=?,download_ready=1 WHERE id=?`).bind(String(run.id), rec.id).run()
        rec.status = 'success'; rec.download_ready = 1; rec.run_id = String(run.id); synced = true; break
      }
      if (!synced) {
        const failedRun = runs.find(r => r.conclusion === 'failure')
        if (failedRun) {
          await DB.prepare(`UPDATE builds SET status='failed',run_id=? WHERE id=?`).bind(String(failedRun.id), rec.id).run()
          rec.status = 'failed'; rec.run_id = String(failedRun.id)
        }
      }
    } catch {}
  }
  return json({ records: results })
}

async function getSteps(owner, repo, run_id, token) {
  try {
    const r = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${run_id}/jobs`, token)
    if (!r.ok) return []
    const { jobs = [] } = await r.json()
    return jobs[0]?.steps ?? []
  } catch { return [] }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function buildTokenHTML(c) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Token 管理 · ${c.SITE_TITLE}</title>
<style>
:root{--bg:#F2F2F7;--surface:rgba(255,255,255,0.82);--border:rgba(0,0,0,0.08);--shadow:0 8px 32px rgba(0,0,0,0.12);--text-1:#1C1C1E;--text-2:#48484A;--text-3:#8E8E93;--accent:#1C1C1E;--accent-fg:#fff;--green:#34C759;--red:#FF3B30;--blue:#007AFF;--blur:blur(24px) saturate(160%);}
@media(prefers-color-scheme:dark){:root{--bg:#1C1C1E;--surface:rgba(44,44,46,0.88);--border:rgba(255,255,255,0.08);--text-1:#F2F2F7;--text-2:#AEAEB2;--text-3:#636366;--accent:#F2F2F7;--accent-fg:#1C1C1E;}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,"SF Pro Text","Inter",system-ui,sans-serif;background:var(--bg);color:var(--text-1);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;}
.card{width:100%;max-width:580px;background:var(--surface);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow);padding:28px;}
h1{font-size:16px;font-weight:700;margin-bottom:20px;}
input{flex:1;padding:9px 12px;background:rgba(0,0,0,0.04);border:1px solid var(--border);border-radius:10px;font-size:13px;font-family:inherit;color:var(--text-1);outline:none;min-width:0;width:100%;}
@media(prefers-color-scheme:dark){input{background:rgba(255,255,255,0.06);}}
input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,122,255,0.15);}
input::placeholder{color:var(--text-3);}
.btn{padding:9px 16px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:10px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;transition:opacity .2s;flex-shrink:0;}
.btn:hover{opacity:.85;}
.btn.danger{background:var(--red);color:#fff;}
.sep{height:1px;background:var(--border);margin:20px 0;}
.field-label{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;display:block;}
.add-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;}
.add-full{grid-column:1/-1;}
.msg{font-size:12px;padding:8px 12px;border-radius:8px;margin-top:8px;display:none;}
.msg.ok{background:rgba(52,199,89,0.12);color:var(--green);display:block;}
.msg.err{background:rgba(255,59,48,0.10);color:var(--red);display:block;}
.token-list{display:flex;flex-direction:column;gap:6px;}
.token-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:rgba(0,0,0,0.02);}
@media(prefers-color-scheme:dark){.token-item{background:rgba(255,255,255,0.02);}}
.token-info{flex:1;min-width:0;}
.token-label{font-size:13px;font-weight:600;}
.token-repo{font-size:12px;color:var(--blue);margin-top:1px;}
.token-val{font-size:11px;color:var(--text-3);font-family:"SF Mono","Consolas",monospace;margin-top:2px;}
.token-time{font-size:11px;color:var(--text-3);}
.empty{text-align:center;padding:24px;color:var(--text-3);font-size:13px;}
.count-badge{font-size:11px;font-weight:600;padding:1px 8px;border-radius:6px;background:rgba(0,122,255,0.12);color:var(--blue);margin-left:8px;}
</style>
</head>
<body>
<div class="card">
  <h1>Token 管理</h1>
  <label class="field-label">添加 Token</label>
  <div class="add-grid">
    <input class="add-full" type="text" id="newToken" placeholder="GitHub Token（ghp_xxxx 或 github_pat_xxxx）" autocomplete="off"/>
    <input type="text" id="newRepo" placeholder="仓库（username/repo-name）"/>
    <input type="text" id="newLabel" placeholder="备注名（可选）"/>
  </div>
  <button class="btn" style="width:100%" onclick="addToken()">验证并添加</button>
  <div class="msg" id="addMsg"></div>
  <div class="sep"></div>
  <div style="display:flex;align-items:center;margin-bottom:12px;">
    <label class="field-label" style="margin:0">已有 Token</label>
    <span class="count-badge" id="tokenCount">0</span>
  </div>
  <div class="token-list" id="tokenList"><div class="empty">加载中…</div></div>
</div>
<script>
function showMsg(id,text,type){const el=document.getElementById(id);el.textContent=text;el.className='msg '+type;setTimeout(()=>{el.className='msg';el.textContent=''},5000)}
function formatTime(iso){if(!iso)return'';const d=new Date(iso);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
async function loadTokens(){const r=await fetch('/token/list');renderTokens((await r.json()).tokens)}
function renderTokens(tokens){
  document.getElementById('tokenCount').textContent=tokens.length
  const list=document.getElementById('tokenList')
  if(!tokens.length){list.innerHTML='<div class="empty">暂无 Token，请添加</div>';return}
  list.innerHTML=tokens.map(t=>'<div class="token-item"><div class="token-info"><div class="token-label">'+esc(t.label||'未命名')+'</div><div class="token-repo">'+esc(t.repo)+'</div><div class="token-val">'+esc(t.token)+'</div><div class="token-time">'+formatTime(t.added_at)+'</div></div><button class="btn danger" onclick="deleteToken('+t.id+')">删除</button></div>').join('')
}
async function addToken(){
  const token=document.getElementById('newToken').value.trim()
  const repo=document.getElementById('newRepo').value.trim()
  const label=document.getElementById('newLabel').value.trim()
  if(!token){showMsg('addMsg','请输入 Token','err');return}
  if(!repo||!repo.includes('/')){showMsg('addMsg','请输入正确的仓库名，如 username/repo-name','err');return}
  const btn=document.querySelector('button[onclick="addToken()"]')
  btn.textContent='验证中…';btn.disabled=true
  try{
    const r=await fetch('/token/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,repo,label})})
    const d=await r.json()
    if(d.error){showMsg('addMsg',d.error,'err')}
    else{showMsg('addMsg','✓ 添加成功！用户: '+d.login+'，仓库: '+d.repo,'ok');document.getElementById('newToken').value='';document.getElementById('newRepo').value='';document.getElementById('newLabel').value='';loadTokens()}
  }catch(e){showMsg('addMsg','网络错误: '+e.message,'err')}
  finally{btn.textContent='验证并添加';btn.disabled=false}
}
async function deleteToken(id){if(!confirm('确认删除这个 Token？'))return;const r=await fetch('/token/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});if((await r.json()).ok)loadTokens()}
loadTokens()
</script>
</body>
</html>`
}

function buildHTML(c) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${c.SITE_TITLE} · ${c.SITE_SUBTITLE}</title>
<style>
:root{--bg:#F2F2F7;--surface:rgba(255,255,255,0.72);--surface-hov:rgba(255,255,255,0.88);--border:rgba(0,0,0,0.08);--shadow-md:0 8px 32px rgba(0,0,0,0.12);--shadow-in:inset 0 1px 0 rgba(255,255,255,0.8);--text-1:#1C1C1E;--text-2:#48484A;--text-3:#8E8E93;--accent:#1C1C1E;--accent-fg:#FFFFFF;--green:#34C759;--red:#FF3B30;--blue:#007AFF;--blur:blur(24px) saturate(160%);--radius-card:22px;--radius-btn:14px;--radius-input:12px;--ease:cubic-bezier(0.4,0,0.2,1);}
@media(prefers-color-scheme:dark){:root{--bg:#1C1C1E;--surface:rgba(44,44,46,0.82);--surface-hov:rgba(58,58,60,0.90);--border:rgba(255,255,255,0.08);--shadow-md:0 8px 32px rgba(0,0,0,0.45);--shadow-in:inset 0 1px 0 rgba(255,255,255,0.06);--text-1:#F2F2F7;--text-2:#AEAEB2;--text-3:#636366;--accent:#F2F2F7;--accent-fg:#1C1C1E;}}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,"SF Pro Text","Inter",system-ui,sans-serif;background:var(--bg);color:var(--text-1);min-height:100vh;line-height:1.6;overflow-x:hidden;}
nav{position:fixed;top:0;left:0;right:0;z-index:200;display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:52px;background:var(--surface);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border-bottom:1px solid var(--border);}
.nav-logo{font-size:15px;font-weight:700;letter-spacing:-.3px;}
.nav-logo b{font-weight:800;}
.nav-right{display:flex;align-items:center;gap:8px;}
.nav-tag{font-size:11px;font-weight:500;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:2px 8px;}
.nav-history{font-size:11px;font-weight:500;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:2px 8px;cursor:pointer;background:none;font-family:inherit;transition:background .15s,color .15s;display:flex;align-items:center;gap:5px;}
.nav-history:hover{background:var(--surface-hov);color:var(--text-2);}
.ico-hist{width:12px;height:9px;display:flex;flex-direction:column;justify-content:space-between;flex-shrink:0;}
.ico-hist i{display:block;height:1.5px;border-radius:1px;background:currentColor;}
.ico-hist i:nth-child(2){width:70%;}
.ico-hist i:nth-child(3){width:50%;}
.page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:80px 16px 48px;}
.card{width:100%;max-width:520px;background:var(--surface);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--border);border-radius:var(--radius-card);box-shadow:var(--shadow-md),var(--shadow-in);padding:32px;}
.field{margin-bottom:16px;}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;}
.field-label{font-size:11px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--text-3);margin-bottom:6px;display:block;}
input[type=text],input[type=url]{width:100%;padding:11px 14px;background:rgba(0,0,0,0.04);border:1px solid var(--border);border-radius:var(--radius-input);font-size:14px;font-family:inherit;color:var(--text-1);outline:none;transition:border-color .2s,box-shadow .2s;}
@media(prefers-color-scheme:dark){input[type=text],input[type=url]{background:rgba(255,255,255,0.05);}}
input::placeholder{color:var(--text-3);}
input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(0,122,255,0.15);}
.sep{height:1px;background:var(--border);margin:20px 0;}
#iconPreviewWrap{display:none;align-items:center;gap:10px;margin-top:10px;}
#iconPreview{width:40px;height:40px;border-radius:8px;object-fit:cover;border:1px solid var(--border);}
#iconPreviewLabel{font-size:12px;color:var(--text-3);}
.btn-submit{position:relative;overflow:hidden;width:100%;padding:13px 24px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--radius-btn);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .2s,transform .15s;box-shadow:0 2px 12px rgba(0,0,0,0.18);}
.btn-submit:hover{opacity:.88;}
.btn-submit:active{transform:scale(0.985);}
.btn-submit:disabled{opacity:.45;cursor:not-allowed;}
.ico-bolt{width:14px;height:14px;position:relative;flex-shrink:0;}
.ico-bolt::before{content:"";position:absolute;left:4px;top:0;border-left:5px solid transparent;border-right:3px solid transparent;border-bottom:8px solid currentColor;}
.ico-bolt::after{content:"";position:absolute;left:3px;top:6px;border-left:3px solid transparent;border-right:5px solid transparent;border-top:8px solid currentColor;}
.ripple{position:absolute;border-radius:50%;background:rgba(255,255,255,0.25);transform:scale(0);pointer-events:none;animation:ripple .5s var(--ease) forwards;}
@keyframes ripple{to{transform:scale(4);opacity:0;}}
.status-wrap{display:none;margin-top:16px;}
.status-wrap.show{display:block;animation:fadeUp .35s var(--ease);}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
.status-top{display:flex;align-items:center;gap:12px;padding:16px;background:rgba(0,0,0,0.03);border:1px solid var(--border);border-radius:14px;margin-bottom:12px;}
@media(prefers-color-scheme:dark){.status-top{background:rgba(255,255,255,0.04);}}
.ico-spin{width:16px;height:16px;border-radius:50%;flex-shrink:0;border:2px solid var(--border);border-top-color:var(--text-2);animation:spin 0.8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
.ico-spin.done{animation:none;border:none;background:var(--green);position:relative;}
.ico-spin.done::after{content:"";position:absolute;left:50%;top:50%;width:5px;height:8px;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:translate(-60%,-65%) rotate(45deg);}
.ico-spin.fail{animation:none;border:none;background:var(--red);position:relative;}
.ico-spin.fail::before,.ico-spin.fail::after{content:"";position:absolute;width:8px;height:2px;background:#fff;border-radius:1px;top:50%;left:50%;}
.ico-spin.fail::before{transform:translate(-50%,-50%) rotate(45deg);}
.ico-spin.fail::after{transform:translate(-50%,-50%) rotate(-45deg);}
.status-info{flex:1;min-width:0;}
.status-title{font-size:13px;font-weight:600;}
.status-sub{font-size:12px;color:var(--text-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.progress-bar{height:2px;border-radius:99px;background:var(--border);overflow:hidden;margin-top:10px;}
.progress-fill{height:100%;border-radius:99px;background:var(--text-2);width:0%;transition:width .7s var(--ease);}
.steps{display:flex;flex-direction:column;gap:4px;margin-bottom:12px;}
.step{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px;font-size:12px;color:var(--text-3);}
.step.active{background:rgba(0,0,0,0.04);color:var(--text-1);font-weight:600;}
@media(prefers-color-scheme:dark){.step.active{background:rgba(255,255,255,0.06);}}
.step-name{flex:1;}
.step-dur{font-size:11px;color:var(--text-3);}
.si{width:14px;height:14px;flex-shrink:0;position:relative;}
.si-pending{border:1.5px solid var(--border);border-radius:50%;}
.si-running{border:1.5px solid var(--border);border-radius:50%;border-top-color:var(--text-2);animation:spin .8s linear infinite;}
.si-success{background:var(--green);border-radius:50%;}
.si-success::after{content:"";position:absolute;left:50%;top:50%;width:4px;height:6px;border-right:1.5px solid #fff;border-bottom:1.5px solid #fff;transform:translate(-60%,-60%) rotate(45deg);}
.si-failure{background:var(--red);border-radius:50%;}
.si-failure::before,.si-failure::after{content:"";position:absolute;width:7px;height:1.5px;background:#fff;border-radius:1px;top:50%;left:50%;}
.si-failure::before{transform:translate(-50%,-50%) rotate(45deg);}
.si-failure::after{transform:translate(-50%,-50%) rotate(-45deg);}
.si-skipped{border:1.5px solid var(--border);border-radius:50%;}
.si-skipped::after{content:"";position:absolute;width:6px;height:1.5px;background:var(--text-3);border-radius:1px;top:50%;left:50%;transform:translate(-50%,-50%);}
.log-wrap{border:1px solid var(--border);border-radius:12px;overflow:hidden;}
.log-bar{display:none;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(0,0,0,0.03);border-bottom:1px solid var(--border);}
@media(prefers-color-scheme:dark){.log-bar{background:rgba(255,255,255,0.03);}}
.log-bar.show{display:flex;}
.log-bar-title{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--text-3);}
.ico-refresh{width:13px;height:13px;position:relative;cursor:pointer;flex-shrink:0;border:1.5px solid var(--text-3);border-radius:50%;border-right-color:transparent;transition:transform .3s;}
.ico-refresh:hover{transform:rotate(180deg);}
.ico-refresh::after{content:"";position:absolute;right:-2px;top:-2px;border-left:3px solid transparent;border-right:3px solid transparent;border-bottom:4px solid var(--text-3);transform:rotate(30deg);}
.log-panel{max-height:260px;overflow-y:auto;padding:12px 14px;background:rgba(0,0,0,0.02);display:none;}
@media(prefers-color-scheme:dark){.log-panel{background:rgba(0,0,0,0.2);}}
.log-panel.show{display:block;}
.log-panel pre{font-family:"SF Mono","Fira Code","Consolas",monospace;font-size:11px;line-height:1.7;color:var(--text-2);white-space:pre-wrap;word-break:break-all;margin:0;}
.lerr{color:var(--red)!important;}.lwarn{color:#FF9500!important;}.lok{color:var(--green)!important;}
.btn-dl{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:12px;padding:12px 24px;background:var(--accent);color:var(--accent-fg);border:none;border-radius:var(--radius-btn);font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;transition:opacity .2s;box-shadow:0 2px 12px rgba(0,0,0,0.18);}
.btn-dl:hover{opacity:.88;}
.ico-dl{width:14px;height:14px;position:relative;flex-shrink:0;}
.ico-dl::before{content:"";position:absolute;left:4px;top:0;width:6px;height:8px;border-left:2px solid currentColor;border-right:2px solid currentColor;}
.ico-dl::after{content:"";position:absolute;left:2px;top:6px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid currentColor;}
.modal-overlay{display:none;position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.4);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px;}
.modal-overlay.show{display:flex;animation:fadeIn .2s var(--ease);}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
.modal{width:100%;max-width:640px;max-height:80vh;background:var(--surface);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border:1px solid var(--border);border-radius:var(--radius-card);box-shadow:var(--shadow-md);display:flex;flex-direction:column;animation:slideUp .25s var(--ease);}
@keyframes slideUp{from{transform:translateY(20px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--border);flex-shrink:0;}
.modal-head h2{font-size:15px;font-weight:700;}
.modal-close{width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,0.06);border:none;cursor:pointer;position:relative;}
@media(prefers-color-scheme:dark){.modal-close{background:rgba(255,255,255,0.08);}}
.modal-close::before,.modal-close::after{content:"";position:absolute;width:10px;height:1.5px;background:var(--text-2);border-radius:1px;top:50%;left:50%;}
.modal-close::before{transform:translate(-50%,-50%) rotate(45deg);}
.modal-close::after{transform:translate(-50%,-50%) rotate(-45deg);}
.modal-body{overflow-y:auto;padding:16px 24px;flex:1;}
.history-empty{text-align:center;padding:40px;color:var(--text-3);font-size:13px;}
.history-item{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;border:1px solid var(--border);margin-bottom:8px;background:rgba(0,0,0,0.02);}
@media(prefers-color-scheme:dark){.history-item{background:rgba(255,255,255,0.02);}}
.history-icon-img{width:36px;height:36px;border-radius:8px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;}
.history-icon-ph{width:36px;height:36px;border-radius:8px;border:1px solid var(--border);flex-shrink:0;background:rgba(0,0,0,0.04);display:flex;align-items:center;justify-content:center;}
.history-icon-ph::after{content:"";width:18px;height:18px;border-radius:4px;border:2px solid var(--text-3);}
.history-info{flex:1;min-width:0;}
.history-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.history-url{font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}
.history-meta{display:flex;align-items:center;gap:6px;margin-top:4px;}
.history-time{font-size:11px;color:var(--text-3);}
.history-badge{font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.4px;}
.badge-success{background:rgba(52,199,89,0.15);color:var(--green);}
.badge-failed{background:rgba(255,59,48,0.12);color:var(--red);}
.badge-pending,.badge-building{background:rgba(0,122,255,0.12);color:var(--blue);}
.history-actions{display:flex;gap:6px;flex-shrink:0;}
.hist-btn{font-size:11px;font-weight:600;padding:4px 10px;border-radius:7px;border:1px solid var(--border);background:none;cursor:pointer;color:var(--text-2);font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;}
.hist-btn:hover{background:rgba(0,0,0,0.06);}
@media(max-width:520px){.card{padding:20px 16px;}.field-row{grid-template-columns:1fr;}nav{padding:0 16px;}}
</style>
</head>
<body>
<nav>
  <div class="nav-logo"><b>${c.SITE_TITLE}</b> · ${c.SITE_SUBTITLE}</div>
  <div class="nav-right">
    <button class="nav-history" id="historyBtn"><div class="ico-hist"><i></i><i></i><i></i></div>历史记录</button>
    <div class="nav-tag">By ZSFan</div>
  </div>
</nav>
<div class="modal-overlay" id="historyModal">
  <div class="modal">
    <div class="modal-head"><h2>构建历史</h2><button class="modal-close" id="modalClose"></button></div>
    <div class="modal-body" id="historyBody"></div>
  </div>
</div>
<div class="page">
  <div class="card">
    <form id="buildForm">
      <div class="field">
        <label class="field-label">目标网址</label>
        <input type="url" id="url" placeholder="https://example.com" required autocomplete="off"/>
      </div>
      <div class="field-row">
        <div><label class="field-label">应用名称</label><input type="text" id="appName" placeholder="MyApp" required/></div>
        <div><label class="field-label">版本号</label><input type="text" id="version" placeholder="1.0.0" value="${c.DEFAULT_VERSION}" required/></div>
      </div>
      <div class="sep"></div>
      <div class="field">
        <label class="field-label">应用图标 URL（可选）</label>
        <input type="url" id="iconUrl" placeholder="https://example.com/icon.png" autocomplete="off"/>
        <div id="iconPreviewWrap"><img id="iconPreview" src="" alt=""/><span id="iconPreviewLabel">预览加载中…</span></div>
      </div>
      <div class="sep"></div>
      <button type="submit" class="btn-submit" id="submitBtn"><span class="ico-bolt"></span>开始打包</button>
    </form>
    <div class="status-wrap" id="statusWrap">
      <div class="status-top">
        <div class="ico-spin" id="statusIco"></div>
        <div class="status-info">
          <div class="status-title" id="statusTitle">构建中，请稍候…</div>
          <div class="status-sub" id="statusSub">GitHub Actions 正在编译</div>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="steps" id="stepsList"></div>
      <div class="log-wrap">
        <div class="log-bar" id="logBar"><span class="log-bar-title">构建日志</span><div class="ico-refresh" id="logRefresh"></div></div>
        <div class="log-panel" id="logPanel"><pre id="logContent">日志加载中…</pre></div>
      </div>
    </div>
  </div>
</div>
<script>
const POLL_START=${c.POLL_START_DELAY},POLL_INTERVAL=${c.POLL_INTERVAL}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function formatTime(iso){if(!iso)return'';const d=new Date(iso);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}
function onIconErr(img){img.style.display='none';if(img.nextSibling)img.nextSibling.style.display='flex'}
let previewTimer=null
document.getElementById('iconUrl').addEventListener('input',function(){
  clearTimeout(previewTimer);const val=this.value.trim(),wrap=document.getElementById('iconPreviewWrap')
  if(!val){wrap.style.display='none';return}
  previewTimer=setTimeout(()=>{wrap.style.display='flex';const lbl=document.getElementById('iconPreviewLabel'),img=document.getElementById('iconPreview');lbl.textContent='预览加载中…';img.onload=()=>{lbl.textContent='图标有效'};img.onerror=()=>{lbl.textContent='无法加载，请检查 URL'};img.src=val},600)
})
document.getElementById('submitBtn').addEventListener('click',e=>{
  const btn=e.currentTarget,r=document.createElement('span'),d=Math.max(btn.offsetWidth,btn.offsetHeight),rect=btn.getBoundingClientRect()
  r.className='ripple';r.style.cssText='width:'+d+'px;height:'+d+'px;left:'+(e.clientX-rect.left-d/2)+'px;top:'+(e.clientY-rect.top-d/2)+'px;'
  btn.appendChild(r);r.addEventListener('animationend',()=>r.remove())
})
function badgeHtml(s){const m={success:'badge-success',failed:'badge-failed',building:'badge-building',pending:'badge-pending'},l={success:'成功',failed:'失败',building:'构建中',pending:'等待'};return'<span class="history-badge '+(m[s]||'badge-pending')+'">'+(l[s]||s)+'</span>'}
async function loadHistory(){
  const body=document.getElementById('historyBody');body.innerHTML='<div class="history-empty">加载中…</div>'
  try{
    const{records=[]}=await(await fetch('/history')).json()
    if(!records.length){body.innerHTML='<div class="history-empty">暂无构建记录</div>';return}
    body.innerHTML=records.map(rec=>{
      const ico=rec.icon_url?'<img class="history-icon-img" src="'+esc(rec.icon_url)+'" onerror="onIconErr(this)" alt=""/><div class="history-icon-ph" style="display:none"></div>':'<div class="history-icon-ph"></div>'
      const dl=rec.download_ready?'<a class="hist-btn" href="/download/'+rec.id+'">下载</a>':''
      return'<div class="history-item">'+ico+'<div class="history-info"><div class="history-name">'+esc(rec.app_name)+' <small style="font-weight:400;color:var(--text-3)">v'+esc(rec.version)+'</small></div><div class="history-url">'+esc(rec.url)+'</div><div class="history-meta">'+badgeHtml(rec.status)+'<span class="history-time">'+formatTime(rec.created_at)+'</span></div></div><div class="history-actions">'+dl+'</div></div>'
    }).join('')
  }catch(e){body.innerHTML='<div class="history-empty">加载失败: '+e.message+'</div>'}
}
document.getElementById('historyBtn').addEventListener('click',()=>{document.getElementById('historyModal').classList.add('show');loadHistory()})
document.getElementById('modalClose').addEventListener('click',()=>{document.getElementById('historyModal').classList.remove('show')})
document.getElementById('historyModal').addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.classList.remove('show')})
let currentRunId=null,currentRepo=null
document.getElementById('logRefresh').addEventListener('click',()=>{if(currentRunId&&currentRepo)fetchLogs(currentRunId,currentRepo)})
async function fetchLogs(run_id,repo){
  const pre=document.getElementById('logContent')
  try{
    const d=await(await fetch('/logs/'+run_id+'?repo='+encodeURIComponent(repo))).json()
    const colored=d.logs.split('\\n').map(l=>{const e=l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');if(/error|fail|fatal/i.test(l))return'<span class="lerr">'+e+'</span>';if(/warn/i.test(l))return'<span class="lwarn">'+e+'</span>';if(/success|done/i.test(l))return'<span class="lok">'+e+'</span>';return e}).join('\\n')
    pre.innerHTML=colored;const panel=document.getElementById('logPanel');panel.scrollTop=panel.scrollHeight
  }catch(e){pre.textContent='日志加载失败: '+e.message}
}
function showLog(run_id,repo){currentRunId=run_id;currentRepo=repo;document.getElementById('logBar').classList.add('show');document.getElementById('logPanel').classList.add('show');fetchLogs(run_id,repo)}
function stepIconClass(s){if(s.status==='in_progress')return'si si-running';if(s.conclusion==='success')return'si si-success';if(s.conclusion==='failure')return'si si-failure';if(s.conclusion==='skipped')return'si si-skipped';return'si si-pending'}
function renderSteps(steps){
  const list=document.getElementById('stepsList')
  if(!steps||!steps.length){list.innerHTML='';return}
  list.innerHTML=steps.filter(s=>s.name!=='Set up job'&&s.name!=='Complete job').map(s=>{
    const cls=s.status==='in_progress'?'step active':s.conclusion==='success'?'step done':'step'
    const dur=s.completed_at&&s.started_at?Math.round((new Date(s.completed_at)-new Date(s.started_at))/1000)+'s':s.status==='in_progress'?'进行中':''
    return'<div class="'+cls+'"><div class="'+stepIconClass(s)+'"></div><span class="step-name">'+s.name+'</span>'+(dur?'<span class="step-dur">'+dur+'</span>':'')+'</div>'
  }).join('')
}
function startPoll(task_id,triggered_at,repo){
  const fill=document.getElementById('progressFill'),subEl=document.getElementById('statusSub'),ico=document.getElementById('statusIco'),title=document.getElementById('statusTitle'),wrap=document.getElementById('statusWrap'),btn=document.getElementById('submitBtn')
  let curProg=5,finished=false,logTimer=null
  function startLogTimer(){if(logTimer)return;logTimer=setInterval(()=>{if(currentRunId&&currentRepo)fetchLogs(currentRunId,currentRepo)},4000)}
  function stopLogTimer(){if(logTimer){clearInterval(logTimer);logTimer=null}}
  const poll=async()=>{
    if(finished)return
    try{
      const d=await(await fetch('/status/'+task_id+'?t='+encodeURIComponent(triggered_at)+'&repo='+encodeURIComponent(repo))).json()
      if(d.progress>curProg){curProg=d.progress;fill.style.width=curProg+'%'}
      if(d.step)subEl.textContent=d.step
      if(d.steps)renderSteps(d.steps)
      if(d.run_id){if(!currentRunId){showLog(d.run_id,repo);startLogTimer()}else currentRunId=d.run_id}
      if(d.ready){
        finished=true;stopLogTimer();fill.style.width='100%';ico.className='ico-spin done';title.textContent='构建完成';subEl.textContent='点击下载'
        if(d.steps)renderSteps(d.steps);if(d.run_id)fetchLogs(d.run_id,repo)
        const dl=document.createElement('a');dl.href='/download/'+task_id;dl.download=task_id+'.zip';dl.className='btn-dl';dl.innerHTML='<div class="ico-dl"></div>下载 ZIP（内含 EXE）'
        wrap.appendChild(dl);btn.disabled=false;btn.innerHTML='<span class="ico-bolt"></span>打包新应用'
      }else if(d.status==='failed'){
        finished=true;stopLogTimer();ico.className='ico-spin fail';title.textContent='构建失败';subEl.textContent='查看下方日志了解详情'
        if(d.steps)renderSteps(d.steps);if(d.run_id)fetchLogs(d.run_id,repo);btn.disabled=false;btn.innerHTML='<span class="ico-bolt"></span>重新打包'
      }else{setTimeout(poll,POLL_INTERVAL)}
    }catch(err){subEl.textContent='网络错误，重试中…';setTimeout(poll,POLL_INTERVAL)}
  }
  setTimeout(poll,POLL_START)
}
document.getElementById('buildForm').addEventListener('submit',async e=>{
  e.preventDefault()
  const url=document.getElementById('url').value,appName=document.getElementById('appName').value,version=document.getElementById('version').value,iconUrl=document.getElementById('iconUrl').value.trim()
  const btn=document.getElementById('submitBtn');btn.disabled=true;btn.innerHTML='提交中…'
  try{
    const res=await fetch('/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,appName,version,iconUrl})})
    const{task_id,triggered_at,repo,error}=await res.json()
    if(error)throw new Error(error)
    document.getElementById('statusWrap').classList.add('show');btn.innerHTML='已提交';startPoll(task_id,triggered_at,repo)
  }catch(err){
    btn.disabled=false;btn.innerHTML='<span class="ico-bolt"></span>开始打包'
    document.getElementById('statusTitle').textContent='提交失败';document.getElementById('statusSub').textContent=err.message;document.getElementById('statusWrap').classList.add('show')
  }
})
</script>
</body>
</html>`
}
