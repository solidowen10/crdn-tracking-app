require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const compression = require('compression');
const {
  db,
  init,
  logActivity,
  nextJobNo,
  normalizeStage,
  stageProgress,
  PIPELINE_STAGES,
  DEFAULT_CATEGORIES
} = require('./db');
const {
  googleSheetsStatus,
  testGoogleSheetsConnection,
  syncGoogleSheets
} = require('./sheetsSync');

init();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || 'https://tool.creativeden.studio';
const CALLBACK_URL = process.env.LINE_CALLBACK_URL || `${BASE_URL}/auth/callback`;
const allowedLineIds = new Set((process.env.ALLOWED_LINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

const PART_STATUSES = ['Not Needed', 'Need to Order', 'Ordered', 'Arrived', 'Installed', 'Backordered', 'Cancelled'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: './data' }),
  name: 'crdn.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value, fallback = 0) {
  return Math.round(number(value, fallback));
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function dateOnly(value) {
  const v = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function getUser(lineUserId) {
  return db.prepare('SELECT * FROM users WHERE line_user_id=?').get(lineUserId);
}

function hydrateSessionUser(req) {
  if (!req.session.user) return null;
  const user = getUser(req.session.user.userId);
  if (!user || !['admin', 'member'].includes(user.role)) return null;
  req.session.user = {
    userId: user.line_user_id,
    displayName: user.display_name || req.session.user.displayName || 'LINE User',
    role: user.role
  };
  return req.session.user;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!hydrateSessionUser(req)) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'Access is pending admin approval' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !hydrateSessionUser(req) || req.session.user.role !== 'admin') {
    if (req.session.user) req.session.destroy(() => {});
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requirePageAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (!hydrateSessionUser(req)) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  next();
}

function actor(req) {
  return req.session.user || {};
}

function activity(req, projectId, action, oldValue = null, newValue = null) {
  const user = actor(req);
  logActivity(projectId, user.userId || null, user.displayName || null, action, oldValue, newValue);
}

function getProject(id, includeArchived = false) {
  const sql = includeArchived
    ? 'SELECT * FROM vehicles WHERE id=?'
    : 'SELECT * FROM vehicles WHERE id=? AND archived=0';
  return db.prepare(sql).get(Number(id));
}

function requireProject(id, includeArchived = false) {
  const project = getProject(id, includeArchived);
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  return project;
}

function nextSort(table, vehicleId) {
  const row = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ${table} WHERE vehicle_id=?`).get(vehicleId);
  return row.next;
}

function quoteRows(vehicleId) {
  return db.prepare('SELECT * FROM quote_items WHERE vehicle_id=? AND active=1 ORDER BY sort_order, id').all(vehicleId);
}

function quoteTotals(vehicleId) {
  const rows = quoteRows(vehicleId);
  return rows.reduce((acc, row) => {
    const qty = number(row.quantity, 1);
    const customer = qty * int(row.customer_price);
    const cost = qty * int(row.internal_cost);
    acc.customer += customer;
    acc.cost += cost;
    acc.profit += customer - cost;
    acc.count += 1;
    return acc;
  }, { customer: 0, cost: 0, profit: 0, count: 0 });
}

function projectPartsStatus(vehicleId) {
  const activeParts = db.prepare('SELECT status, COUNT(*) AS count FROM parts WHERE vehicle_id=? AND active=1 GROUP BY status').all(vehicleId);
  if (activeParts.length) {
    if (activeParts.some(p => p.status === 'Backordered')) return 'Backordered';
    if (activeParts.some(p => p.status === 'Need to Order')) return 'Need to Order';
    if (activeParts.some(p => p.status === 'Ordered')) return 'Ordered';
    if (activeParts.some(p => p.status === 'Arrived')) return 'Arrived';
    if (activeParts.every(p => ['Installed', 'Not Needed', 'Cancelled'].includes(p.status))) return 'Installed';
    return activeParts[0].status;
  }
  const quoteNeed = db.prepare("SELECT COUNT(*) AS count FROM quote_items WHERE vehicle_id=? AND active=1 AND need_order=1").get(vehicleId).count;
  return quoteNeed ? 'Need to Order' : 'Not Needed';
}

function projectSummary(row) {
  const totals = quoteTotals(row.id);
  const stage = normalizeStage(row.stage);
  return {
    ...row,
    stage,
    progress: stageProgress(stage),
    quote_total: totals.customer,
    cashflow_json: row.cashflow_json || '',
    quote_cost: totals.cost,
    quote_profit: totals.profit,
    quote_count: totals.count,
    parts_status: projectPartsStatus(row.id),
    next_action: row.next_action || row.customer_action || row.customer_update || row.notes || ''
  };
}

function dashboardRows(filter = 'All') {
  const includeArchived = filter === 'Archived';
  const rows = db.prepare(`SELECT * FROM vehicles ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY updated_at DESC, id DESC`).all()
    .map(projectSummary);
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter(project => {
    if (filter === 'All') return true;
    if (filter === 'Active') return !['13 Delivered', '14 Archived'].includes(project.stage) && !project.archived;
    if (filter === 'Waiting Approval') return project.stage === '04 Waiting Approval';
    if (filter === 'Parts Ordering') return ['07 Parts Ordering', '08 Parts Arrived'].includes(project.stage);
    if (filter === 'Building') return ['09 Building', '10 Installation', '11 QC'].includes(project.stage);
    if (filter === 'Overdue') return project.finish_date && project.finish_date < today && !['13 Delivered', '14 Archived'].includes(project.stage);
    if (filter === 'Delivered') return project.stage === '13 Delivered';
    if (filter === 'Archived') return project.archived || project.stage === '14 Archived';
    return true;
  });
}

function dashboardSummary(rows) {
  const today = new Date();
  const week = new Date(today);
  week.setDate(today.getDate() + 7);
  const todayStr = today.toISOString().slice(0, 10);
  const weekStr = week.toISOString().slice(0, 10);
  return {
    active_projects: rows.filter(p => !['13 Delivered', '14 Archived'].includes(p.stage) && !p.archived).length,
    waiting_customer: rows.filter(p => p.stage === '04 Waiting Approval' || p.customer_action).length,
    waiting_parts: rows.filter(p => ['Need to Order', 'Ordered', 'Backordered'].includes(p.parts_status)).length,
    due_this_week: rows.filter(p => p.finish_date && p.finish_date >= todayStr && p.finish_date <= weekStr && !['13 Delivered', '14 Archived'].includes(p.stage)).length,
    total_quoted: rows.reduce((sum, p) => sum + Number(p.quote_total || 0), 0)
  };
}

function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).run(key, String(value || ''));
}

function syncErrorMessage(err) {
  return err?.message || 'Google Sheets sync failed';
}

function updateConsultationItemCostFromSubparts(itemId) {
  const item = db.prepare('SELECT * FROM consultation_items WHERE id=?').get(Number(itemId));
  if (!item) return null;
  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(cost), 0) AS total
    FROM consultation_subparts
    WHERE consultation_item_id=? AND active=1
  `).get(item.id);
  if (row.count > 0) {
    db.prepare('UPDATE consultation_items SET default_internal_cost=? WHERE id=?').run(int(row.total), item.id);
  }
  return db.prepare('SELECT * FROM consultation_items WHERE id=?').get(item.id);
}

function consultationSubpartsByItemIds(itemIds) {
  if (!itemIds.length) return new Map();
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT *
    FROM consultation_subparts
    WHERE active=1 AND consultation_item_id IN (${placeholders})
    ORDER BY consultation_item_id, sort_order, id
  `).all(...itemIds);
  const byItem = new Map();
  rows.forEach(row => {
    if (!byItem.has(row.consultation_item_id)) byItem.set(row.consultation_item_id, []);
    byItem.get(row.consultation_item_id).push(row);
  });
  return byItem;
}

function activatePartsAfterDeposit(vehicleId, req) {
  const rows = db.prepare(`
    SELECT * FROM quote_items
    WHERE vehicle_id=? AND active=1 AND need_order=1
  `).all(vehicleId);
  const existing = db.prepare('SELECT quote_item_id FROM parts WHERE vehicle_id=? AND active=1 AND quote_item_id IS NOT NULL').all(vehicleId)
    .map(row => row.quote_item_id);
  const existingIds = new Set(existing);
  const insert = db.prepare(`
    INSERT INTO parts (vehicle_id, quote_item_id, part_name, supplier, quantity, cost, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 'Need to Order', ?)
  `);
  const updateQuote = db.prepare("UPDATE quote_items SET parts_status='Need to Order', updated_at=CURRENT_TIMESTAMP WHERE id=?");
  let created = 0;
  const tx = db.transaction(() => {
    rows.forEach(row => {
      if (existingIds.has(row.id)) return;
      insert.run(vehicleId, row.id, row.description, row.supplier || '', number(row.quantity, 1), int(row.internal_cost) * number(row.quantity, 1), nextSort('parts', vehicleId));
      updateQuote.run(row.id);
      created += 1;
    });
  });
  tx();
  if (created > 0) activity(req, vehicleId, 'Parts ordering activated after deposit paid', null, `${created} part rows created`);
  return created;
}

function renderAccessPending(profile, role) {
  const disabled = role === 'disabled';
  const status = disabled ? 'Access disabled' : 'Waiting for admin approval';
  const body = disabled
    ? 'This LINE account has been disabled. Please contact an admin if this looks wrong.'
    : 'Your request has been sent to an admin. This page checks again every 15 seconds.';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><style>*{box-sizing:border-box}body{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8f8f5;color:#111110;min-height:100vh;display:grid;place-items:center;margin:0;padding:20px}.card{width:min(520px,100%);background:#fff;border:1px solid #e2e2de;border-radius:16px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.10)}.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}.brand img{width:42px;height:42px;border-radius:8px}.brand strong{font-size:18px;letter-spacing:.08em}.brand span{color:#ca741f}h1{font-size:24px;margin:0 0 10px}p{color:#6b6b68;line-height:1.6}.id{background:#f8f8f5;border:1px solid #e2e2de;padding:12px;border-radius:8px;overflow:auto;color:#111}.actions{display:flex;gap:10px;align-items:center;margin-top:18px;flex-wrap:wrap}.btn{border:1px solid #e2e2de;background:#fff;color:#111;padding:10px 14px;border-radius:8px;font-weight:700;cursor:pointer}.primary{background:#ca741f;border-color:#ca741f;color:#fff}.muted{font-size:13px;color:#8c8c89}</style></head><body><main class="card"><div class="brand"><img src="https://www.creativeden.studio/wp-content/uploads/2023/09/CRDN-Square.png" alt="Creative Den"><strong>CREATIVE DEN <span>STUDIO</span></strong></div><h1>${status}</h1><p>${escapeHtml(body)}</p><p>Your LINE user ID:</p><pre class="id">${escapeHtml(profile.userId)}</pre><div class="actions"><form method="post" action="/auth/logout"><button class="btn" type="submit">Logout</button></form>${disabled ? '' : '<button class="btn primary" type="button" onclick="checkNow()">Check again</button>'}<span class="muted" id="check-status"></span></div></main><script>async function checkNow(){const el=document.getElementById('check-status');try{el.textContent='Checking...';const r=await fetch('/auth/pending-status',{credentials:'include'});const data=await r.json();if(data.status==='approved'){location.href='/';return;}if(data.status==='disabled'){location.reload();return;}el.textContent='Still waiting';}catch(e){el.textContent='Cannot check right now';}}${disabled ? '' : 'setInterval(checkNow,15000);'}</script></body></html>`;
}

app.get('/health', (req, res) => res.json({ ok: true, app: 'crdn-tracking-app' }));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/line', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.lineOAuthState = state;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINE_CHANNEL_ID || '',
    redirect_uri: CALLBACK_URL,
    state,
    scope: 'profile openid'
  });
  res.redirect(`https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`LINE login error: ${error_description || error}`);
    if (!code || state !== req.session.lineOAuthState) return res.status(400).send('Invalid LINE login state. Please try again.');

    const tokenResponse = await axios.post('https://api.line.me/oauth2/v2.1/token', new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URL,
      client_id: process.env.LINE_CHANNEL_ID,
      client_secret: process.env.LINE_CHANNEL_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const profileResponse = await axios.get('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
    });

    const profile = profileResponse.data;
    const envAdmin = allowedLineIds.has(profile.userId);
    const existing = getUser(profile.userId);
    if (!existing) {
      db.prepare(`
        INSERT INTO users (line_user_id, display_name, role, last_login_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `).run(profile.userId, profile.displayName || 'LINE User', envAdmin ? 'admin' : 'pending');
    } else {
      db.prepare(`
        UPDATE users
        SET display_name=?, role=CASE WHEN ? THEN 'admin' ELSE role END, last_login_at=CURRENT_TIMESTAMP
        WHERE line_user_id=?
      `).run(profile.displayName || existing.display_name || 'LINE User', envAdmin ? 1 : 0, profile.userId);
    }

	    const user = getUser(profile.userId);
	    if (!['admin', 'member'].includes(user.role)) {
	      req.session.pendingLineUserId = profile.userId;
	      req.session.pendingDisplayName = profile.displayName || user.display_name || 'LINE User';
	      delete req.session.user;
	      delete req.session.lineOAuthState;
	      return res.status(403).send(renderAccessPending(profile, user.role));
	    }

	    req.session.user = { userId: profile.userId, displayName: profile.displayName || user.display_name || 'LINE User', role: user.role };
	    delete req.session.pendingLineUserId;
	    delete req.session.pendingDisplayName;
	    delete req.session.lineOAuthState;
	    res.redirect('/');
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).send('LINE authentication failed. Check channel ID, secret, and callback URL.');
  }
});

app.get('/auth/pending-status', (req, res) => {
  const lineUserId = req.session.pendingLineUserId || req.session.user?.userId;
  if (!lineUserId) return res.json({ status: 'unknown' });
  const user = getUser(lineUserId);
  if (!user) return res.json({ status: 'unknown' });
  if (['admin', 'member'].includes(user.role)) {
    req.session.user = {
      userId: user.line_user_id,
      displayName: user.display_name || req.session.pendingDisplayName || 'LINE User',
      role: user.role
    };
    delete req.session.pendingLineUserId;
    delete req.session.pendingDisplayName;
    return res.json({ status: 'approved', role: user.role });
  }
  if (user.role === 'disabled') {
    delete req.session.user;
    return res.json({ status: 'disabled', role: user.role });
  }
  res.json({ status: 'pending', role: user.role });
});

app.get('/auth/me', requireAuth, (req, res) => res.json(req.session.user));
app.post('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.use('/assets', express.static(path.join(__dirname, 'public')));

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({
    pipeline: PIPELINE_STAGES,
    priorities: PRIORITIES,
    part_statuses: PART_STATUSES,
    categories: setting('quote_categories', DEFAULT_CATEGORIES.join('\n')).split('\n').map(text).filter(Boolean),
    terms: setting('quote_terms'),
    user: req.session.user
  });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const rows = dashboardRows(text(req.query.filter) || 'All');
  const allRows = dashboardRows('All');
  res.json({ summary: dashboardSummary(allRows), projects: rows });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const owner = text(req.body.owner);
  const name = text(req.body.name || req.body.vehicle);
  if (!owner || !name) return res.status(400).json({ error: 'customer and vehicle are required' });
  const stage = normalizeStage(req.body.stage || '01 Intake');
  const result = db.prepare(`
    INSERT INTO vehicles (
      job_no, owner, name, plate, pkg, stage, designer, priority, progress,
      start_date, finish_date, customer_update, customer_action, next_action, notes, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    text(req.body.job_no) || nextJobNo(),
    owner,
    name,
    text(req.body.plate),
    text(req.body.pkg),
    stage,
    text(req.body.designer),
    text(req.body.priority) || 'Normal',
    stageProgress(stage),
    dateOnly(req.body.start_date),
    dateOnly(req.body.finish_date),
    text(req.body.customer_update),
    text(req.body.customer_action),
    text(req.body.next_action) || 'Run consultation checklist',
    text(req.body.notes),
    actor(req).userId
  );
  const project = projectSummary(db.prepare('SELECT * FROM vehicles WHERE id=?').get(result.lastInsertRowid));
  activity(req, project.id, 'project created', null, `${project.job_no} ${project.name}`);
  res.status(201).json(project);
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  res.json(projectSummary(requireProject(req.params.id, true)));
});

app.patch('/api/projects/:id', requireAuth, (req, res) => {
  const current = requireProject(req.params.id, true);
  const next = { ...current, ...req.body };
  const stage = normalizeStage(next.stage);
  const archived = stage === '14 Archived' || bool(next.archived) ? 1 : 0; 
  db.prepare(`
  UPDATE vehicles
  SET job_no=?,
      owner=?,
      name=?,
      plate=?,
      pkg=?,
      stage=?,
      designer=?,
      priority=?,
      progress=?,
      start_date=?,
      finish_date=?,
      customer_update=?,
      customer_action=?,
      next_action=?,
      notes=?,
      cashflow_json=?,
      archived=?,
      updated_at=CURRENT_TIMESTAMP
  WHERE id=?
`).run(
    text(next.job_no),
    text(next.owner),
    text(next.name),
    text(next.plate),
    text(next.pkg),
    stage,
    text(next.designer),
    text(next.priority) || 'Normal',
    stageProgress(stage),
    dateOnly(next.start_date),
    dateOnly(next.finish_date),
    text(next.customer_update),
    text(next.customer_action),
    text(next.next_action),
    text(next.notes),
    text(next.cashflow_json),
    archived,
    current.id
  );

  if (current.stage !== stage) {
    activity(req, current.id, 'stage changed', normalizeStage(current.stage), stage);
    if (stage === '05 Deposit Paid') activatePartsAfterDeposit(current.id, req);
  }
  if ((current.designer || '') !== text(next.designer)) activity(req, current.id, 'designer changed', current.designer || '', text(next.designer));
  if ((current.finish_date || '') !== dateOnly(next.finish_date)) activity(req, current.id, 'finish date changed', current.finish_date || '', dateOnly(next.finish_date));
  if (archived && !current.archived) activity(req, current.id, 'project archived', null, current.job_no || current.id);

  res.json(projectSummary(db.prepare('SELECT * FROM vehicles WHERE id=?').get(current.id)));
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  db.prepare("UPDATE vehicles SET stage='14 Archived', progress=100, archived=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(project.id);
  activity(req, project.id, 'project archived/deleted', null, project.job_no || project.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:id/permanent', requireAdmin, (req, res) => {
  const project = requireProject(req.params.id, true);
  db.prepare('DELETE FROM vehicles WHERE id=?').run(project.id);
  logActivity(null, actor(req).userId || null, actor(req).displayName || null, 'project permanently deleted', project.job_no || project.id, project.name || '');
  res.json({ ok: true });
});

app.get('/api/projects/:id/consultation', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const categories = db.prepare('SELECT * FROM consultation_categories WHERE active=1 ORDER BY sort_order, id').all();
  const items = db.prepare(`
    SELECT ci.*, cc.name AS category
    FROM consultation_items ci
    JOIN consultation_categories cc ON cc.id=ci.category_id
    WHERE ci.active=1
    ORDER BY cc.sort_order, ci.sort_order, ci.id
  `).all();
  const selected = db.prepare('SELECT * FROM quote_items WHERE vehicle_id=? AND consultation_item_id IS NOT NULL AND active=1').all(project.id);
  const selectedByItem = new Map(selected.map(row => [row.consultation_item_id, row]));
  res.json({
    project: projectSummary(project),
    categories: categories.map(category => ({
      ...category,
      items: items.filter(item => item.category_id === category.id).map(item => ({
        ...item,
        selected: selectedByItem.has(item.id),
        quote_item: selectedByItem.get(item.id) || null
      }))
    })),
    quote_total: quoteTotals(project.id).customer
  });
});

app.post('/api/projects/:id/consultation', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);

  console.log('CONSULTATION BODY:', JSON.stringify(req.body, null, 2));

  const checkedItemsRaw = req.body.checkedItems || [];

  const checkedItems = Array.isArray(checkedItemsRaw)
  ? checkedItemsRaw.map(String)
  : Object.keys(checkedItemsRaw)
      .filter(key => checkedItemsRaw[key])
      .map(String);

  const checkedSet = new Set(checkedItems);
  const itemQtys = req.body.itemQtys || {};
  const warnings = [];

  const items = db.prepare(`
    SELECT
      ci.id,
      ci.slug,
      ci.name,
      ci.description,
      ci.default_customer_price,
      ci.default_internal_cost,
      ci.supplier,
      ci.need_order,
      ci.sort_order,
      ci.active,
      cc.name AS category
    FROM consultation_items ci
    JOIN consultation_categories cc ON cc.id=ci.category_id
    WHERE ci.active=1
    ORDER BY cc.sort_order, ci.sort_order, ci.id
  `).all();

  for (const item of items) {
    const existing = db.prepare(
      'SELECT * FROM quote_items WHERE vehicle_id=? AND consultation_item_id=?'
    ).get(project.id, item.id);

    const selected =
      checkedSet.has(String(item.id)) ||
      checkedSet.has(String(item.slug));

    if (selected) {
      const qtyRaw = itemQtys[item.id] ?? itemQtys[String(item.id)] ?? existing?.quantity ?? 1;
      const qty = Math.max(0.01, number(qtyRaw, 1));
      const customerPrice = int(existing?.customer_price ?? item.default_customer_price);
      const internalCost = int(existing?.internal_cost ?? item.default_internal_cost);
      const supplier = text(existing?.supplier ?? item.supplier);
      const needOrder = !!item.need_order;
      const partsStatus = needOrder ? 'Need to Order' : 'Not Needed';

      if (existing) {
        db.prepare(`
          UPDATE quote_items
          SET category=?, description=?, quantity=?, customer_price=?, internal_cost=?, supplier=?,
              need_order=?, parts_status=?, active=1, updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(
          item.category,
          item.name,
          qty,
          customerPrice,
          internalCost,
          supplier,
          needOrder ? 1 : 0,
          partsStatus,
          existing.id
        );
      } else {
        db.prepare(`
          INSERT INTO quote_items (
            vehicle_id, consultation_item_id, category, description, quantity, customer_price,
            internal_cost, supplier, need_order, parts_status, sort_order
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          project.id,
          item.id,
          item.category,
          item.name,
          qty,
          customerPrice,
          internalCost,
          supplier,
          needOrder ? 1 : 0,
          partsStatus,
          nextSort('quote_items', project.id)
        );
      }
    } else if (existing && existing.active) {
      const activePart = db.prepare(
        'SELECT * FROM parts WHERE quote_item_id=? AND active=1 LIMIT 1'
      ).get(existing.id);

      if (activePart && !['Need to Order', 'Not Needed', 'Cancelled'].includes(activePart.status)) {
        warnings.push(`Kept linked part for ${existing.description} because it is already ${activePart.status}.`);
      } else if (activePart) {
        db.prepare('UPDATE parts SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(activePart.id);
      }

      db.prepare('UPDATE quote_items SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(existing.id);
    }
  }

  activity(req, project.id, 'consultation saved', null, `${checkedItems.length} items selected`);

  if (project.stage === '05 Deposit Paid' || stageProgress(project.stage) > stageProgress('05 Deposit Paid')) {
    activatePartsAfterDeposit(project.id, req);
  }

  res.json({
    ok: true,
    quote_total: quoteTotals(project.id).customer,
    warnings
  });
});

app.patch('/api/projects/:id/consultation/:itemId', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const item = db.prepare(`
    SELECT ci.*, cc.name AS category
    FROM consultation_items ci
    JOIN consultation_categories cc ON cc.id=ci.category_id
    WHERE ci.id=?
  `).get(Number(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  const selected = bool(req.body.selected);
  const existing = db.prepare('SELECT * FROM quote_items WHERE vehicle_id=? AND consultation_item_id=?').get(project.id, item.id);
  let warning = '';

  if (selected) {
    const qty = Math.max(0.01, number(req.body.quantity, existing?.quantity || 1));
    const customerPrice = int(req.body.customer_price ?? existing?.customer_price ?? item.default_customer_price);
    const internalCost = int(req.body.internal_cost ?? existing?.internal_cost ?? item.default_internal_cost);
    const supplier = text(req.body.supplier ?? existing?.supplier ?? item.supplier);
    const needOrder = req.body.need_order === undefined ? !!item.need_order : bool(req.body.need_order);
    const partsStatus = needOrder ? 'Need to Order' : 'Not Needed';
    if (existing) {
      db.prepare(`
        UPDATE quote_items
        SET category=?, description=?, quantity=?, customer_price=?, internal_cost=?, supplier=?,
            need_order=?, parts_status=?, internal_notes=?, active=1, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(item.category, item.name, qty, customerPrice, internalCost, supplier, needOrder ? 1 : 0, partsStatus, text(req.body.internal_notes ?? existing.internal_notes), existing.id);
      activity(req, project.id, 'quote item edited', existing.description, item.name);
    } else {
      db.prepare(`
        INSERT INTO quote_items (
          vehicle_id, consultation_item_id, category, description, quantity, customer_price,
          internal_cost, supplier, need_order, parts_status, internal_notes, sort_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project.id, item.id, item.category, item.name, qty, customerPrice, internalCost, supplier, needOrder ? 1 : 0, partsStatus, text(req.body.internal_notes), nextSort('quote_items', project.id));
      activity(req, project.id, 'quote item added', null, item.name);
    }
    if (project.stage === '05 Deposit Paid' || stageProgress(project.stage) > stageProgress('05 Deposit Paid')) {
      activatePartsAfterDeposit(project.id, req);
    }
  } else if (existing) {
    const activePart = db.prepare('SELECT * FROM parts WHERE quote_item_id=? AND active=1 LIMIT 1').get(existing.id);
    if (activePart && !['Need to Order', 'Not Needed', 'Cancelled'].includes(activePart.status)) {
      warning = `Linked part is already ${activePart.status}; quote item was marked inactive but the part was kept.`;
    } else if (activePart) {
      db.prepare('UPDATE parts SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(activePart.id);
    }
    db.prepare('UPDATE quote_items SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(existing.id);
    activity(req, project.id, 'quote item deleted', existing.description, null);
  }

  res.json({ ok: true, warning, quote_total: quoteTotals(project.id).customer });
});

app.get('/api/projects/:id/quote', requireAuth, (req, res) => {
  const project = projectSummary(requireProject(req.params.id, true));
  const rows = quoteRows(project.id).map(row => ({
    ...row,
    subtotal: number(row.quantity, 1) * int(row.customer_price),
    cost_total: number(row.quantity, 1) * int(row.internal_cost),
    profit: number(row.quantity, 1) * (int(row.customer_price) - int(row.internal_cost))
  }));
  const totals = quoteTotals(project.id);
  const terms = setting('quote_terms');
  res.json({ project, items: rows, totals: { ...totals, margin: totals.customer ? Math.round((totals.profit / totals.customer) * 1000) / 10 : 0 }, terms });
});

app.post('/api/projects/:id/quote', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const description = text(req.body.description);
  if (!description) return res.status(400).json({ error: 'description is required' });
  const needOrder = bool(req.body.need_order);
  const result = db.prepare(`
    INSERT INTO quote_items (
      vehicle_id, category, description, quantity, customer_price, internal_cost,
      supplier, need_order, parts_status, internal_notes, sort_order
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    text(req.body.category) || 'Other',
    description,
    Math.max(0.01, number(req.body.quantity, 1)),
    int(req.body.customer_price),
    int(req.body.internal_cost),
    text(req.body.supplier),
    needOrder ? 1 : 0,
    needOrder ? 'Need to Order' : 'Not Needed',
    text(req.body.internal_notes),
    nextSort('quote_items', project.id)
  );
  activity(req, project.id, 'quote item added', null, description);
  if (project.stage === '05 Deposit Paid' || stageProgress(project.stage) > stageProgress('05 Deposit Paid')) activatePartsAfterDeposit(project.id, req);
  res.status(201).json(db.prepare('SELECT * FROM quote_items WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/projects/:id/quote/:quoteItemId', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const current = db.prepare('SELECT * FROM quote_items WHERE id=? AND vehicle_id=?').get(Number(req.params.quoteItemId), project.id);
  if (!current) return res.status(404).json({ error: 'Quote item not found' });
  const next = { ...current, ...req.body };
  const needOrder = bool(next.need_order);
  const partsStatus = needOrder ? (PART_STATUSES.includes(next.parts_status) ? next.parts_status : 'Need to Order') : 'Not Needed';
  db.prepare(`
    UPDATE quote_items
    SET category=?, description=?, quantity=?, customer_price=?, internal_cost=?, supplier=?,
        need_order=?, parts_status=?, internal_notes=?, active=?, sort_order=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND vehicle_id=?
  `).run(
    text(next.category) || 'Other',
    text(next.description),
    Math.max(0.01, number(next.quantity, 1)),
    int(next.customer_price),
    int(next.internal_cost),
    text(next.supplier),
    needOrder ? 1 : 0,
    partsStatus,
    text(next.internal_notes),
    bool(next.active) ? 1 : 0,
    int(next.sort_order, current.sort_order),
    current.id,
    project.id
  );
  activity(req, project.id, 'quote item edited', current.description, text(next.description));
  if (needOrder && (project.stage === '05 Deposit Paid' || stageProgress(project.stage) > stageProgress('05 Deposit Paid'))) activatePartsAfterDeposit(project.id, req);
  res.json(db.prepare('SELECT * FROM quote_items WHERE id=?').get(current.id));
});

app.delete('/api/projects/:id/quote/:quoteItemId', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const current = db.prepare('SELECT * FROM quote_items WHERE id=? AND vehicle_id=?').get(Number(req.params.quoteItemId), project.id);
  if (!current) return res.status(404).json({ error: 'Quote item not found' });
  db.prepare('UPDATE quote_items SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(current.id);
  activity(req, project.id, 'quote item deleted', current.description, null);
  res.json({ ok: true });
});

app.get('/api/projects/:id/parts', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const rows = db.prepare(`
    SELECT
      p.*,
      qi.description AS linked_quote_item,
      qi.supplier AS quote_supplier,
      qi.consultation_item_id
    FROM parts p
    LEFT JOIN quote_items qi ON qi.id=p.quote_item_id
    WHERE p.vehicle_id=? AND p.active=1
    ORDER BY p.sort_order, p.id
  `).all(project.id);
  const subpartsByItem = consultationSubpartsByItemIds(rows.map(row => row.consultation_item_id).filter(Boolean));
  res.json(rows.map(row => ({
    ...row,
    supplier: row.supplier || row.quote_supplier || '',
    subparts: row.consultation_item_id ? subpartsByItem.get(row.consultation_item_id) || [] : []
  })));
});

app.post('/api/projects/:id/parts', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const name = text(req.body.part_name);
  if (!name) return res.status(400).json({ error: 'part_name is required' });
  const status = PART_STATUSES.includes(req.body.status) ? req.body.status : 'Need to Order';
  const quoteItem = req.body.quote_item_id
    ? db.prepare('SELECT * FROM quote_items WHERE id=? AND vehicle_id=?').get(Number(req.body.quote_item_id), project.id)
    : null;
  const result = db.prepare(`
    INSERT INTO parts (vehicle_id, quote_item_id, part_name, supplier, quantity, cost, status, eta, arrived_date, installed_date, notes, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    quoteItem ? quoteItem.id : null,
    name,
    text(req.body.supplier) || quoteItem?.supplier || '',
    Math.max(0.01, number(req.body.quantity, 1)),
    int(req.body.cost),
    status,
    dateOnly(req.body.eta),
    dateOnly(req.body.arrived_date),
    dateOnly(req.body.installed_date),
    text(req.body.notes),
    nextSort('parts', project.id)
  );
  activity(req, project.id, 'part status changed', null, `${name}: ${status}`);
  res.status(201).json(db.prepare('SELECT * FROM parts WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/projects/:id/parts/:partId', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const current = db.prepare('SELECT * FROM parts WHERE id=? AND vehicle_id=?').get(Number(req.params.partId), project.id);
  if (!current) return res.status(404).json({ error: 'Part not found' });
  const next = { ...current, ...req.body };
  const status = PART_STATUSES.includes(next.status) ? next.status : current.status;
  const quoteItem = next.quote_item_id
    ? db.prepare('SELECT * FROM quote_items WHERE id=? AND vehicle_id=?').get(Number(next.quote_item_id), project.id)
    : null;
  const supplier = req.body.supplier !== undefined ? text(next.supplier) : (quoteItem?.supplier || current.supplier || '');
  db.prepare(`
    UPDATE parts
    SET quote_item_id=?, part_name=?, supplier=?, quantity=?, cost=?, status=?, eta=?,
        arrived_date=?, installed_date=?, notes=?, active=?, sort_order=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND vehicle_id=?
  `).run(
    quoteItem ? quoteItem.id : null,
    text(next.part_name),
    supplier,
    Math.max(0.01, number(next.quantity, 1)),
    int(next.cost),
    status,
    dateOnly(next.eta),
    dateOnly(next.arrived_date),
    dateOnly(next.installed_date),
    text(next.notes),
    bool(next.active) ? 1 : 0,
    int(next.sort_order, current.sort_order),
    current.id,
    project.id
  );
  if (current.status !== status) activity(req, project.id, 'part status changed', `${current.part_name}: ${current.status}`, `${text(next.part_name)}: ${status}`);
  if (current.quote_item_id) db.prepare('UPDATE quote_items SET parts_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, current.quote_item_id);
  res.json(db.prepare('SELECT * FROM parts WHERE id=?').get(current.id));
});

app.delete('/api/projects/:id/parts/:partId', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const current = db.prepare('SELECT * FROM parts WHERE id=? AND vehicle_id=?').get(Number(req.params.partId), project.id);
  if (!current) return res.status(404).json({ error: 'Part not found' });
  db.prepare('UPDATE parts SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(current.id);
  activity(req, project.id, 'part status changed', current.status, 'Cancelled');
  res.json({ ok: true });
});

app.get('/api/projects/:id/services', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const master = db.prepare('SELECT * FROM services_master WHERE active=1 ORDER BY sort_order, id').all();
  const selected = db.prepare('SELECT * FROM project_services WHERE vehicle_id=? AND active=1').all(project.id);
  const selectedByMaster = new Map(selected.map(row => [row.service_master_id, row]));
  res.json(master.map(service => ({ ...service, selected: selectedByMaster.has(service.id), project_service: selectedByMaster.get(service.id) || null })));
});

app.patch('/api/projects/:id/services/:serviceId', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const master = db.prepare('SELECT * FROM services_master WHERE id=?').get(Number(req.params.serviceId));
  if (!master) return res.status(404).json({ error: 'Service not found' });
  const selected = bool(req.body.selected);
  const existing = db.prepare('SELECT * FROM project_services WHERE vehicle_id=? AND service_master_id=?').get(project.id, master.id);
  if (selected) {
    if (existing) {
      db.prepare(`
        UPDATE project_services SET name=?, description=?, active=1, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(text(req.body.name) || existing.name, text(req.body.description ?? existing.description), existing.id);
      activity(req, project.id, 'service edited', existing.name, text(req.body.name) || existing.name);
    } else {
      db.prepare(`
        INSERT INTO project_services (vehicle_id, service_master_id, name, description, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.id, master.id, text(req.body.name) || master.name, text(req.body.description) || master.description, nextSort('project_services', project.id));
      activity(req, project.id, 'service added', null, master.name);
    }
  } else if (existing) {
    db.prepare('UPDATE project_services SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(existing.id);
    activity(req, project.id, 'service deleted', existing.name, null);
  }
  res.json({ ok: true });
});

app.get('/api/projects/:id/activity', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  res.json(db.prepare('SELECT * FROM activity_log WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT 200').all(project.id));
});

app.post('/api/projects/:id/activity', requireAuth, (req, res) => {
  const project = requireProject(req.params.id, true);
  const note = text(req.body.note);
  if (!note) return res.status(400).json({ error: 'note is required' });
  activity(req, project.id, 'admin note added', null, note);
  res.status(201).json({ ok: true });
});

app.get('/api/projects/:id/customer-quote', requireAuth, (req, res) => {
  const project = projectSummary(requireProject(req.params.id, true));
  const rows = quoteRows(project.id);
  const total = quoteTotals(project.id).customer;
  const lines = rows.map(row => {
    const subtotal = number(row.quantity, 1) * int(row.customer_price);
    return `${row.category} - ${row.description} x ${row.quantity}: NT$${subtotal.toLocaleString()}`;
  }).join('\n');
  const terms = setting('quote_terms');
  res.json({
    text: `Creative Den Studio\nInvoice / Quote for: ${project.name} - ${project.owner}\nJob: ${project.job_no || ''}\n\n${lines}\n\nTotal: NT$${total.toLocaleString()}\n\n付款條件 / Payment Terms:\n${terms}`
  });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, line_user_id, display_name, role, last_login_at, created_at FROM users ORDER BY created_at DESC').all();
  const serviceMaster = db.prepare('SELECT * FROM services_master ORDER BY sort_order, id').all();
  const categories = db.prepare('SELECT * FROM consultation_categories ORDER BY sort_order, id').all();
  const items = db.prepare(`
    SELECT ci.*, cc.name AS category
    FROM consultation_items ci
    JOIN consultation_categories cc ON cc.id=ci.category_id
    ORDER BY cc.sort_order, ci.sort_order, ci.id
  `).all();
  const subpartsByItem = consultationSubpartsByItemIds(items.map(item => item.id));
  res.json({
    users,
    service_master: serviceMaster,
    consultation: categories.map(category => ({
      ...category,
      items: items
        .filter(item => item.category_id === category.id)
        .map(item => ({ ...item, subparts: subpartsByItem.get(item.id) || [] }))
    })),
    pipeline: PIPELINE_STAGES,
    quote_categories: setting('quote_categories', DEFAULT_CATEGORIES.join('\n')),
    parts_categories: setting('parts_categories', DEFAULT_CATEGORIES.join('\n')),
    quote_terms: setting('quote_terms'),
    google_sheets_sync: setting('google_sheets_sync', 'Not connected')
  });
});

app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  ['quote_categories', 'parts_categories', 'quote_terms', 'google_sheets_sync'].forEach(key => {
    if (req.body[key] !== undefined) setSetting(key, req.body[key]);
  });
  res.json({ ok: true });
});

app.get('/api/admin/google-sheets/status', requireAdmin, async (req, res) => {
  const baseStatus = googleSheetsStatus(
    setting('google_sheets_last_synced_at'),
    setting('google_sheets_last_error')
  );
  if (!bool(req.query.test)) return res.json(baseStatus);

  try {
    const test = await testGoogleSheetsConnection();
    res.json({ ...baseStatus, test });
  } catch (err) {
    const message = syncErrorMessage(err);
    res.status(err.status || 502).json({ ...baseStatus, test: { ok: false, error: message }, error: message });
  }
});

app.post('/api/admin/google-sheets/sync', requireAdmin, async (req, res) => {
  try {
    const result = await syncGoogleSheets(db);
    setSetting('google_sheets_last_synced_at', result.synced_at);
    setSetting('google_sheets_last_error', '');
    logActivity(null, actor(req).userId || null, actor(req).displayName || null, 'Google Sheets synced', null, result.synced_at);
    res.json({
      ...result,
      status: googleSheetsStatus(result.synced_at, '')
    });
  } catch (err) {
    const message = syncErrorMessage(err);
    setSetting('google_sheets_last_error', message);
    res.status(err.status || 502).json({
      error: message,
      status: googleSheetsStatus(setting('google_sheets_last_synced_at'), message)
    });
  }
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const lineUserId = text(req.body.line_user_id);
  if (!lineUserId) return res.status(400).json({ error: 'LINE user ID is required' });
  const role = ['admin', 'member', 'pending', 'disabled'].includes(req.body.role) ? req.body.role : 'member';
  db.prepare(`
    INSERT INTO users (line_user_id, display_name, role)
    VALUES (?, ?, ?)
    ON CONFLICT(line_user_id) DO UPDATE SET display_name=excluded.display_name, role=excluded.role
  `).run(lineUserId, text(req.body.display_name), role);
  const user = getUser(lineUserId);
  logActivity(null, actor(req).userId || null, actor(req).displayName || null, 'user added', null, `${user.display_name || user.line_user_id} (${user.role})`);
  res.status(201).json(user);
});

app.patch('/api/admin/users/:userId', requireAdmin, (req, res) => {
  const id = Number(req.params.userId);
  const current = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!current) return res.status(404).json({ error: 'User not found' });
  const role = ['admin', 'member', 'pending', 'disabled'].includes(req.body.role) ? req.body.role : current.role;
  if (current.line_user_id === actor(req).userId && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin access' });
  db.prepare('UPDATE users SET display_name=?, role=? WHERE id=?').run(text(req.body.display_name ?? current.display_name), role, id);
  if (role !== current.role) {
    const action = role === 'member' && current.role === 'pending'
      ? 'user approved'
      : role === 'disabled'
        ? 'user disabled'
        : 'user role changed';
    logActivity(null, actor(req).userId || null, actor(req).displayName || null, action, current.role, `${current.display_name || current.line_user_id}: ${role}`);
  }
  res.json(db.prepare('SELECT id, line_user_id, display_name, role, last_login_at, created_at FROM users WHERE id=?').get(id));
});

app.delete('/api/admin/users/:userId', requireAdmin, (req, res) => {
  const id = Number(req.params.userId);
  const current = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!current) return res.status(404).json({ error: 'User not found' });
  if (current.line_user_id === actor(req).userId) return res.status(400).json({ error: 'You cannot delete your own user' });
  logActivity(null, actor(req).userId || null, actor(req).displayName || null, 'user deleted', current.role, current.display_name || current.line_user_id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ success: true });
});

app.post('/api/admin/consultation/categories', requireAdmin, (req, res) => {
  const name = text(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const sort = int(req.body.sort_order, db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_categories').get().next);
  const result = db.prepare('INSERT INTO consultation_categories (name, sort_order, active) VALUES (?, ?, ?)').run(name, sort, req.body.active === false ? 0 : 1);
  res.status(201).json(db.prepare('SELECT * FROM consultation_categories WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/consultation/categories/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_categories WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Category not found' });
  db.prepare('UPDATE consultation_categories SET name=?, sort_order=?, active=? WHERE id=?')
    .run(text(req.body.name ?? current.name), int(req.body.sort_order, current.sort_order), bool(req.body.active ?? current.active) ? 1 : 0, current.id);
  res.json(db.prepare('SELECT * FROM consultation_categories WHERE id=?').get(current.id));
});

app.post('/api/admin/consultation/items', requireAdmin, (req, res) => {
  const categoryId = Number(req.body.category_id);
  const name = text(req.body.name);
  if (!categoryId || !name) return res.status(400).json({ error: 'category_id and name are required' });

  const baseSlug = slugify(req.body.name);

  let slug = baseSlug;
  let counter = 1;

  while (
    db.prepare('SELECT id FROM consultation_items WHERE slug=?')
      .get(slug)
  ) {
    slug = `${baseSlug}-${counter++}`;
  }

  const sort = int(req.body.sort_order, db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_items WHERE category_id=?').get(categoryId).next);
  const result = db.prepare(`
    INSERT INTO consultation_items (
      category_id, slug, name, description, default_customer_price, default_internal_cost,
      supplier, need_order, sort_order, active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(categoryId, slug, name, text(req.body.description), int(req.body.default_customer_price), int(req.body.default_internal_cost), text(req.body.supplier), bool(req.body.need_order) ? 1 : 0, sort, req.body.active === false ? 0 : 1);
  res.status(201).json(db.prepare('SELECT * FROM consultation_items WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/consultation/items/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_items WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Item not found' });
  const next = { ...current, ...req.body };
  db.prepare(`
    UPDATE consultation_items
    SET category_id=?, name=?, description=?, default_customer_price=?, default_internal_cost=?,
        supplier=?, need_order=?, sort_order=?, active=?
    WHERE id=?
  `).run(
    Number(next.category_id),
    text(next.name),
    text(next.description),
    int(next.default_customer_price),
    int(next.default_internal_cost),
    text(next.supplier),
    bool(next.need_order) ? 1 : 0,
    int(next.sort_order),
    bool(next.active) ? 1 : 0,
    current.id
  );
  res.json(db.prepare('SELECT * FROM consultation_items WHERE id=?').get(current.id));
});

app.post('/api/admin/consultation/items/:id/subparts', requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM consultation_items WHERE id=?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const name = text(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const sort = int(req.body.sort_order, db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_subparts WHERE consultation_item_id=?').get(item.id).next);
  const result = db.prepare(`
    INSERT INTO consultation_subparts (consultation_item_id, name, cost, sort_order, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(item.id, name, int(req.body.cost), sort, req.body.active === false ? 0 : 1);
  updateConsultationItemCostFromSubparts(item.id);
  res.status(201).json(db.prepare('SELECT * FROM consultation_subparts WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/consultation/subparts/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_subparts WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Sub-part not found' });
  const next = { ...current, ...req.body };
  db.prepare(`
    UPDATE consultation_subparts
    SET name=?, cost=?, sort_order=?, active=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    text(next.name),
    int(next.cost),
    int(next.sort_order, current.sort_order),
    bool(next.active) ? 1 : 0,
    current.id
  );
  updateConsultationItemCostFromSubparts(current.consultation_item_id);
  res.json(db.prepare('SELECT * FROM consultation_subparts WHERE id=?').get(current.id));
});

app.delete('/api/admin/consultation/subparts/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_subparts WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Sub-part not found' });
  db.prepare('UPDATE consultation_subparts SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(current.id);
  updateConsultationItemCostFromSubparts(current.consultation_item_id);
  res.json({ ok: true });
});

app.post('/api/admin/services', requireAdmin, (req, res) => {
  const name = text(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const sort = int(req.body.sort_order, db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM services_master').get().next);
  const result = db.prepare('INSERT INTO services_master (name, description, sort_order, active) VALUES (?, ?, ?, ?)')
    .run(name, text(req.body.description), sort, req.body.active === false ? 0 : 1);
  res.status(201).json(db.prepare('SELECT * FROM services_master WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/services/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM services_master WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Service not found' });
  const next = { ...current, ...req.body };
  db.prepare('UPDATE services_master SET name=?, description=?, sort_order=?, active=? WHERE id=?')
    .run(text(next.name), text(next.description), int(next.sort_order), bool(next.active) ? 1 : 0, current.id);
  res.json(db.prepare('SELECT * FROM services_master WHERE id=?').get(current.id));
});

app.get('/api/vehicles', requireAuth, (req, res) => res.json(dashboardRows('All')));
app.post('/api/vehicles', requireAuth, (req, res, next) => {
  req.url = '/api/projects';
  next();
});

app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`CRDN tracking app listening on ${PORT}`));
