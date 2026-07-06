require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const OpenAI = require('openai');
const sharp = require('sharp');
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
const { syncMasterCashflow } = require('./cashflowSync');
const {
  driveStatus,
  requireDriveClient,
  syncDriveFolders,
  designLibraryReadiness,
  normalizeVehicleResearchFileCandidates,
  readDesignLibraryTextFile,
  extractDesignEntity,
  generateMoodboardConcept,
  generateDesignResponse,
  REQUIRED_MISSING_DATA
} = require('./designAiServices');

init();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || 'https://tool.creativeden.studio';
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const CALLBACK_URL = process.env.LINE_CALLBACK_URL || `${BASE_URL}/auth/callback`;
const allowedLineIds = new Set((process.env.ALLOWED_LINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

const PART_STATUSES = ['Not Needed', 'Need to Order', 'Ordered', 'Arrived', 'Installed', 'Backordered', 'Cancelled'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const TELEGRAM_MOCKUP_STATUSES = new Set(['pending', 'in_progress', 'done', 'cancelled']);
const MOCKUP_RESULT_DIR = path.join(__dirname, 'data', 'mockup-results');
const LAYOUT_RENDER_DIR = path.join(__dirname, 'data', 'layout-renders');
const MOCKUP_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function slugify(value){return String(value||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'item';}

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

function jsonText(value, fallback = '{}') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch (err) {
      return fallback;
    }
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    return fallback;
  }
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

function secureTokenEqual(actual, expected) {
  const actualText = text(actual);
  const expectedText = text(expected);
  if (!actualText || !expectedText) return false;
  const actualHash = crypto.createHash('sha256').update(actualText).digest();
  const expectedHash = crypto.createHash('sha256').update(expectedText).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function requireAgentRead(req, res, next) {
  const header = text(req.get('authorization'));
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !secureTokenEqual(match[1], process.env.AGENT_READ_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
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

const PACKAGE_NOTE_PREFIX = 'PACKAGE_META:';
const DELETED_CUSTOM_NOTE = 'DELETED_CUSTOM_ITEM';

function parsePackageMeta(note) {
  const raw = text(note);
  if (!raw.startsWith(PACKAGE_NOTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(PACKAGE_NOTE_PREFIX.length));
    const items = Array.isArray(parsed.items) ? parsed.items.map(String) : [];
    return {
      id: text(parsed.id),
      name: text(parsed.name),
      price: int(parsed.price),
      items
    };
  } catch (err) {
    return null;
  }
}

function packageMetaForVehicle(vehicleId) {
  const row = db.prepare(`
    SELECT *
    FROM quote_items
    WHERE vehicle_id=? AND active=1 AND consultation_item_id IS NULL AND internal_notes LIKE ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(vehicleId, `${PACKAGE_NOTE_PREFIX}%`);
  const meta = row ? parsePackageMeta(row.internal_notes) : null;
  return meta ? { ...meta, quote_item: row } : null;
}

function normalizePackageSettings(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw || '[]');
    } catch (err) {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((pkg, index) => ({
      id: text(pkg.id),
      name: text(pkg.name) || `Package ${index + 1}`,
      price: int(pkg.retail_price ?? pkg.price),
      active: pkg.active === undefined ? true : bool(pkg.active),
      sort_order: int(pkg.sort_order, index + 1),
      items: Array.isArray(pkg.items) ? pkg.items.map(String) : []
    }))
    .filter(pkg => pkg.active);
}

function packageNoteFromSettings(pkg) {
  return `${PACKAGE_NOTE_PREFIX}${JSON.stringify({
    id: pkg.id,
    name: pkg.name,
    price: pkg.price,
    items: pkg.items
  })}`;
}

function consultationItemByKey(key) {
  return db.prepare(`
    SELECT ci.*, cc.name AS category
    FROM consultation_items ci
    JOIN consultation_categories cc ON cc.id=ci.category_id
    WHERE ci.active=1 AND cc.active=1 AND (ci.slug=? OR ci.id=?)
    LIMIT 1
  `).get(String(key), Number(key) || 0);
}

function syncPackageQuoteRows(rawPackages) {
  const packages = normalizePackageSettings(rawPackages);
  if (!packages.length) return 0;
  const byId = new Map(packages.map(pkg => [pkg.id, pkg]));
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const rows = db.prepare(`
    SELECT *
    FROM quote_items
    WHERE consultation_item_id IS NULL AND internal_notes LIKE ? AND active=1
  `).all(`${PACKAGE_NOTE_PREFIX}%`);
  const tx = db.transaction(() => {
    rows.forEach(row => {
      const previous = parsePackageMeta(row.internal_notes);
      if (!previous) return;
      const pkg = byId.get(previous.id) || byName.get(previous.name);
      if (!pkg) return;
      const nextItems = new Set(pkg.items.map(String));
      db.prepare(`
        UPDATE quote_items
        SET description=?, customer_price=?, internal_notes=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(pkg.name, pkg.price, packageNoteFromSettings(pkg), row.id);

      previous.items
        .map(String)
        .filter(itemKey => !nextItems.has(itemKey))
        .forEach(itemKey => {
          const item = consultationItemByKey(itemKey);
          if (!item) return;
          const existing = db.prepare(`
            SELECT *
            FROM quote_items
            WHERE vehicle_id=? AND consultation_item_id=?
            LIMIT 1
          `).get(row.vehicle_id, item.id);
          if (existing && existing.active && int(existing.customer_price) === 0) {
            db.prepare('UPDATE quote_items SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(existing.id);
          }
        });

      pkg.items.forEach(itemKey => {
        const item = consultationItemByKey(itemKey);
        if (!item) return;
        const existing = db.prepare(`
          SELECT *
          FROM quote_items
          WHERE vehicle_id=? AND consultation_item_id=?
          LIMIT 1
        `).get(row.vehicle_id, item.id);
        const partsStatus = item.need_order ? 'Need to Order' : 'Not Needed';
        if (existing) {
          db.prepare(`
            UPDATE quote_items
            SET category=?, description=?, customer_price=0, internal_cost=?, supplier=?,
                need_order=?, parts_status=?, active=1, updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).run(item.category, item.name, int(item.default_internal_cost), text(item.supplier), item.need_order ? 1 : 0, partsStatus, existing.id);
        } else {
          db.prepare(`
            INSERT INTO quote_items (
              vehicle_id, consultation_item_id, category, description, quantity, customer_price,
              internal_cost, supplier, need_order, parts_status, option_values_json, sort_order
            )
            VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, '{}', ?)
          `).run(row.vehicle_id, item.id, item.category, item.name, int(item.default_internal_cost), text(item.supplier), item.need_order ? 1 : 0, partsStatus, nextSort('quote_items', row.vehicle_id));
        }
      });
    });
  });
  tx();
  return rows.length;
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
    timeline_json: row.timeline_json || '{}',
    milestones_json: row.milestones_json || '[]',
    quote_cost: totals.cost,
    quote_profit: totals.profit,
    quote_count: totals.count,
    parts_status: projectPartsStatus(row.id),
    next_action: row.next_action || row.customer_action || row.customer_update || row.notes || ''
  };
}

const AGENT_ROUTE_LIST = [
  'GET /api/agent/context',
  'GET /api/agent/vehicles',
  'GET /api/agent/products',
  'GET /api/agent/mockups',
  'GET /api/agent/layout-render-requests/:id',
  'GET /api/agent/projects',
  'GET /api/agent/projects/:id'
];

function agentReferenceFileMetadata(value) {
  const files = parseJson(value, []);
  const list = Array.isArray(files) ? files : [files];
  return list.map(item => {
    if (!item) return null;
    if (typeof item === 'string') return { name: item };
    if (typeof item !== 'object') return null;
    return {
      name: text(item.name || item.filename || item.path || item.label),
      path: text(item.path),
      folder_type: text(item.folder_type),
      mime_type: text(item.mime_type || item.type),
      modified_time: text(item.modified_time),
      size: text(item.size),
      is_folder: Boolean(item.is_folder)
    };
  }).filter(item => item && Object.values(item).some(Boolean));
}

function agentSourceSummary(value) {
  const summary = parseJson(value, {});
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return {};
  return {
    extraction_draft_id: summary.extraction_draft_id || null,
    confidence: summary.confidence || {},
    approved_at: text(summary.approved_at)
  };
}

function agentVehicleRecord(row) {
  const record = designVehicleRecordFromRow(row);
  return {
    id: record.id,
    vehicle_id: record.vehicle_id,
    make: record.make || record.brand || '',
    model: record.model || '',
    year_range: record.year_range || '',
    market: record.market || '',
    body_type: record.body_type || '',
    exterior_dimensions_mm: {
      length: record.overall_length_mm,
      width: record.overall_width_mm,
      height: record.overall_height_mm,
      wheelbase: record.wheelbase_mm
    },
    interior_dimensions_mm: {
      length: record.interior_length_mm,
      width: record.interior_width_mm,
      height: record.interior_height_mm,
      side_door_width: record.side_door_width_mm,
      side_door_height: record.side_door_height_mm,
      rear_door_width: record.rear_door_width_mm,
      rear_door_height: record.rear_door_height_mm,
      rear_window_width: record.rear_window_width_mm,
      rear_window_height: record.rear_window_height_mm,
      wheel_arch_width: record.wheel_arch_width_mm,
      wheel_arch_height: record.wheel_arch_height_mm
    },
    cargo: {
      payload_kg: record.payload_kg
    },
    confidence: record.source_summary?.confidence || {},
    status: record.status || 'draft',
    source_notes: record.floor_plan_notes || '',
    source_summary: agentSourceSummary(record.source_summary_json),
    updated_at: record.updated_at
  };
}

function agentProductRecord(row) {
  const record = designProductRecordFromRow(row);
  return {
    id: record.id,
    product_id: record.product_id,
    sku: record.sku || '',
    name: record.name || '',
    category: record.category || '',
    dimensions_mm: {
      width: record.width_mm,
      depth: record.depth_mm,
      height: record.height_mm
    },
    weight_kg: record.weight_kg,
    dimension_confidence: record.dimension_confidence || '',
    material: record.material || '',
    color: record.color || '',
    layout_component_type: record.layout_component_type || '',
    layout_dimensions_mm: {
      width: record.layout_width_mm,
      depth: record.layout_depth_mm,
      height: record.layout_height_mm
    },
    layout_modes: record.layout_modes || [],
    shape_rule: record.shape_rule || '',
    configurable_dimensions: record.configurable_dimensions || {},
    orientation_options: record.orientation_options || [],
    allowed_zones: record.allowed_zones || [],
    mounting_type: record.mounting_type || '',
    mounting_notes: record.mounting_notes || '',
    installation_notes: record.installation_notes || '',
    clearance_notes: record.clearance_notes || '',
    compatible_vehicles: record.compatible_vehicles || [],
    fitment_confidence: record.fitment_confidence || '',
    fitment_reason: record.fitment_reason || '',
    production_warning: record.production_warning || '',
    production_ready: Boolean(record.production_ready),
    status: record.status || 'draft',
    approved_status: record.status || 'draft',
    source_notes: record.source_notes || '',
    reference_files: agentReferenceFileMetadata(record.reference_files_json),
    source_summary: agentSourceSummary(record.source_summary_json),
    updated_at: record.updated_at
  };
}

function agentProjectSummary(row) {
  if (!row) return null;
  const stage = normalizeStage(row.stage);
  return {
    id: row.id,
    job_no: row.job_no || '',
    vehicle_name: row.name || '',
    stage,
    designer: row.designer || '',
    priority: row.priority || 'Normal',
    progress: stageProgress(stage),
    start_date: row.start_date || '',
    due_date: row.finish_date || '',
    updated_at: row.updated_at || ''
  };
}

function agentProjectDetail(row) {
  const summary = agentProjectSummary(row);
  if (!summary) return null;
  let milestones = [];
  try {
    milestones = JSON.parse(row.milestones_json || '[]');
  } catch (err) {
    milestones = [];
  }
  return {
    ...summary,
    archived: Boolean(row.archived),
    created_at: row.created_at || '',
    milestones: Array.isArray(milestones) ? milestones.map(item => ({
      label: text(item.label || item.name || item.milestone),
      scheduled_date: text(item.scheduled_date || item.schedule_date || item.date),
      actual_date: text(item.actual_date),
      status: text(item.status)
    })).filter(item => item.label || item.scheduled_date || item.actual_date || item.status) : []
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
    if (filter === 'Parts Ordering') return ['08 Parts Ordering', '09 Parts Arrived'].includes(project.stage);
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

function parseJsonPayload(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  try {
    JSON.stringify(value);
    return value;
  } catch (err) {
    return null;
  }
}

function layoutConceptFromRow(row, includeLayout = false) {
  if (!row) return null;
  const concept = {
    id: row.id,
    title: row.title || '',
    vehicle_key: row.vehicle_key || '',
    vehicle_name: row.vehicle_name || '',
    notes: row.notes || '',
    created_by_line_user_id: row.created_by_line_user_id || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || ''
  };
  if (includeLayout) concept.layout_json = parseJsonPayload(row.layout_json) || {};
  return concept;
}

function layoutAgentRenderRequestFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    layout_concept_id: row.layout_concept_id,
    status: row.status || 'pending',
    status_label: layoutAgentStatusLabel(row.status || 'pending'),
    requested_by_line_user_id: row.requested_by_line_user_id || '',
    requested_by_name: row.requested_by_name || '',
    telegram_chat_id: row.telegram_chat_id || '',
    telegram_message_id: row.telegram_message_id || '',
    result_image_path: row.result_image_path || '',
    result_notes: row.result_notes || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || ''
  };
}

function layoutAgentStatusLabel(status) {
  const key = text(status || 'pending').toLowerCase();
  if (key === 'sent') return 'Sent to Agent';
  if (key === 'ready' || key === 'done') return 'Ready';
  return 'Pending Agent Render';
}

function telegramAllowedChatIds() {
  return text(process.env.TELEGRAM_ALLOWED_CHAT_IDS)
    .split(',')
    .map(value => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

async function sendLayoutAgentTelegramMessage(requestId, layoutId) {
  const token = text(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = telegramAllowedChatIds()[0] || '';
  if (!token || !chatId) return { sent: false, chatId, messageId: '', reason: 'Telegram bot token or allowed chat ID is not configured.' };

  const message = [
    '🖼 CRDN Bird’s-Eye Layout Render',
    '',
    `Request ID: ${requestId}`,
    `Layout ID: ${layoutId}`,
    '',
    'Task:',
    'Generate ONE polished top-down / bird’s-eye camper interior layout image.',
    '',
    'This is NOT a customer car photo mockup.',
    'This is NOT exterior Photoshop.',
    'This is a clean presentation render based on the saved 2D layout.',
    '',
    'Use CRDN Agent API:',
    `GET /api/agent/layout-render-requests/${requestId}`,
    '',
    'Rules:',
    '- Use the saved layout as ground truth.',
    '- Respect all product positions, sizes, and rotations.',
    '- Do not redesign the layout.',
    '- Do not add products not listed.',
    '- Use a clean white/light background.',
    '- Make it look like a customer-facing camper layout proposal.',
    '- Style reference: top-down van layout render with realistic floor, cabinets, bed cushions, shadows, and materials.',
    '- Return ONE image only.',
    '',
    'Reply with the finished image and include:',
    `Request ID: ${requestId}`
  ].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      return { sent: false, chatId, messageId: '', reason: body.description || `Telegram HTTP ${response.status}` };
    }
    return { sent: true, chatId, messageId: String(body.result?.message_id || '') };
  } catch (err) {
    return { sent: false, chatId, messageId: '', reason: err.message || 'Telegram send failed.' };
  }
}

function layoutConceptPayload(body = {}, existing = null) {
  const title = text(body.title ?? existing?.title);
  const vehicleKey = text(body.vehicle_key ?? body.vehicleKey ?? existing?.vehicle_key);
  const vehicleName = text(body.vehicle_name ?? body.vehicleName ?? existing?.vehicle_name);
  const notes = text(body.notes ?? existing?.notes);
  const rawLayout = body.layout_json ?? body.layoutJson ?? existing?.layout_json;
  const layout = parseJsonPayload(rawLayout);

  if (!title) {
    const err = new Error('Layout title is required.');
    err.status = 400;
    throw err;
  }
  if (!vehicleKey) {
    const err = new Error('Vehicle key is required.');
    err.status = 400;
    throw err;
  }
  if (!layout) {
    const err = new Error('Valid layout_json is required.');
    err.status = 400;
    throw err;
  }

  return {
    title,
    vehicle_key: vehicleKey,
    vehicle_name: vehicleName,
    notes,
    layout_json: JSON.stringify(layout)
  };
}

function positiveNumber(value, fallback = 0) {
  const n = number(value, fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function layoutVehicleName(row = {}) {
  const parts = [
    text(row.make || row.brand),
    text(row.model)
  ].filter(Boolean);
  return parts.join(' ') || text(row.vehicle_id) || 'CRDN Vehicle';
}

function layoutVehicleBuildDimensions(row = {}) {
  const constraints = parseJsonPayload(row.layout_constraints_json) || {};
  const buildArea = constraints.build_area
    || constraints.buildArea
    || constraints.buildable_area
    || constraints.buildableArea
    || constraints.usable_floor_envelope_mm
    || {};
  const buildLength = positiveNumber(
    buildArea.length_mm
      ?? buildArea.buildable_length_mm
      ?? buildArea.length
      ?? buildArea.length_y
      ?? constraints.buildable_length_mm
      ?? constraints.build_length_mm
      ?? row.interior_length_mm,
    1900
  );
  const buildWidth = positiveNumber(
    buildArea.width_mm
      ?? buildArea.buildable_width_mm
      ?? buildArea.width
      ?? buildArea.width_x
      ?? constraints.buildable_width_mm
      ?? constraints.build_width_mm
      ?? row.interior_width_mm,
    1340
  );
  return { buildLength, buildWidth };
}

function layoutVehicleTemplateAlignment(row = {}) {
  const constraints = parseJsonPayload(row.layout_constraints_json) || {};
  const alignment = constraints.template_alignment || constraints.templateAlignment || {};
  const buildArea = alignment.build_area || alignment.buildArea || null;
  if (!buildArea || typeof buildArea !== 'object') return null;
  return {
    x: number(buildArea.x ?? buildArea.x_px ?? 0),
    y: number(buildArea.y ?? buildArea.y_px ?? 0),
    scale: positiveNumber(buildArea.scale, 1)
  };
}

function normalizedDesignFileName(value) {
  const name = text(value).split('/').pop().toLowerCase().replace(/\.[a-z0-9]+$/, '');
  return name.replace(/[^a-z0-9]+/g, '');
}

function normalizedLibraryPathExpression() {
  return "lower(replace(replace(path, ' /', '/'), '/ ', '/'))";
}

function designTopdownBaseImageForVehicle(vehicleId) {
  const id = text(vehicleId);
  if (!id) return null;
  const normalizedId = normalizedDesignFileName(id);
  return db.prepare(`
    SELECT drive_file_id, name, path, mime_type, web_view_link, modified_time
    FROM design_library_files
    WHERE folder_type='vehicles'
      AND is_folder=0
      AND COALESCE(file_status, 'active')='active'
      AND lower(mime_type) LIKE 'image/%'
      AND ${normalizedLibraryPathExpression()} LIKE lower(?)
      AND (
        lower(name) IN ('topdown_base.png','topdown_base.jpg','topdown_base.jpeg','topdown.png','topdown.jpg','topdown.jpeg','vehicle_topdown_base.png','vehicle_topdown_base.jpg','vehicle_topdown_base.jpeg')
        OR lower(name)=lower(?)
        OR lower(name)=lower(?)
        OR lower(name)=lower(?)
        OR lower(name)=lower(?)
        OR lower(name)=lower(?)
        OR lower(name)=lower(?)
        OR replace(replace(replace(lower(name), '_', ''), '-', ''), ' ', '')='topdownbase'
        OR replace(replace(replace(lower(name), '_', ''), '-', ''), ' ', '')='vehicletopdownbase'
      )
    ORDER BY
      CASE WHEN lower(name) LIKE '%topdown_base%' THEN 0 ELSE 1 END,
      modified_time DESC,
      name COLLATE NOCASE
    LIMIT 1
  `).get(
    `${id}/%`,
    `${id}_topdown_base.png`,
    `${id}_topdown_base.jpg`,
    `${id}_topdown_base.jpeg`,
    `${normalizedId}_topdown_base.png`,
    `${normalizedId}_topdown_base.jpg`,
    `${normalizedId}_topdown_base.jpeg`
  ) || null;
}

function designProductPngForProduct(productId, row = {}) {
  const candidates = [
    productId,
    row.product_id,
    row.sku,
    row.name
  ].map(text).filter(Boolean);
  const id = candidates[0] || '';
  if (!id) return null;
  const folderPatterns = [...new Set([
    ...candidates.map(value => `${value}/%`),
    ...candidates.map(value => `%/${value}/%`),
    ...candidates.map(value => `%${value}%`)
  ])];
  const normalizedCandidates = [...new Set(candidates.map(normalizedDesignFileName).filter(Boolean))];
  const exactNames = [...new Set([
    ...candidates.map(value => `${value}.png`),
    'product.png',
    'product_preview.png',
    'preview.png',
    'footprint.png',
    'layout.png'
  ].map(value => text(value).toLowerCase()).filter(Boolean))];
  const pathClauses = folderPatterns.map(() => `${normalizedLibraryPathExpression()} LIKE lower(?)`).join(' OR ');
  const exactNamePlaceholders = exactNames.map(() => '?').join(',');
  const normalizedNamePlaceholders = normalizedCandidates.map(() => '?').join(',');
  return db.prepare(`
    SELECT drive_file_id, name, path, mime_type, web_view_link, modified_time
    FROM design_library_files
    WHERE folder_type='products'
      AND is_folder=0
      AND COALESCE(file_status, 'active')='active'
      AND lower(mime_type)='image/png'
      AND (${pathClauses || '1=0'})
      AND (
        lower(name) IN (${exactNamePlaceholders || "''"})
        OR replace(replace(replace(lower(name), '_', ''), '-', ''), ' ', '') IN (${normalizedNamePlaceholders || "''"})
        OR lower(name) LIKE '%product%'
        OR lower(name) LIKE '%preview%'
        OR lower(name) LIKE '%footprint%'
      )
    ORDER BY
      CASE
        WHEN lower(name) IN (${exactNamePlaceholders || "''"}) THEN 0
        WHEN replace(replace(replace(lower(name), '_', ''), '-', ''), ' ', '') IN (${normalizedNamePlaceholders || "''"}) THEN 1
        WHEN lower(name)='product.png' THEN 2
        ELSE 3
      END,
      modified_time DESC,
      name COLLATE NOCASE
    LIMIT 1
  `).get(
    ...folderPatterns,
    ...exactNames,
    ...normalizedCandidates,
    ...exactNames,
    ...normalizedCandidates
  ) || null;
}

function layoutConceptVehiclesForLibrary() {
  const approvedCount = db.prepare("SELECT COUNT(*) AS count FROM design_ai_vehicle_records WHERE status='approved'").get().count;
  const status = approvedCount > 0 ? 'approved' : 'draft';
  return db.prepare(`
    SELECT vehicle_id, brand, make, model, interior_length_mm, interior_width_mm,
      layout_constraints_json, status, updated_at
    FROM design_ai_vehicle_records
    WHERE status=?
    ORDER BY updated_at DESC, vehicle_id COLLATE NOCASE
    LIMIT 200
  `).all(status).map(row => {
    const dimensions = layoutVehicleBuildDimensions(row);
    const templateAlignment = layoutVehicleTemplateAlignment(row);
    const vehicleId = text(row.vehicle_id);
    const topdownBase = designTopdownBaseImageForVehicle(vehicleId);
    return {
      key: vehicleId,
      name: layoutVehicleName(row),
      buildLength: dimensions.buildLength,
      buildWidth: dimensions.buildWidth,
      topdownBaseImageDriveId: topdownBase?.drive_file_id || '',
      topdownBaseImagePath: topdownBase?.path || '',
      topdownBaseImageName: topdownBase?.name || '',
      templateAlignment,
      source: 'design_ai_vehicle_records',
      status: row.status || status
    };
  }).filter(vehicle => vehicle.key);
}

function layoutConceptProductsForLibrary() {
  const approvedCount = db.prepare("SELECT COUNT(*) AS count FROM design_ai_product_records WHERE status='approved'").get().count;
  const status = approvedCount > 0 ? 'approved' : 'draft';
  return db.prepare(`
    SELECT product_id, sku, name, category, layout_width_mm, layout_depth_mm, layout_height_mm,
      width_mm, depth_mm, height_mm, color, status, updated_at
    FROM design_ai_product_records
    WHERE status=?
    ORDER BY updated_at DESC, product_id COLLATE NOCASE
    LIMIT 500
  `).all(status).map(row => {
    const width = positiveNumber(row.layout_width_mm ?? row.width_mm, 0);
    const depth = positiveNumber(row.layout_depth_mm ?? row.depth_mm, 0);
    const height = positiveNumber(row.layout_height_mm ?? row.height_mm, 0);
    const productImage = designProductPngForProduct(row.product_id, row);
    return {
      id: text(row.product_id),
      name: text(row.name || row.product_id || 'CRDN Product'),
      category: text(row.category),
      width,
      depth,
      height,
      color: text(row.color),
      productImageDriveId: productImage?.drive_file_id || '',
      productImagePath: productImage?.path || '',
      productImageName: productImage?.name || '',
      source: 'design_ai_product_records',
      status: row.status || status,
      missing_dimensions: !width || !depth
    };
  }).filter(product => product.id);
}

function layoutPlacementFromItem(item = {}) {
  return {
    id: item.id || '',
    product_id: text(item.product_id || item.productKey || item.product_id || item.sku || item.name),
    x_mm: number(item.x_mm ?? item.x ?? 0),
    y_mm: number(item.y_mm ?? item.y ?? 0),
    rotation: number(item.rotation ?? 0)
  };
}

function layoutAgentRenderRequestDetail(id) {
  const requestRow = db.prepare('SELECT * FROM layout_agent_render_requests WHERE id=?').get(Number(id));
  if (!requestRow) return null;
  const layoutRow = db.prepare('SELECT * FROM design_layout_concepts WHERE id=?').get(Number(requestRow.layout_concept_id));
  const layoutConcept = layoutConceptFromRow(layoutRow, true);
  if (!layoutConcept) return null;
  const parsedLayout = layoutConcept.layout_json || {};
  const placements = Array.isArray(parsedLayout.placed)
    ? parsedLayout.placed.map(layoutPlacementFromItem).filter(item => item.product_id)
    : [];
  const vehicle = designApprovedVehicle(layoutConcept.vehicle_key) || {
    vehicle_id: layoutConcept.vehicle_key || '',
    name: layoutConcept.vehicle_name || '',
    source: 'layout_concept'
  };
  const products = placements.map(placement => ({
    placement,
    product: designProductForPlacement(placement.product_id)
  }));

  const aiRenderItems = products.map(({ placement, product }) => {
    const productWidth = positiveNumber(product?.layout_width_mm ?? product?.width_mm, 0);
    const productDepth = positiveNumber(product?.layout_depth_mm ?? product?.depth_mm, 0);
    const rotation = number(placement.rotation ?? 0);

    return {
      product_id: placement.product_id,
      product_name: product?.name || placement.product_id,
      category: product?.category || '',
      editor_coordinates: {
        note: 'Original 2D editor orientation: vehicle front is LEFT, rear is RIGHT.',
        x_mm: placement.x_mm,
        y_mm: placement.y_mm,
        rotation_degrees: rotation
      },
      ai_render_coordinates: {
        note: 'AI render orientation: vehicle front is TOP, rear is BOTTOM.',
        front_to_rear_mm: placement.x_mm,
        left_to_right_mm: placement.y_mm,
        rotation_degrees: rotation,
        placement_rule: 'Low front_to_rear_mm is near the front seats/top. High front_to_rear_mm is toward the rear/bottom.'
      },
      dimensions_mm: {
        width_across_vehicle: productWidth,
        depth_front_to_rear: productDepth,
        height: positiveNumber(product?.layout_height_mm ?? product?.height_mm, 0)
      },
      visual_instruction: `${product?.name || placement.product_id} must stay at front-to-rear ${placement.x_mm} mm and left-to-right ${placement.y_mm} mm with ${rotation} degree rotation. Do not move, resize, or reinterpret this product.`
    };
  });

  const aiRenderBrief = {
    task: 'Generate ONE polished bird\'s-eye / top-down customer-facing camper interior layout render.',
    workflow_type: '2D_LAYOUT_PRESENTATION_RENDER_NOT_CUSTOMER_PHOTO_MOCKUP',
    orientation: {
      source_editor_view: 'vehicle front is LEFT, vehicle rear is RIGHT',
      required_ai_render_view: 'vehicle front is TOP, vehicle rear is BOTTOM',
      coordinate_transform: 'Use editor x_mm as AI front_to_rear_mm. Use editor y_mm as AI left_to_right_mm.',
      critical_rule: 'Do not rotate the layout randomly. Front seats/cab must appear at the TOP. Rear cargo/cabinets must appear toward the BOTTOM.'
    },
    vehicle_summary: {
      vehicle_id: vehicle.vehicle_id || layoutConcept.vehicle_key || '',
      name: vehicle.name || layoutConcept.vehicle_name || '',
      build_length_mm: vehicle.build_length_mm || vehicle.buildLength || parsedLayout.buildLength || '',
      build_width_mm: vehicle.build_width_mm || vehicle.buildWidth || parsedLayout.buildWidth || ''
    },
    layout_rules: [
      'Use the saved layout as ground truth.',
      'Respect every product position, product size, and product rotation.',
      'Do not redesign the layout.',
      'Do not add products that are not listed.',
      'Do not move the bed to the rear if its x/front_to_rear coordinate places it behind the front seats.',
      'Do not move rear cabinets forward if their x/front_to_rear coordinate places them toward the rear.',
      'Use a clean white/light background.',
      'Make it look like a polished customer-facing camper proposal, not a rough sketch.'
    ],
    items: aiRenderItems,
    style_direction: {
      view: 'top-down bird\'s-eye camper interior proposal render',
      materials: 'realistic floor texture, cabinet surfaces, cushions, soft shadows, trim',
      output: 'one finished image only'
    }
  };

  return {
    request: layoutAgentRenderRequestFromRow(requestRow),
    layout_concept: layoutConcept,
    parsed_layout_json: parsedLayout,
    vehicle,
    products,
    notes: layoutConcept.notes || '',
    product_placement_data: placements,
    ai_render_brief: aiRenderBrief
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
  `).run(key, String(value ?? ''));
}

const DESIGN_AI_SETTING_KEYS = [
  'google_drive_root_folder_id',
  'vehicles_folder_id',
  'products_folder_id',
  'styles_folder_id',
  'templates_folder_id',
  'last_sync_at',
  'last_sync_error'
];

function designSetting(key, fallback = '') {
  return db.prepare('SELECT value FROM design_ai_settings WHERE key=?').get(key)?.value || fallback;
}

function setDesignSetting(key, value) {
  db.prepare(`
    INSERT INTO design_ai_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).run(key, String(value ?? ''));
}

function designAiSettings() {
  return DESIGN_AI_SETTING_KEYS.reduce((acc, key) => {
    acc[key] = designSetting(key);
    return acc;
  }, {});
}

function designLibraryStatus() {
  const byFolder = db.prepare(`
    SELECT folder_type, COUNT(*) AS count, MAX(updated_at) AS updated_at
    FROM design_library_files
    GROUP BY folder_type
  `).all();
  const folders = { root: 0, vehicles: 0, products: 0, styles: 0, templates: 0 };
  byFolder.forEach(row => { folders[row.folder_type] = row.count; });
  const total = db.prepare('SELECT COUNT(*) AS count FROM design_library_files').get().count;
  const files = designLibraryFiles('all');
  const activeFiles = activeDesignLibraryFiles(files);
  return {
    total_indexed_files: total,
    folders,
    readiness: designLibraryReadiness(activeFiles, designExtractionStatusLookup()),
    last_sync_at: designSetting('last_sync_at'),
    last_sync_error: designSetting('last_sync_error'),
    drive: driveStatus()
  };
}

function activeDesignLibraryFiles(files = []) {
  return files.filter(file => !['ignored', 'archived', 'reset_pending'].includes(text(file.file_status || 'active')));
}

function designLibraryFiles(folderType = 'all') {
  if (['root', 'vehicles', 'products', 'styles', 'templates'].includes(folderType)) {
    return db.prepare(`
      SELECT *
      FROM design_library_files
      WHERE folder_type=?
      ORDER BY modified_time DESC, name COLLATE NOCASE
    `).all(folderType);
  }
  return db.prepare(`
    SELECT *
    FROM design_library_files
    ORDER BY folder_type, modified_time DESC, name COLLATE NOCASE
  `).all();
}

const DESIGN_AI_VEHICLE_FIELDS = [
  'brand', 'make', 'model', 'generation', 'market', 'body_type', 'year_range', 'unit',
  'overall_length_mm', 'overall_width_mm', 'overall_height_mm', 'wheelbase_mm',
  'interior_length_mm', 'interior_width_mm', 'interior_height_mm',
  'side_door_width_mm', 'side_door_height_mm',
  'rear_window_width_mm', 'rear_window_height_mm', 'rear_door_width_mm', 'rear_door_height_mm',
  'wheel_arch_width_mm', 'wheel_arch_height_mm', 'wheel_arch_position_x_mm', 'wheel_arch_position_y_mm',
  'payload_kg', 'floor_plan_notes', 'layout_constraints_json', 'reference_files_json', 'source_drive_folder_id', 'source_summary_json', 'status'
];
const DESIGN_AI_PRODUCT_FIELDS = [
  'sku', 'name', 'category', 'description', 'unit', 'width_mm', 'depth_mm', 'height_mm', 'weight_kg',
  'mounting_type', 'compatible_vehicles_json', 'requires_drilling', 'install_minutes', 'price',
  'mounting_notes', 'installation_notes', 'dimension_confidence', 'material', 'color',
  'layout_component_type', 'layout_width_mm', 'layout_depth_mm', 'layout_height_mm',
  'layout_modes_json', 'shape_rule', 'orientation_options_json', 'allowed_zones_json',
  'clearance_notes', 'is_configurable', 'configurable_dimensions_json', 'default_variant_json',
  'variants_json', 'fitment_confidence', 'fitment_reason', 'confirmed_data_json',
  'estimated_data_json', 'production_warning', 'production_ready', 'source_notes',
  'seat_mode_width_mm', 'seat_mode_depth_mm', 'bed_mode_width_mm', 'bed_mode_depth_mm',
  'extended_bed_mode_width_mm', 'extended_bed_mode_depth_mm', 'seat_panel_depth_mm',
  'back_panel_depth_mm', 'optional_extension_depth_mm', 'reference_files_json',
  'source_drive_folder_id', 'source_summary_json', 'status'
];
const DESIGN_AI_STYLE_FIELDS = [
  'name', 'description', 'colors_json', 'materials_json', 'reference_images_json',
  'moodboard_notes', 'status'
];
const DESIGN_AI_WORKSPACE_FIELDS = [
  'title', 'customer_name', 'vehicle_id', 'products_json', 'style_id', 'customer_notes',
  'customer_photos_json', 'layout_json', 'layout_notes', 'moodboard_text', 'brochure_copy',
  'mockup_files_json', 'status'
];
const DESIGN_AI_NUMBER_FIELDS = new Set([
  'overall_length_mm', 'overall_width_mm', 'overall_height_mm', 'wheelbase_mm',
  'interior_length_mm', 'interior_width_mm', 'interior_height_mm',
  'side_door_width_mm', 'side_door_height_mm', 'rear_door_width_mm', 'rear_door_height_mm',
  'rear_window_width_mm', 'rear_window_height_mm', 'wheel_arch_width_mm', 'wheel_arch_height_mm',
  'wheel_arch_position_x_mm', 'wheel_arch_position_y_mm', 'width_mm', 'depth_mm', 'height_mm',
  'layout_width_mm', 'layout_depth_mm', 'layout_height_mm', 'seat_mode_width_mm',
  'seat_mode_depth_mm', 'bed_mode_width_mm', 'bed_mode_depth_mm', 'extended_bed_mode_width_mm',
  'extended_bed_mode_depth_mm', 'seat_panel_depth_mm', 'back_panel_depth_mm',
  'optional_extension_depth_mm', 'payload_kg', 'weight_kg', 'install_minutes', 'price'
]);
const DESIGN_AI_JSON_FIELDS = new Set([
  'compatible_vehicles_json', 'reference_files_json', 'source_summary_json', 'colors_json',
  'materials_json', 'reference_images_json', 'products_json', 'customer_photos_json',
  'layout_json', 'mockup_files_json', 'layout_modes_json', 'orientation_options_json',
  'allowed_zones_json', 'configurable_dimensions_json', 'default_variant_json',
  'variants_json', 'confirmed_data_json', 'estimated_data_json', 'layout_constraints_json'
]);
const DESIGN_AI_BOOLEAN_FIELDS = new Set(['requires_drilling', 'is_configurable', 'production_ready']);
const DESIGN_AI_RECORD_STATUSES = new Set(['draft', 'approved', 'archived']);
const DESIGN_AI_WORKSPACE_STATUSES = new Set(['draft', 'submitted', 'in_progress', 'review', 'approved', 'archived']);
const DESIGN_AI_MOODBOARD_INPUT_KEYS = [
  'vehicle_id',
  'project_name',
  'customer_name',
  'lifestyle_theme',
  'must_include',
  'usage_scenario',
  'style_direction',
  'notes',
  'customer_vehicle_image_drive_id',
  'request_id'
];

function designEntityType(value) {
  const type = text(value).toLowerCase();
  return type === 'vehicle' ? 'vehicle' : 'product';
}

function designFolderType(entityType) {
  return designEntityType(entityType) === 'vehicle' ? 'vehicles' : 'products';
}

function normalizeDesignLibraryPath(value) {
  return text(value).split('/').map(part => text(part)).filter(Boolean).join('/');
}

function repairDesignLibraryFilePaths() {
  return db.prepare(`
    UPDATE design_library_files
    SET path=replace(replace(path, ' /', '/'), '/ ', '/'),
      updated_at=CURRENT_TIMESTAMP
    WHERE path LIKE '% /%' OR path LIKE '%/ %'
  `).run();
}

function designEntityFolderFiles(entityType, folderPath, entityId) {
  const folderType = designFolderType(entityType);
  const folder = normalizeDesignLibraryPath(folderPath || entityId);
  if (!folder) return [];
  const legacyChild = `${folder} /%`;
  return db.prepare(`
    SELECT *
    FROM design_library_files
    WHERE folder_type=?
      AND COALESCE(file_status, 'active')='active'
      AND (
        path=?
        OR path LIKE ?
        OR path LIKE ?
        OR replace(replace(path, ' /', '/'), '/ ', '/')=?
        OR replace(replace(path, ' /', '/'), '/ ', '/') LIKE ?
        OR lower(name)=lower(?)
      )
    ORDER BY is_folder DESC, path COLLATE NOCASE, modified_time DESC
  `).all(folderType, folder, `${folder}/%`, legacyChild, folder, `${folder}/%`, folder);
}

try {
  repairDesignLibraryFilePaths();
} catch (err) {
  console.warn('Design library path repair skipped:', err.message);
}

function uniqueDesignLibraryFiles(files = []) {
  const seen = new Set();
  return files.filter(file => {
    const key = text(file.drive_file_id) || text(file.path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function vehicleResearchFilesForRecord(vehicle) {
  const latest = latestExtractionDraft('vehicle', vehicle?.vehicle_id);
  const prefixes = [...new Set([
    vehicle?.vehicle_id,
    latest?.folder_path
  ].map(text).filter(Boolean))];
  let rows = [];
  prefixes.forEach(prefix => {
    rows.push(...designEntityFolderFiles('vehicle', prefix, vehicle?.vehicle_id));
  });
  if (!rows.length && text(vehicle?.vehicle_id).length >= 3) {
    rows = db.prepare(`
      SELECT *
      FROM design_library_files
      WHERE folder_type='vehicles'
        AND is_folder=0
        AND COALESCE(file_status, 'active')='active'
        AND lower(path) LIKE ?
      ORDER BY modified_time DESC, path COLLATE NOCASE
    `).all(`%${text(vehicle.vehicle_id).toLowerCase()}%`);
  }
  return uniqueDesignLibraryFiles(rows);
}

function vehicleResearchStatusesWithFloorplan(research, files = []) {
  const statuses = Array.isArray(research?.statuses) ? [...research.statuses] : [];
  const isTopdownBase = file => {
    const name = text(file.name || file.path).toLowerCase();
    const simple = normalizedDesignFileName(name);
    const entity = normalizedDesignFileName((text(file.path).split('/')[0] || ''));
    return ['topdown_base.png', 'topdown_base.jpg', 'topdown_base.jpeg', 'topdown.png', 'topdown.jpg', 'topdown.jpeg', 'vehicle_topdown_base.png', 'vehicle_topdown_base.jpg', 'vehicle_topdown_base.jpeg'].includes(name) ||
      ['topdownbase', 'topdown', 'vehicletopdownbase'].includes(simple) ||
      Boolean(entity && simple === `${entity}topdownbase`);
  };
  const floorplan = files
    .filter(file => Number(file.is_folder) !== 1)
    .find(file => {
      const name = text(file.name || file.path).toLowerCase();
      const pathValue = text(file.path).toLowerCase();
      return name === 'floorplan.svg' || pathValue.endsWith('/floorplan.svg') || (name.endsWith('.svg') && name.includes('floorplan'));
    });
  const topdownBase = files
    .filter(file => Number(file.is_folder) !== 1)
    .find(file => text(file.mime_type).toLowerCase().startsWith('image/') && isTopdownBase(file));
  const floorplanStatus = {
    id: floorplan?.id || null,
    key: 'floorplan',
    label: 'Floorplan',
    found: Boolean(floorplan),
    detected_type: floorplan ? 'floorplan_svg' : 'floorplan_svg',
    original_filename: floorplan?.name || '',
    path: floorplan?.path || '',
    match_type: floorplan ? 'exact_filename' : '',
    match_label: floorplan ? 'exact filename' : '',
    current_role: floorplan?.extraction_role === 'primary' ? 'primary' : '',
    file_status: floorplan?.file_status || 'active',
    extraction_role: floorplan?.extraction_role || '',
    modified_time: floorplan?.modified_time || '',
    web_view_link: floorplan?.web_view_link || '',
    candidate_count: floorplan ? 1 : 0,
    same_priority_count: floorplan ? 1 : 0
  };
  const topdownStatus = {
    id: topdownBase?.id || null,
    key: 'topdown_base',
    label: 'Topdown Base Image',
    found: Boolean(topdownBase),
    detected_type: topdownBase ? 'topdown_base_image' : 'topdown_base_image',
    original_filename: topdownBase?.name || '',
    path: topdownBase?.path || '',
    match_type: topdownBase ? 'exact_filename' : '',
    match_label: topdownBase ? 'exact filename' : '',
    current_role: topdownBase?.extraction_role === 'primary' ? 'primary' : '',
    file_status: topdownBase?.file_status || 'active',
    extraction_role: topdownBase?.extraction_role || '',
    modified_time: topdownBase?.modified_time || '',
    web_view_link: topdownBase?.web_view_link || '',
    candidate_count: topdownBase ? 1 : 0,
    same_priority_count: topdownBase ? 1 : 0
  };
  const manifestIndex = statuses.findIndex(item => item?.key === 'manifest');
  if (manifestIndex >= 0) statuses.splice(manifestIndex, 0, floorplanStatus);
  else statuses.push(floorplanStatus);
  const floorplanIndex = statuses.findIndex(item => item?.key === 'floorplan');
  if (floorplanIndex >= 0) statuses.splice(floorplanIndex + 1, 0, topdownStatus);
  else statuses.push(topdownStatus);
  return statuses;
}

function vehicleResearchPayload(research, files = []) {
  return {
    statuses: vehicleResearchStatusesWithFloorplan(research, files),
    warnings: research?.warnings || [],
    duplicates: research?.duplicates || []
  };
}

function normalizeWarnings(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const warning = text(value);
  return warning ? [warning] : [];
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  return number(value, null);
}

function normalizeLayoutZone(zone = {}) {
  return {
    name: text(zone.name || zone.zone_name || zone.zone || zone.id || 'Restricted Zone'),
    type: text(zone.type || 'restricted'),
    x_mm: nullableNumber(zone.x_mm ?? zone.x ?? zone.left_mm ?? zone.origin_x_mm),
    y_mm: nullableNumber(zone.y_mm ?? zone.y ?? zone.top_mm ?? zone.origin_y_mm),
    length_mm: nullableNumber(zone.length_mm ?? zone.length ?? zone.l_mm),
    width_mm: nullableNumber(zone.width_mm ?? zone.width ?? zone.depth_mm ?? zone.depth ?? zone.w_mm),
    notes: text(zone.notes || zone.reason || zone.description || zone.note)
  };
}

function normalizeVehicleLayoutSuggestion(raw, file) {
  const input = raw?.layout_constraints_json || raw?.layout_constraints || raw || {};
  const buildArea = input.build_area || input.buildArea || input.buildable_area || input.buildableArea || input.usable_floor_envelope_mm || {};
  const clearance = input.clearance || input.clearances || input.recommended_layout_clearances_mm || {};
  const metadata = input.metadata || {};
  const generatedAt = text(
    metadata.generated_at ||
    metadata.generated_date ||
    metadata.created_at ||
    metadata.updated_at ||
    file?.modified_time
  );
  return {
    schema_version: input.schema_version || 1,
    build_area: {
      x_mm: nullableNumber(buildArea.x_mm ?? buildArea.x ?? buildArea.origin_x_mm ?? input.build_origin_x_mm ?? input.origin_x_mm),
      y_mm: nullableNumber(buildArea.y_mm ?? buildArea.y ?? buildArea.origin_y_mm ?? input.build_origin_y_mm ?? input.origin_y_mm),
      length_mm: nullableNumber(buildArea.length_mm ?? buildArea.buildable_length_mm ?? buildArea.length ?? buildArea.length_y ?? input.buildable_length_mm ?? input.build_length_mm),
      width_mm: nullableNumber(buildArea.width_mm ?? buildArea.buildable_width_mm ?? buildArea.width ?? buildArea.width_x ?? input.buildable_width_mm ?? input.build_width_mm),
      height_mm: nullableNumber(buildArea.height_mm ?? buildArea.buildable_height_mm ?? buildArea.height ?? buildArea.height_z ?? input.buildable_height_mm ?? input.build_height_mm)
    },
    clearance: {
      front_mm: nullableNumber(clearance.front_mm ?? clearance.front_seat_clearance_mm ?? clearance.front_seat_mm ?? input.front_seat_clearance_mm ?? input.front_clearance_mm),
      rear_mm: nullableNumber(clearance.rear_mm ?? clearance.rear_door_clearance_mm ?? clearance.rear_door_mm ?? clearance.rear_access_clearance ?? input.rear_door_clearance_mm ?? input.rear_clearance_mm),
      left_mm: nullableNumber(clearance.left_mm ?? clearance.left_wall_clearance_mm ?? clearance.left_wall_mm ?? clearance.cabinet_service_clearance ?? input.left_wall_clearance_mm ?? input.left_clearance_mm),
      right_mm: nullableNumber(clearance.right_mm ?? clearance.right_wall_clearance_mm ?? clearance.right_wall_mm ?? clearance.cabinet_service_clearance ?? input.right_wall_clearance_mm ?? input.right_clearance_mm),
      minimum_walkway_mm: nullableNumber(clearance.minimum_walkway_mm ?? clearance.walkway_mm ?? clearance.minimum_walkway_width ?? clearance.comfortable_walkway_width ?? input.minimum_walkway_mm)
    },
    restricted_zones: Array.isArray(input.restricted_zones)
      ? input.restricted_zones.map(normalizeLayoutZone)
      : [],
    mounting_points: Array.isArray(input.mounting_points) ? input.mounting_points : [],
    metadata: {
      ...metadata,
      status: text(metadata.approval_status || metadata.status || input.approval_status || input.status || 'ai_suggested'),
      confidence: text(metadata.confidence || input.confidence || raw.confidence || 'MEDIUM').toUpperCase() || 'MEDIUM',
      source_file: text(metadata.source_file || metadata.derived_from || input.derived_from || file?.name || 'layout_constraints.json'),
      source_path: text(metadata.source_path || file?.path || ''),
      generated_at: generatedAt,
      notes: text(metadata.notes || metadata.layout_notes || input.layout_notes || input.notes || raw.notes),
      warnings: normalizeWarnings(metadata.warnings || input.warnings || raw.warnings)
    }
  };
}

function latestExtractionDraft(entityType, entityId) {
  return designExtractionFromRow(db.prepare(`
    SELECT *
    FROM design_ai_extraction_drafts
    WHERE entity_type=? AND lower(entity_id)=lower(?)
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(designEntityType(entityType), text(entityId)));
}

function designExtractionStatusLookup() {
  const lookup = {};
  const drafts = db.prepare(`
    SELECT entity_type, entity_id, id, status
    FROM design_ai_extraction_drafts
    ORDER BY updated_at DESC, id DESC
  `).all();
  drafts.forEach(row => {
    const folderType = designFolderType(row.entity_type);
    const keys = [`${folderType}:${row.entity_id}`, `${folderType}:${text(row.entity_id).toLowerCase()}`];
    keys.forEach(key => {
      if (!lookup[key]) lookup[key] = { status: row.status || 'draft', latest_extraction_id: row.id };
    });
  });
  db.prepare('SELECT id, vehicle_id FROM design_ai_vehicle_records WHERE status=?').all('approved').forEach(row => {
    [`vehicles:${row.vehicle_id}`, `vehicles:${text(row.vehicle_id).toLowerCase()}`].forEach(key => {
      lookup[key] = { ...(lookup[key] || {}), status: 'approved', approved_record_id: row.id };
    });
  });
  db.prepare('SELECT id, product_id FROM design_ai_product_records WHERE status=?').all('approved').forEach(row => {
    [`products:${row.product_id}`, `products:${text(row.product_id).toLowerCase()}`].forEach(key => {
      lookup[key] = { ...(lookup[key] || {}), status: 'approved', approved_record_id: row.id };
    });
  });
  return lookup;
}

function vehicleFileLookupClauses(vehicleId) {
  const id = normalizeDesignLibraryPath(vehicleId);
  return {
    exact: id,
    child: `${id}/%`,
    legacyChild: `${id} /%`,
    loose: `%${id.toLowerCase()}%`
  };
}

function designVehicleLibraryFiles(vehicleId, { activeOnly = false } = {}) {
  const parts = vehicleFileLookupClauses(vehicleId);
  return db.prepare(`
    SELECT *
    FROM design_library_files
    WHERE folder_type='vehicles'
      ${activeOnly ? "AND COALESCE(file_status, 'active')='active'" : ''}
      AND (
        path=?
        OR path LIKE ?
        OR path LIKE ?
        OR lower(replace(replace(path, ' /', '/'), '/ ', '/')) LIKE lower(?)
        OR lower(path) LIKE ?
      )
    ORDER BY modified_time DESC, path COLLATE NOCASE
  `).all(parts.exact, parts.child, parts.legacyChild, parts.child, parts.loose);
}

function upsertDesignLibraryFiles(files = []) {
  const upsert = db.prepare(`
    INSERT INTO design_library_files (
      drive_file_id, folder_type, name, path, parent_drive_file_id, mime_type,
      web_view_link, modified_time, size, is_folder, file_status, extraction_role, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', CURRENT_TIMESTAMP)
    ON CONFLICT(drive_file_id) DO UPDATE SET
      folder_type=excluded.folder_type,
      name=excluded.name,
      path=excluded.path,
      parent_drive_file_id=excluded.parent_drive_file_id,
      mime_type=excluded.mime_type,
      web_view_link=excluded.web_view_link,
      modified_time=excluded.modified_time,
      size=excluded.size,
      is_folder=excluded.is_folder,
      file_status='active',
      extraction_role=CASE
        WHEN design_library_files.file_status='reset_pending' THEN ''
        ELSE COALESCE(design_library_files.extraction_role, '')
      END,
      ignored_at=NULL,
      archived_at=NULL,
      updated_at=CURRENT_TIMESTAMP
  `);
  const tx = db.transaction(rows => {
    rows.forEach(file => upsert.run(
      text(file.drive_file_id),
      text(file.folder_type),
      text(file.name),
      normalizeDesignLibraryPath(file.path || file.name),
      text(file.parent_drive_file_id),
      text(file.mime_type),
      text(file.web_view_link),
      text(file.modified_time),
      text(file.size),
      Number(file.is_folder) ? 1 : 0
    ));
  });
  tx(files);
}

function designExtractionFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    extracted: parseJson(row.extracted_json, {}),
    confidence: parseJson(row.confidence_json, {}),
    source_files: parseJson(row.source_files_json, [])
  };
}

function designVehicleRecordFromRow(row) {
  if (!row) return null;
  const topdownBase = designTopdownBaseImageForVehicle(row.vehicle_id);
  return {
    ...row,
    floor_plan_notes: row.floor_plan_notes || row.notes || '',
    reference_files: parseJson(row.reference_files_json, []),
    compatible_vehicles: [],
    topdown_base_image: topdownBase,
    topdownBaseImageDriveId: topdownBase?.drive_file_id || '',
    topdownBaseImagePath: topdownBase?.path || '',
    topdownBaseImageName: topdownBase?.name || '',
    source_summary: parseJson(row.source_summary_json, {})
  };
}

function designProductRecordFromRow(row) {
  if (!row) return null;
  const productImage = designProductPngForProduct(row.product_id, row);
  return {
    ...row,
    requires_drilling: Boolean(row.requires_drilling),
    is_configurable: Boolean(row.is_configurable),
    production_ready: Boolean(row.production_ready),
    compatible_vehicles: parseJson(row.compatible_vehicles_json, []),
    reference_files: parseJson(row.reference_files_json, []),
    layout_modes: parseJson(row.layout_modes_json, []),
    orientation_options: parseJson(row.orientation_options_json, []),
    allowed_zones: parseJson(row.allowed_zones_json, []),
    configurable_dimensions: parseJson(row.configurable_dimensions_json, {}),
    default_variant: parseJson(row.default_variant_json, {}),
    variants: parseJson(row.variants_json, []),
    confirmed_data: parseJson(row.confirmed_data_json, {}),
    estimated_data: parseJson(row.estimated_data_json, {}),
    product_image: productImage,
    productImageDriveId: productImage?.drive_file_id || '',
    productImagePath: productImage?.path || '',
    productImageName: productImage?.name || '',
    source_summary: parseJson(row.source_summary_json, {})
  };
}

function designStyleRecordFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    colors: parseJson(row.colors_json, []),
    materials: parseJson(row.materials_json, []),
    reference_images: parseJson(row.reference_images_json, [])
  };
}

function parseDesignList(value) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? text(item) : item).filter(Boolean);
  if (value && typeof value === 'object') return value;
  const raw = text(value);
  if (!raw) return [];
  const parsed = parseJson(raw, null);
  if (parsed !== null) return parsed;
  return raw.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
}

function cleanRecordStatus(value, fallback = 'draft') {
  const status = text(value || fallback).toLowerCase();
  return DESIGN_AI_RECORD_STATUSES.has(status) ? status : fallback;
}

function cleanWorkspaceStatus(value, fallback = 'draft') {
  const status = text(value || fallback).toLowerCase();
  return DESIGN_AI_WORKSPACE_STATUSES.has(status) ? status : fallback;
}

function moodboardInputFromBody(body = {}, fallback = {}) {
  const input = { ...(fallback || {}) };
  DESIGN_AI_MOODBOARD_INPUT_KEYS.forEach(key => {
    if (body[key] !== undefined) input[key] = text(body[key]);
  });
  input.request_id = input.request_id ? int(input.request_id, 0) : '';
  input.vehicle_id = text(input.vehicle_id);
  input.project_name = text(input.project_name || input.customer_name || input.title);
  input.must_include_json = JSON.stringify(parseMustInclude(input.must_include));
  return input;
}

function moodboardRaw(row) {
  return parseJson(row?.raw_response_json, {});
}

function moodboardFromRow(row) {
  if (!row) return null;
  const raw = moodboardRaw(row);
  return {
    ...row,
    request_id: row.request_id || '',
    key_features: parseJson(row.key_features_json, []),
    layout_modes: parseJson(row.layout_modes_json, []),
    material_palette: parseJson(row.material_palette_json, []),
    image_prompts: parseJson(row.image_prompts_json, []),
    input: raw.input || {},
    raw_response: raw
  };
}

function moodboardDetail(id) {
  return moodboardFromRow(db.prepare('SELECT * FROM design_ai_moodboards WHERE id=?').get(Number(id)));
}

function moodboardRecordsContext(input = {}) {
  const request = {
    vehicle_id: input.vehicle_id || '',
    must_include_json: input.must_include_json || JSON.stringify(parseMustInclude(input.must_include)),
    style_id: input.style_direction || ''
  };
  return generationRecordsContext(request);
}

function saveMoodboardGeneration(id, input, generated) {
  const existing = moodboardDetail(id);
  if (!existing) return null;
  const raw = {
    ...(existing.raw_response || {}),
    input,
    generated,
    raw_openai_response: generated.raw_openai_response || null,
    content_warnings: generated.content_warnings || [],
    generated_at: new Date().toISOString()
  };
  db.prepare(`
    UPDATE design_ai_moodboards
    SET title=?, concept_text=?, key_features_json=?, layout_modes_json=?,
      material_palette_json=?, image_prompts_json=?, brochure_copy=?,
      customer_vehicle_image_drive_id=?, raw_response_json=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    text(generated.title || existing.title || input.project_name),
    text(generated.concept_text),
    JSON.stringify(generated.key_features || []),
    JSON.stringify(generated.layout_modes || []),
    JSON.stringify(generated.material_palette || []),
    JSON.stringify(generated.mockup_image_prompts || generated.image_prompts || []),
    text(generated.brochure_copy),
    text(input.customer_vehicle_image_drive_id || existing.customer_vehicle_image_drive_id),
    JSON.stringify(raw),
    'generated',
    existing.id
  );
  return moodboardDetail(existing.id);
}

function designRecordValue(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (DESIGN_AI_NUMBER_FIELDS.has(field)) return number(value, null);
  if (DESIGN_AI_BOOLEAN_FIELDS.has(field)) return bool(value) ? 1 : 0;
  if (field === 'status') return cleanRecordStatus(value);
  if (field === 'compatible_vehicles_json') return JSON.stringify(Array.isArray(value) ? value.map(text).filter(Boolean) : parseMustInclude(value));
  if (field === 'products_json') return JSON.stringify(parseWorkspaceProducts(value));
  if (DESIGN_AI_JSON_FIELDS.has(field)) {
    if (field === 'layout_json') return jsonText(value, '{}');
    return JSON.stringify(parseDesignList(value));
  }
  return text(value);
}

function cleanRecordPayload(payload, fields) {
  return fields.reduce((acc, field) => {
    const value = designRecordValue(payload[field], field);
    if (value !== undefined) acc[field] = value;
    return acc;
  }, {});
}

function upsertDesignRecord({ table, idKey, idValue, payload, fields, fromRow, sourceSummary, defaultStatus = 'draft', preserveExistingEmpty = false }) {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${idKey}=?`).get(idValue);
  const cleanPayload = cleanRecordPayload(payload, fields);
  if (sourceSummary !== undefined && fields.includes('source_summary_json')) {
    cleanPayload.source_summary_json = JSON.stringify(sourceSummary || {});
  }
  const merged = { ...(existing || {}) };
  Object.entries(cleanPayload).forEach(([field, value]) => {
    if (preserveExistingEmpty && existing && (value === null || value === '')) return;
    merged[field] = value;
  });
  if (fields.includes('unit')) merged.unit = merged.unit || 'mm';
  if (fields.includes('status')) merged.status = cleanRecordStatus(merged.status, existing?.status || defaultStatus);
  const comparisonFields = fields.filter(field => !['source_drive_folder_id', 'source_summary_json', 'status'].includes(field));
  const changed = !existing || comparisonFields.some(field => String(existing[field] ?? '') !== String(merged[field] ?? ''));
  merged.version = existing ? Number(existing.version || 1) + (changed ? 1 : 0) : 1;
  const columns = [idKey, ...fields, 'version', 'updated_at'];
  const placeholders = ['?', ...fields.map(() => '?'), '?', 'CURRENT_TIMESTAMP'];
  const updates = [...fields, 'version'].map(field => `${field}=excluded.${field}`).join(', ');
  db.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT(${idKey}) DO UPDATE SET ${updates}, updated_at=CURRENT_TIMESTAMP
  `).run(idValue, ...fields.map(field => merged[field] ?? null), merged.version);
  return fromRow(db.prepare(`SELECT * FROM ${table} WHERE ${idKey}=?`).get(idValue));
}

function saveExtractionDraft({ entityType, entityId, folderPath, sourceDriveFolderId, extracted, confidence, sourceFiles, createdBy }) {
  const result = db.prepare(`
    INSERT INTO design_ai_extraction_drafts (
      entity_type, entity_id, folder_path, source_drive_folder_id, extracted_json,
      confidence_json, source_files_json, status, created_by_line_user_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP)
  `).run(
    entityType,
    entityId,
    folderPath || '',
    sourceDriveFolderId || '',
    JSON.stringify(extracted || {}),
    JSON.stringify(confidence || {}),
    JSON.stringify(sourceFiles || []),
    createdBy || ''
  );
  return designExtractionFromRow(db.prepare('SELECT * FROM design_ai_extraction_drafts WHERE id=?').get(result.lastInsertRowid));
}

function updateExtractionDraft(id, body) {
  const existing = designExtractionFromRow(db.prepare('SELECT * FROM design_ai_extraction_drafts WHERE id=?').get(Number(id)));
  if (!existing) return null;
  const extracted = body.extracted || body.extracted_json || existing.extracted;
  const confidence = body.confidence || body.confidence_json || existing.confidence;
  const status = text(body.status || existing.status || 'draft');
  db.prepare(`
    UPDATE design_ai_extraction_drafts
    SET extracted_json=?, confidence_json=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(JSON.stringify(extracted || {}), JSON.stringify(confidence || {}), status, existing.id);
  return designExtractionFromRow(db.prepare('SELECT * FROM design_ai_extraction_drafts WHERE id=?').get(existing.id));
}

function upsertDesignVehicleRecord(vehicleId, payload, sourceSummary, options = {}) {
  return upsertDesignRecord({
    table: 'design_ai_vehicle_records',
    idKey: 'vehicle_id',
    idValue: vehicleId,
    payload,
    fields: DESIGN_AI_VEHICLE_FIELDS,
    fromRow: designVehicleRecordFromRow,
    sourceSummary,
    defaultStatus: options.defaultStatus || payload.status || 'draft',
    preserveExistingEmpty: Boolean(options.preserveExistingEmpty)
  });
}

const DESIGN_AI_PRODUCT_MANUAL_VALUE_FIELDS = [
  'width_mm', 'depth_mm', 'height_mm', 'weight_kg', 'price', 'material', 'color',
  'layout_width_mm', 'layout_depth_mm', 'layout_height_mm', 'layout_component_type',
  'shape_rule', 'clearance_notes', 'mounting_notes', 'installation_notes',
  'seat_mode_width_mm', 'seat_mode_depth_mm', 'bed_mode_width_mm', 'bed_mode_depth_mm',
  'extended_bed_mode_width_mm', 'extended_bed_mode_depth_mm', 'seat_panel_depth_mm',
  'back_panel_depth_mm', 'optional_extension_depth_mm'
];

function hasDesignValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function isHighConfidence(confidence, field) {
  return text(confidence?.[field]).toUpperCase() === 'HIGH';
}

function protectManualProductValues(productId, payload = {}, sourceSummary = {}) {
  const existing = designProductRecordFromRow(db.prepare('SELECT * FROM design_ai_product_records WHERE product_id=?').get(productId));
  if (!existing) return payload;
  const confidence = sourceSummary?.confidence || payload.field_confidence || {};
  const estimated = { ...(existing.estimated_data || {}) };
  const next = { ...payload };
  let changed = false;
  DESIGN_AI_PRODUCT_MANUAL_VALUE_FIELDS.forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(next, field)) return;
    const incoming = next[field];
    const current = existing[field];
    if (!hasDesignValue(incoming) || !hasDesignValue(current)) return;
    if (String(incoming) === String(current)) return;
    if (isHighConfidence(confidence, field)) return;
    estimated[field] = {
      value: incoming,
      confidence: text(confidence[field] || 'LOW') || 'LOW',
      source: 'design_ai_extraction',
      saved_at: new Date().toISOString()
    };
    delete next[field];
    changed = true;
  });
  if (changed) next.estimated_data_json = estimated;
  return next;
}

function upsertDesignProductRecord(productId, payload, sourceSummary, options = {}) {
  const incoming = options.preserveManualEstimates
    ? protectManualProductValues(productId, payload, sourceSummary)
    : { ...payload };
  if (incoming.compatible_vehicles && incoming.compatible_vehicles_json === undefined) incoming.compatible_vehicles_json = incoming.compatible_vehicles;
  return upsertDesignRecord({
    table: 'design_ai_product_records',
    idKey: 'product_id',
    idValue: productId,
    payload: incoming,
    fields: DESIGN_AI_PRODUCT_FIELDS,
    fromRow: designProductRecordFromRow,
    sourceSummary,
    defaultStatus: options.defaultStatus || payload.status || 'draft',
    preserveExistingEmpty: Boolean(options.preserveExistingEmpty)
  });
}

function upsertDesignStyleRecord(styleId, payload) {
  return upsertDesignRecord({
    table: 'design_ai_style_records',
    idKey: 'style_id',
    idValue: styleId,
    payload,
    fields: DESIGN_AI_STYLE_FIELDS,
    fromRow: designStyleRecordFromRow,
    defaultStatus: payload.status || 'draft'
  });
}

function parseWorkspaceProducts(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return { product_id: text(item), x_mm: 0, y_mm: 0, rotation: 0 };
      return {
        product_id: text(item.product_id || item.id || item.sku || item.name),
        x_mm: number(item.x_mm ?? item.x ?? 0),
        y_mm: number(item.y_mm ?? item.y ?? 0),
        rotation: number(item.rotation ?? 0)
      };
    }).filter(item => item.product_id);
  }
  const raw = text(value);
  if (!raw) return [];
  const parsed = parseJson(raw, null);
  if (Array.isArray(parsed)) return parseWorkspaceProducts(parsed);
  return raw.split(/[\n,]/).map(item => ({ product_id: text(item), x_mm: 0, y_mm: 0, rotation: 0 })).filter(item => item.product_id);
}

function workspacePayloadFromBody(body = {}, fallback = {}) {
  const input = { ...(fallback || {}) };
  DESIGN_AI_WORKSPACE_FIELDS.forEach(field => {
    if (body[field] !== undefined) input[field] = body[field];
  });
  if (body.products !== undefined && body.products_json === undefined) input.products_json = body.products;
  if (body.customer_photos !== undefined && body.customer_photos_json === undefined) input.customer_photos_json = body.customer_photos;
  if (body.mockup_files !== undefined && body.mockup_files_json === undefined) input.mockup_files_json = body.mockup_files;
  return {
    title: text(input.title),
    customer_name: text(input.customer_name),
    vehicle_id: text(input.vehicle_id),
    products_json: JSON.stringify(parseWorkspaceProducts(input.products_json)),
    style_id: text(input.style_id),
    customer_notes: text(input.customer_notes),
    customer_photos_json: JSON.stringify(parseDesignList(input.customer_photos_json)),
    layout_json: jsonText(input.layout_json, '{}'),
    layout_notes: text(input.layout_notes),
    moodboard_text: text(input.moodboard_text),
    brochure_copy: text(input.brochure_copy),
    mockup_files_json: JSON.stringify(parseDesignList(input.mockup_files_json)),
    status: cleanWorkspaceStatus(input.status, 'draft')
  };
}

function workspaceFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    products: parseJson(row.products_json, []),
    customer_photos: parseJson(row.customer_photos_json, []),
    layout: parseJson(row.layout_json, {}),
    mockup_files: parseJson(row.mockup_files_json, [])
  };
}

function workspaceDetail(id) {
  return workspaceFromRow(db.prepare('SELECT * FROM design_ai_workspaces WHERE id=?').get(Number(id)));
}

function insertWorkspace(body, createdBy = '') {
  const payload = workspacePayloadFromBody(body);
  const result = db.prepare(`
    INSERT INTO design_ai_workspaces (
      title, customer_name, vehicle_id, products_json, style_id, customer_notes,
      customer_photos_json, layout_json, layout_notes, moodboard_text, brochure_copy,
      mockup_files_json, status, created_by_line_user_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    payload.title || 'Untitled Workspace',
    payload.customer_name,
    payload.vehicle_id,
    payload.products_json,
    payload.style_id,
    payload.customer_notes,
    payload.customer_photos_json,
    payload.layout_json,
    payload.layout_notes,
    payload.moodboard_text,
    payload.brochure_copy,
    payload.mockup_files_json,
    payload.status,
    createdBy || ''
  );
  return workspaceDetail(result.lastInsertRowid);
}

function updateWorkspace(id, body) {
  const existing = workspaceDetail(id);
  if (!existing) return null;
  const payload = workspacePayloadFromBody(body, {
    ...existing,
    products_json: existing.products,
    customer_photos_json: existing.customer_photos,
    layout_json: existing.layout,
    mockup_files_json: existing.mockup_files
  });
  db.prepare(`
    UPDATE design_ai_workspaces
    SET title=?, customer_name=?, vehicle_id=?, products_json=?, style_id=?, customer_notes=?,
      customer_photos_json=?, layout_json=?, layout_notes=?, moodboard_text=?, brochure_copy=?,
      mockup_files_json=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    payload.title || existing.title || 'Untitled Workspace',
    payload.customer_name,
    payload.vehicle_id,
    payload.products_json,
    payload.style_id,
    payload.customer_notes,
    payload.customer_photos_json,
    payload.layout_json,
    payload.layout_notes,
    payload.moodboard_text,
    payload.brochure_copy,
    payload.mockup_files_json,
    payload.status,
    existing.id
  );
  return workspaceDetail(existing.id);
}

function saveWorkspaceVersion(id, createdBy = '') {
  const workspace = workspaceDetail(id);
  if (!workspace) return null;
  const nextVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM design_ai_workspace_versions WHERE workspace_id=?').get(workspace.id).version || 1);
  db.prepare(`
    INSERT INTO design_ai_workspace_versions (workspace_id, version, snapshot_json, created_by_line_user_id)
    VALUES (?, ?, ?, ?)
  `).run(workspace.id, nextVersion, JSON.stringify(workspace), createdBy || '');
  return { workspace, version: nextVersion };
}

function designApprovedVehicle(vehicleId) {
  const id = text(vehicleId);
  if (!id) return null;
  return designVehicleRecordFromRow(db.prepare(`
    SELECT * FROM design_ai_vehicle_records
    WHERE lower(vehicle_id)=lower(?)
    ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 1
  `).get(id));
}

function designProductForPlacement(productId) {
  const id = text(productId);
  if (!id) return null;
  return designProductRecordFromRow(db.prepare(`
    SELECT * FROM design_ai_product_records
    WHERE lower(product_id)=lower(?) OR lower(sku)=lower(?) OR lower(name)=lower(?)
    ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 1
  `).get(id, id, id));
}

function layoutPreviewFromInput(body = {}) {
  const workspace = body.workspace_id ? workspaceDetail(body.workspace_id) : null;
  const vehicleId = text(body.vehicle_id || workspace?.vehicle_id);
  const rawPlacements = body.placements || body.products || workspace?.products || [];
  const placementsInput = parseWorkspaceProducts(rawPlacements);
  const warnings = [];
  const vehicle = designApprovedVehicle(vehicleId);
  const length = number(vehicle?.interior_length_mm, 0);
  const width = number(vehicle?.interior_width_mm, 0);
  if (!vehicle || vehicle.status !== 'approved') warnings.push('Missing approved vehicle dimensions.');
  if (!length || !width) warnings.push('Vehicle interior length/width is missing.');
  const placements = placementsInput.map((placement, index) => {
    const product = designProductForPlacement(placement.product_id);
    const itemWarnings = [];
    if (!product) itemWarnings.push('Missing approved product dimensions.');
    else if (product.status !== 'approved') itemWarnings.push('Product is using draft/not approved record.');
    const boxWidth = number(product?.layout_width_mm ?? product?.width_mm, 0);
    const boxHeight = number(product?.layout_depth_mm ?? product?.depth_mm ?? product?.height_mm, 0);
    if (!boxWidth || !boxHeight) itemWarnings.push('Product width/depth dimensions are missing.');
    const x = number(placement.x_mm, 0);
    const y = number(placement.y_mm, 0);
    if (length && width && boxWidth && boxHeight && (x < 0 || y < 0 || x + boxWidth > length || y + boxHeight > width)) {
      itemWarnings.push('Product exceeds vehicle boundary.');
    }
    const hasError = itemWarnings.some(w => /missing|exceeds/i.test(w));
    return {
      product_id: placement.product_id,
      label: product?.name || placement.product_id || `Product ${index + 1}`,
      x_mm: x,
      y_mm: y,
      width_mm: boxWidth,
      height_mm: boxHeight,
      rotation: number(placement.rotation, 0),
      status: hasError ? 'error' : (itemWarnings.length ? 'warning' : 'ok'),
      warnings: itemWarnings
    };
  });
  return {
    vehicle: {
      vehicle_id: vehicleId,
      length_mm: length,
      width_mm: width,
      scale: length && width ? Math.min(760 / length, 360 / width) : 0,
      wheel_arch_width_mm: number(vehicle?.wheel_arch_width_mm, 0),
      wheel_arch_height_mm: number(vehicle?.wheel_arch_height_mm, 0),
      wheel_arch_position_x_mm: number(vehicle?.wheel_arch_position_x_mm, 0),
      wheel_arch_position_y_mm: number(vehicle?.wheel_arch_position_y_mm, 0)
    },
    placements,
    warnings
  };
}

function approveExtractionDraft(id) {
  const draft = designExtractionFromRow(db.prepare('SELECT * FROM design_ai_extraction_drafts WHERE id=?').get(Number(id)));
  if (!draft) return null;
  const sourceSummary = {
    extraction_draft_id: draft.id,
    source_files: draft.source_files,
    confidence: draft.confidence,
    approved_at: new Date().toISOString()
  };
  let record;
  if (draft.entity_type === 'vehicle') {
    const vehicleId = text(draft.extracted.vehicle_id || draft.entity_id);
    record = upsertDesignVehicleRecord(vehicleId, {
      ...draft.extracted,
      floor_plan_notes: draft.extracted.floor_plan_notes || draft.extracted.notes || '',
      source_drive_folder_id: draft.source_drive_folder_id,
      status: 'approved'
    }, sourceSummary, { defaultStatus: 'approved', preserveExistingEmpty: true });
  } else {
    const productId = text(draft.extracted.product_id || draft.entity_id);
    record = upsertDesignProductRecord(productId, {
      ...draft.extracted,
      mounting_notes: draft.extracted.mounting_notes || draft.extracted.notes || '',
      installation_notes: draft.extracted.installation_notes || '',
      source_drive_folder_id: draft.source_drive_folder_id,
      status: 'approved'
    }, sourceSummary, { defaultStatus: 'approved', preserveExistingEmpty: true, preserveManualEstimates: true });
  }
  db.prepare('UPDATE design_ai_extraction_drafts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('approved', draft.id);
  return { draft: designExtractionFromRow(db.prepare('SELECT * FROM design_ai_extraction_drafts WHERE id=?').get(draft.id)), record };
}

function generationRecordsContext(request) {
  const vehicleId = text(request.vehicle_id);
  const products = parseJson(request.must_include_json, []);
  const styleId = text(request.style_id);
  const approvedRecords = { vehicle: null, products: [], style: null };
  const latestDrafts = { vehicle: null, products: [], style: null };
  if (vehicleId) {
    approvedRecords.vehicle = designVehicleRecordFromRow(db.prepare(`
      SELECT * FROM design_ai_vehicle_records
      WHERE status='approved' AND lower(vehicle_id)=lower(?)
      LIMIT 1
    `).get(vehicleId));
    if (!approvedRecords.vehicle) latestDrafts.vehicle = latestExtractionDraft('vehicle', vehicleId);
  }
  products.map(text).filter(Boolean).forEach(product => {
    const approved = designProductRecordFromRow(db.prepare(`
      SELECT * FROM design_ai_product_records
      WHERE status='approved' AND (lower(product_id)=lower(?) OR lower(name)=lower(?) OR lower(sku)=lower(?))
      LIMIT 1
    `).get(product, product, product));
    if (approved) {
      approvedRecords.products.push(approved);
    } else {
      const draft = latestExtractionDraft('product', product);
      if (draft) latestDrafts.products.push(draft);
    }
  });
  if (styleId) {
    approvedRecords.style = designStyleRecordFromRow(db.prepare(`
      SELECT * FROM design_ai_style_records
      WHERE status='approved' AND (lower(style_id)=lower(?) OR lower(name)=lower(?))
      LIMIT 1
    `).get(styleId, styleId));
  }
  return {
    approved_records: approvedRecords,
    latest_extraction_drafts: latestDrafts
  };
}

function parseJson(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function parseMustInclude(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(',').map(item => item.trim()).filter(Boolean);
}

function designRequestFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    must_include: parseJson(row.must_include_json, []),
    requested_by: row.requested_by || row.display_name || row.requested_by_line_user_id || ''
  };
}

function designResponseFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    layout: parseJson(row.layout_json, {}),
    raw_response: parseJson(row.raw_response_json, {})
  };
}

function latestDesignResponse(requestId) {
  return designResponseFromRow(db.prepare(`
    SELECT *
    FROM ai_design_responses
    WHERE request_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(requestId));
}

function designRequestDetail(id) {
  const row = db.prepare(`
    SELECT r.*, u.display_name AS requested_by
    FROM ai_design_requests r
    LEFT JOIN users u ON u.line_user_id=r.requested_by_line_user_id
    WHERE r.id=?
  `).get(Number(id));
  if (!row) return null;
  return {
    request: designRequestFromRow(row),
    response: latestDesignResponse(row.id)
  };
}

function saveDesignResponse(requestId, generated) {
  const raw = {
    ...generated,
    missing_data_warning: REQUIRED_MISSING_DATA,
    generated_at: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO ai_design_responses (
      request_id, ai_summary, layout_json, customer_proposal, lifestyle_prompt, raw_response_json
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    text(generated.ai_summary),
    JSON.stringify(generated.layout || {}),
    text(generated.customer_proposal),
    text(generated.lifestyle_prompt),
    JSON.stringify(raw)
  );
  db.prepare('UPDATE ai_design_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('completed', requestId);
  return latestDesignResponse(requestId);
}

async function notifyDesignResultReady(request) {
  const token = text(process.env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!token) {
    console.warn('LINE design notification skipped: LINE_CHANNEL_ACCESS_TOKEN missing.');
    return;
  }
  const configuredRecipients = text(process.env.LINE_DESIGN_NOTIFY_USER_IDS)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const recipients = configuredRecipients.length ? configuredRecipients : [request.requested_by_line_user_id].filter(Boolean);
  if (!recipients.length) {
    console.warn('LINE design notification skipped: no recipient LINE user ID.');
    return;
  }
  const body = [
    'CRDN AI Design Result Ready',
    `Vehicle: ${request.vehicle_id || '—'}`,
    `Lifestyle: ${request.customer_lifestyle || '—'}`,
    `Open: ${BASE_URL}/design-ai/requests/${request.id}`
  ].join('\n');
  await Promise.all(recipients.map(to => axios.post('https://api.line.me/v2/bot/message/push', {
    to,
    messages: [{ type: 'text', text: body }]
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  })));
}

function garageSettings() {
  return {
    garage_capacity: setting('garage_capacity', '2'),
    default_deposit_to_design_consulting_days: setting('default_deposit_to_design_consulting_days', '0'),
    default_design_consulting_to_3d_cad_days: setting('default_design_consulting_to_3d_cad_days', '0'),
    default_deposit_to_parts_ordered_days: setting('default_deposit_to_parts_ordered_days', '0'),
    default_parts_ordered_to_arrived_days: setting('default_parts_ordered_to_arrived_days', '7'),
    default_parts_arrived_to_garage_days: setting('default_parts_arrived_to_garage_days', '0'),
    default_build_days: setting('default_build_days', '14'),
    default_qc_days: setting('default_qc_days', '2'),
    default_qc_to_photoshoot_days: setting('default_qc_to_photoshoot_days', '0'),
    default_delivery_buffer_days: setting('default_delivery_buffer_days', '1')
  };
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
  const cost = row.count > 0 ? int(row.total) : 0;
  db.prepare('UPDATE consultation_items SET default_internal_cost=? WHERE id=?').run(cost, item.id);
  db.prepare(`
    UPDATE quote_items
    SET internal_cost=?, updated_at=CURRENT_TIMESTAMP
    WHERE consultation_item_id=? AND active=1
  `).run(cost, item.id);
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
app.get('/layout-concept', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'layout-concept.html')));
app.get('/layout-concept.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'layout-concept.html')));
app.get([
  '/design-ai',
  '/design-ai/settings',
  '/design-ai/library',
  '/design-ai/start',
  '/design-ai/new',
  '/design-ai/extractions/:id',
  '/design-ai/vehicles',
  '/design-ai/vehicles/:vehicleId',
  '/design-ai/products',
  '/design-ai/products/:productId',
  '/design-ai/styles',
  '/design-ai/styles/:styleId',
  '/design-ai/workspace',
  '/design-ai/workspace/:id',
  '/design-ai/moodboard/new',
  '/design-ai/moodboard/:id',
  '/design-ai/requests',
  '/design-ai/requests/:id'
], requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.use('/assets', express.static(path.join(__dirname, 'public')));

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({
    pipeline: PIPELINE_STAGES,
    priorities: PRIORITIES,
    part_statuses: PART_STATUSES,
    categories: setting('quote_categories', DEFAULT_CATEGORIES.join('\n')).split('\n').map(text).filter(Boolean),
    terms: setting('quote_terms'),
    garage_timeline: garageSettings(),
    user: req.session.user
  });
});

app.get('/api/agent/context', requireAgentRead, (req, res) => {
  res.json({
    app: 'CRDN Tracking App',
    routes: AGENT_ROUTE_LIST,
    timestamp: new Date().toISOString(),
    exposed_data: 'Read-only summaries for Design AI vehicle/product records, layout render request context, Telegram mockup request status summaries, and minimal project planning fields. Customer contact details, LINE session/auth data, secrets, Telegram tokens, file IDs, and payment-sensitive data are not exposed.'
  });
});

app.get('/api/agent/vehicles', requireAgentRead, (req, res) => {
  const records = db.prepare(`
    SELECT *
    FROM design_ai_vehicle_records
    ORDER BY updated_at DESC, vehicle_id COLLATE NOCASE
    LIMIT 500
  `).all().map(agentVehicleRecord);
  res.json({ records });
});

app.get('/api/agent/products', requireAgentRead, (req, res) => {
  const records = db.prepare(`
    SELECT *
    FROM design_ai_product_records
    ORDER BY updated_at DESC, product_id COLLATE NOCASE
    LIMIT 500
  `).all().map(agentProductRecord);
  res.json({ records });
});

app.get('/api/agent/mockups', requireAgentRead, (req, res) => {
  const requests = db.prepare(`
    SELECT id, caption, status, assigned_designer_name,
      result_uploaded_at, result_sent_to_telegram_at, created_at, updated_at
    FROM telegram_mockup_requests
    ORDER BY created_at DESC, id DESC
    LIMIT 200
  `).all().map(row => ({
    id: row.id,
    caption: row.caption || '',
    status: row.status || 'pending',
    assigned_designer_name: row.assigned_designer_name || '',
    result_status: {
      uploaded: Boolean(row.result_uploaded_at),
      sent_to_telegram: Boolean(row.result_sent_to_telegram_at),
      uploaded_at: row.result_uploaded_at || '',
      sent_to_telegram_at: row.result_sent_to_telegram_at || ''
    },
    created_at: row.created_at || '',
    updated_at: row.updated_at || ''
  }));
  res.json({ requests });
});

app.get('/api/agent/layout-render-requests/:id', requireAgentRead, (req, res) => {
  const detail = layoutAgentRenderRequestDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Layout render request not found.' });
  res.json(detail);
});

app.get('/api/agent/projects', requireAgentRead, (req, res) => {
  const projects = db.prepare(`
    SELECT id, job_no, name, stage, designer, priority, progress,
      start_date, finish_date, updated_at
    FROM vehicles
    WHERE archived=0
    ORDER BY updated_at DESC, id DESC
    LIMIT 300
  `).all().map(agentProjectSummary);
  res.json({ projects });
});

app.get('/api/agent/projects/:id', requireAgentRead, (req, res) => {
  const project = db.prepare(`
    SELECT id, job_no, name, stage, designer, priority, progress,
      start_date, finish_date, milestones_json, archived, created_at, updated_at
    FROM vehicles
    WHERE id=?
    LIMIT 1
  `).get(Number(req.params.id));
  const detail = agentProjectDetail(project);
  if (!detail) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project: detail });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const rows = dashboardRows(text(req.query.filter) || 'All');
  const allRows = dashboardRows('All');
  res.json({ summary: dashboardSummary(allRows), projects: rows });
});

app.get('/api/layout-concepts', requireAuth, (req, res) => {
  const concepts = db.prepare(`
    SELECT id, title, vehicle_key, vehicle_name, notes, created_by_line_user_id, created_at, updated_at
    FROM design_layout_concepts
    ORDER BY updated_at DESC, id DESC
    LIMIT 200
  `).all().map(row => layoutConceptFromRow(row));
  res.json({ concepts });
});

app.get('/api/layout-concepts/library-data', requireAuth, (req, res) => {
  res.json({
    vehicles: layoutConceptVehiclesForLibrary(),
    products: layoutConceptProductsForLibrary()
  });
});

app.get('/api/layout-concepts/:id/agent-render-requests', requireAuth, (req, res) => {
  const layout = db.prepare('SELECT id FROM design_layout_concepts WHERE id=?').get(Number(req.params.id));
  if (!layout) return res.status(404).json({ error: 'Layout concept not found.' });
  const requests = db.prepare(`
    SELECT *
    FROM layout_agent_render_requests
    WHERE layout_concept_id=?
    ORDER BY created_at DESC, id DESC
  `).all(layout.id).map(layoutAgentRenderRequestFromRow);
  res.json({ requests });
});

app.get('/api/layout-agent-render-requests/:id/result-image', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, result_image_path FROM layout_agent_render_requests WHERE id=?').get(id);
  const resultPath = row ? layoutRenderResultPath(row.result_image_path) : '';
  if (!row || !resultPath || !fs.existsSync(resultPath)) return res.status(404).send('Result image not found');

  res.setHeader('Content-Type', layoutRenderImageType(row.result_image_path));
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="layout-render-request-${id}-result${path.extname(resultPath) || '.jpg'}"`);
  }
  return res.sendFile(resultPath);
});

app.post('/api/layout-concepts/:id/send-to-agent', requireAuth, async (req, res) => {
  const layout = db.prepare('SELECT * FROM design_layout_concepts WHERE id=?').get(Number(req.params.id));
  if (!layout) return res.status(404).json({ error: 'Layout concept not found.' });
  const user = actor(req);
  const result = db.prepare(`
    INSERT INTO layout_agent_render_requests (
      layout_concept_id, status, requested_by_line_user_id, requested_by_name, updated_at
    )
    VALUES (?, 'pending', ?, ?, CURRENT_TIMESTAMP)
  `).run(layout.id, user.userId || '', user.displayName || '');

  const requestId = result.lastInsertRowid;
  const telegram = await sendLayoutAgentTelegramMessage(requestId, layout.id);
  if (telegram.sent) {
    db.prepare(`
      UPDATE layout_agent_render_requests
      SET status='sent', telegram_chat_id=?, telegram_message_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(telegram.chatId, telegram.messageId, requestId);
  }

  const row = db.prepare('SELECT * FROM layout_agent_render_requests WHERE id=?').get(requestId);
  res.status(201).json({
    ok: true,
    request: layoutAgentRenderRequestFromRow(row),
    telegram_sent: Boolean(telegram.sent),
    warning: telegram.sent ? '' : telegram.reason || ''
  });
});

app.get('/api/layout-concepts/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM design_layout_concepts WHERE id=?').get(Number(req.params.id));
  const concept = layoutConceptFromRow(row, true);
  if (!concept) return res.status(404).json({ error: 'Layout concept not found.' });
  res.json({ concept });
});

app.post('/api/layout-concepts', requireAuth, (req, res) => {
  try {
    const payload = layoutConceptPayload(req.body || {});
    const result = db.prepare(`
      INSERT INTO design_layout_concepts (
        title, vehicle_key, vehicle_name, layout_json, notes, created_by_line_user_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      payload.title,
      payload.vehicle_key,
      payload.vehicle_name,
      payload.layout_json,
      payload.notes,
      actor(req).userId || ''
    );
    const row = db.prepare('SELECT * FROM design_layout_concepts WHERE id=?').get(result.lastInsertRowid);
    res.status(201).json({ concept: layoutConceptFromRow(row, true) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save layout concept.' });
  }
});

app.patch('/api/layout-concepts/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM design_layout_concepts WHERE id=?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Layout concept not found.' });
  try {
    const payload = layoutConceptPayload(req.body || {}, existing);
    db.prepare(`
      UPDATE design_layout_concepts
      SET title=?, vehicle_key=?, vehicle_name=?, layout_json=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      payload.title,
      payload.vehicle_key,
      payload.vehicle_name,
      payload.layout_json,
      payload.notes,
      existing.id
    );
    const row = db.prepare('SELECT * FROM design_layout_concepts WHERE id=?').get(existing.id);
    res.json({ concept: layoutConceptFromRow(row, true) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not update layout concept.' });
  }
});

app.delete('/api/layout-concepts/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM design_layout_concepts WHERE id=?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Layout concept not found.' });
  res.json({ ok: true });
});


app.patch('/api/design-ai/library-files/archive-entity', requireAdmin, (req, res) => {
  try {
    const folderType = text(req.body.folder_type);
    const entityPath = text(req.body.entity_path);
    if (!folderType || !entityPath) return res.status(400).json({ error: 'folder_type and entity_path are required' });

    const result = db.prepare(`
      UPDATE design_library_files
      SET file_status='archived',
          archived_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      WHERE folder_type=?
        AND (path=? OR path LIKE ?)
    `).run(folderType, entityPath, `${entityPath}/%`);

    res.json({ ok: true, archived_count: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/design-ai/settings', requireAuth, (req, res) => {
  res.json({
    settings: designAiSettings(),
    status: designLibraryStatus()
  });
});

app.post('/api/design-ai/settings', requireAuth, (req, res) => {
  [
    'google_drive_root_folder_id',
    'vehicles_folder_id',
    'products_folder_id',
    'styles_folder_id',
    'templates_folder_id'
  ].forEach(key => {
    if (req.body[key] !== undefined) setDesignSetting(key, text(req.body[key]));
  });
  res.json({
    ok: true,
    settings: designAiSettings(),
    status: designLibraryStatus()
  });
});

app.post('/api/design-ai/sync-drive', requireAuth, async (req, res) => {
  try {
    repairDesignLibraryFilePaths();
    const result = await syncDriveFolders(designAiSettings());
    upsertDesignLibraryFiles(result.files);
    repairDesignLibraryFilePaths();
    setDesignSetting('last_sync_at', result.synced_at);
    setDesignSetting('last_sync_error', '');
    res.json({
      ok: true,
      synced_at: result.synced_at,
      indexed_count: result.files.length,
      folders: result.folders,
      status: designLibraryStatus()
    });
  } catch (err) {
    const message = err.message || 'Google Drive library sync failed.';
    setDesignSetting('last_sync_error', message);
    res.status(err.status || 502).json({
      error: message,
      status: designLibraryStatus()
    });
  }
});

app.get('/api/design-ai/library-files', requireAuth, (req, res) => {
  const folderType = text(req.query.folder_type || req.query.folder || 'all').toLowerCase();
  const files = designLibraryFiles(folderType);
  const activeFiles = activeDesignLibraryFiles(files);
  res.json({
    files,
    status: designLibraryStatus(),
    readiness: designLibraryReadiness(activeFiles, designExtractionStatusLookup()),
    required_checklist: {
      vehicle_required: ['vehicle.json', 'dimensions.csv', 'floorplan.svg'],
      vehicle_optional: ['mounting_points.csv', 'restricted_zones.csv', 'layout_constraints.json', 'buildability_report.md', 'manifest.json', 'vehicle_knowledge_sheet.pdf', 'scan.glb', 'photos/'],
      product_required: ['product.json', 'dimensions.csv', 'footprint.svg', 'installation_rules.json']
    }
  });
});

app.get('/api/design-ai/library-image/:driveFileId', requireAuth, async (req, res) => {
  try {
    const fileId = text(req.params.driveFileId);
    if (!fileId) return res.status(400).json({ error: 'Drive file id is required.' });

    const row = db.prepare(`
      SELECT drive_file_id, name, path, mime_type
      FROM design_library_files
      WHERE drive_file_id=?
        AND is_folder=0
      LIMIT 1
    `).get(fileId);

    if (!row) return res.status(404).json({ error: 'Library file not found.' });
    if (!String(row.mime_type || '').toLowerCase().startsWith('image/')) {
      return res.status(400).json({ error: 'Library file is not an image.' });
    }

    const drive = requireDriveClient();
    const response = await drive.files.get(
      {
        fileId,
        alt: 'media',
        supportsAllDrives: true
      },
      {
        responseType: 'stream'
      }
    );

    res.setHeader('Content-Type', row.mime_type || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    response.data.pipe(res);
  } catch (err) {
    console.warn('Design library image proxy failed:', err.message || err);
    res.status(err.status || 502).json({ error: 'Unable to load Drive image.' });
  }
});

app.patch('/api/design-ai/library-files/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const file = db.prepare('SELECT * FROM design_library_files WHERE id=?').get(id);
  if (!file) return res.status(404).json({ error: 'Library file not found.' });
  const action = text(req.body.action || req.body.file_status).toLowerCase();
  const now = new Date().toISOString();
  if (action === 'ignore') {
    db.prepare(`
      UPDATE design_library_files
      SET file_status='ignored', extraction_role='', ignored_at=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(now, id);
  } else if (action === 'archive' || action === 'archived') {
    db.prepare(`
      UPDATE design_library_files
      SET file_status='archived', extraction_role='', archived_at=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(now, id);
  } else if (action === 'primary') {
    db.prepare(`
      UPDATE design_library_files
      SET file_status='active', extraction_role='primary', ignored_at=NULL, archived_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);
  } else if (action === 'restore' || action === 'active') {
    db.prepare(`
      UPDATE design_library_files
      SET file_status='active', extraction_role='', ignored_at=NULL, archived_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);
  } else {
    return res.status(400).json({ error: 'Unsupported file action.' });
  }
  res.json({ file: db.prepare('SELECT * FROM design_library_files WHERE id=?').get(id) });
});

app.post('/api/design-ai/vehicles/:vehicleId/reset-extraction', requireAdmin, (req, res) => {
  const vehicleId = text(req.params.vehicleId);
  const deleted = db.prepare(`
    DELETE FROM design_ai_extraction_drafts
    WHERE entity_type='vehicle' AND lower(entity_id)=lower(?)
  `).run(vehicleId).changes;
  res.json({ ok: true, deleted_extraction_drafts: deleted });
});

app.post('/api/design-ai/vehicles/:vehicleId/reset-research-files', requireAdmin, (req, res) => {
  const vehicleId = text(req.params.vehicleId);
  const files = designVehicleLibraryFiles(vehicleId);
  const tx = db.transaction(rows => {
    rows.forEach(file => {
      db.prepare(`
        UPDATE design_library_files
        SET file_status='reset_pending', extraction_role='', ignored_at=NULL, archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(file.id);
    });
  });
  tx(files);
  res.json({ ok: true, marked_reset_pending: files.length });
});

app.post('/api/design-ai/vehicles/:vehicleId/full-reset', requireAdmin, (req, res) => {
  const vehicleId = text(req.params.vehicleId);
  const expected = `RESET ${vehicleId.toUpperCase()}`;
  if (text(req.body.confirmation) !== expected) {
    return res.status(400).json({ error: `Type ${expected} to confirm full reset.` });
  }
  const files = designVehicleLibraryFiles(vehicleId);
  const result = db.transaction(() => {
    const drafts = db.prepare(`
      DELETE FROM design_ai_extraction_drafts
      WHERE entity_type='vehicle' AND lower(entity_id)=lower(?)
    `).run(vehicleId).changes;
    const records = db.prepare('DELETE FROM design_ai_vehicle_records WHERE lower(vehicle_id)=lower(?)').run(vehicleId).changes;
    let fileRefs = 0;
    files.forEach(file => {
      fileRefs += db.prepare('DELETE FROM design_library_files WHERE id=?').run(file.id).changes;
    });
    return { drafts, records, fileRefs };
  })();
  res.json({ ok: true, ...result });
});

app.post('/api/design-ai/vehicles/:vehicleId/rebuild', requireAdmin, async (req, res) => {
  const vehicleId = text(req.params.vehicleId);
  try {
    const cleared = db.prepare(`
      DELETE FROM design_ai_extraction_drafts
      WHERE entity_type='vehicle' AND lower(entity_id)=lower(?)
    `).run(vehicleId).changes;
    repairDesignLibraryFilePaths();
    const syncResult = await syncDriveFolders(designAiSettings());
    upsertDesignLibraryFiles(syncResult.files);
    repairDesignLibraryFilePaths();
    setDesignSetting('last_sync_at', syncResult.synced_at);
    setDesignSetting('last_sync_error', '');
    const files = designEntityFolderFiles('vehicle', vehicleId, vehicleId);
    if (!files.length) return res.status(404).json({ error: 'No active Drive files found for this vehicle after sync.' });
    const sourceFolder = files.find(file => Number(file.is_folder) === 1 && text(file.path) === vehicleId) || files[0];
    const result = await extractDesignEntity({
      entity_type: 'vehicle',
      entity_id: vehicleId,
      folder_path: vehicleId,
      files
    });
    const draft = saveExtractionDraft({
      entityType: 'vehicle',
      entityId: vehicleId,
      folderPath: vehicleId,
      sourceDriveFolderId: sourceFolder?.drive_file_id || sourceFolder?.parent_drive_file_id || '',
      extracted: {
        ...result.extracted,
        _content_warnings: result.content_warnings || []
      },
      confidence: result.confidence,
      sourceFiles: result.source_files,
      createdBy: actor(req).userId || ''
    });
    res.json({
      ok: true,
      cleared_extraction_drafts: cleared,
      synced_at: syncResult.synced_at,
      indexed_count: syncResult.files.length,
      draft,
      extracted: draft.extracted
    });
  } catch (err) {
    const message = err.message || 'Vehicle rebuild failed.';
    setDesignSetting('last_sync_error', message);
    res.status(err.status || 502).json({ error: message });
  }
});

app.post('/api/design-ai/moodboards', requireAuth, (req, res) => {
  const input = moodboardInputFromBody(req.body || {});
  if (!input.vehicle_id) return res.status(400).json({ error: 'Vehicle ID is required.' });
  const raw = {
    input,
    created_by_line_user_id: actor(req).userId || '',
    created_at: new Date().toISOString()
  };
  const result = db.prepare(`
    INSERT INTO design_ai_moodboards (
      request_id, vehicle_id, title, customer_vehicle_image_drive_id, raw_response_json, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)
  `).run(
    input.request_id || null,
    input.vehicle_id,
    input.project_name || `${input.vehicle_id} Moodboard`,
    input.customer_vehicle_image_drive_id || '',
    JSON.stringify(raw)
  );
  res.status(201).json({ moodboard: moodboardDetail(result.lastInsertRowid) });
});

app.get('/api/design-ai/moodboards/:id', requireAuth, (req, res) => {
  const moodboard = moodboardDetail(req.params.id);
  if (!moodboard) return res.status(404).json({ error: 'Moodboard not found.' });
  res.json({ moodboard });
});

app.patch('/api/design-ai/moodboards/:id', requireAuth, (req, res) => {
  const existing = moodboardDetail(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Moodboard not found.' });
  const input = moodboardInputFromBody(req.body.input || req.body || {}, existing.input);
  const raw = {
    ...(existing.raw_response || {}),
    input,
    updated_by_line_user_id: actor(req).userId || '',
    updated_at: new Date().toISOString()
  };
  db.prepare(`
    UPDATE design_ai_moodboards
    SET request_id=?, vehicle_id=?, title=?, concept_text=?, key_features_json=?,
      layout_modes_json=?, material_palette_json=?, image_prompts_json=?, brochure_copy=?,
      customer_vehicle_image_drive_id=?, raw_response_json=?, status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    input.request_id || null,
    input.vehicle_id || existing.vehicle_id,
    text(req.body.title ?? existing.title ?? input.project_name),
    text(req.body.concept_text ?? existing.concept_text),
    req.body.key_features !== undefined ? JSON.stringify(req.body.key_features || []) : existing.key_features_json,
    req.body.layout_modes !== undefined ? JSON.stringify(req.body.layout_modes || []) : existing.layout_modes_json,
    req.body.material_palette !== undefined ? JSON.stringify(req.body.material_palette || []) : existing.material_palette_json,
    req.body.image_prompts !== undefined ? JSON.stringify(req.body.image_prompts || []) : existing.image_prompts_json,
    text(req.body.brochure_copy ?? existing.brochure_copy),
    input.customer_vehicle_image_drive_id || existing.customer_vehicle_image_drive_id || '',
    JSON.stringify(raw),
    text(req.body.status || existing.status || 'draft'),
    existing.id
  );
  res.json({ moodboard: moodboardDetail(existing.id) });
});

app.post('/api/design-ai/moodboards/:id/generate', requireAuth, async (req, res) => {
  const existing = moodboardDetail(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Moodboard not found.' });
  const input = moodboardInputFromBody(req.body.input || {}, existing.input);
  try {
    db.prepare('UPDATE design_ai_moodboards SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('generating', existing.id);
    const generated = await generateMoodboardConcept(input, designLibraryFiles('all'), moodboardRecordsContext(input));
    const moodboard = saveMoodboardGeneration(existing.id, input, generated);
    res.json({ moodboard });
  } catch (err) {
    db.prepare('UPDATE design_ai_moodboards SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('error', existing.id);
    res.status(err.status || 502).json({ error: err.message || 'Moodboard generation failed.', moodboard: moodboardDetail(existing.id) });
  }
});

app.post('/api/design-ai/extract', requireAuth, async (req, res) => {
  const entityType = designEntityType(req.body.entity_type);
  const entityId = text(req.body.entity_id || req.body.product_id || req.body.vehicle_id || req.body.folder_path);
  const folderPath = text(req.body.folder_path || entityId);
  if (!entityId) return res.status(400).json({ error: 'entity_id or folder_path is required.' });
  const files = designEntityFolderFiles(entityType, folderPath, entityId);
  if (!files.length) return res.status(404).json({ error: 'No indexed Drive files found for that folder. Sync Google Drive Library first.' });
  try {
    const sourceFolder = files.find(file => Number(file.is_folder) === 1 && text(file.path) === folderPath) || files[0];
    const result = await extractDesignEntity({
      entity_type: entityType,
      entity_id: entityId,
      folder_path: folderPath,
      files
    });
    const draft = saveExtractionDraft({
      entityType,
      entityId,
      folderPath,
      sourceDriveFolderId: sourceFolder?.drive_file_id || sourceFolder?.parent_drive_file_id || '',
      extracted: {
        ...result.extracted,
        _content_warnings: result.content_warnings || []
      },
      confidence: result.confidence,
      sourceFiles: result.source_files,
      createdBy: actor(req).userId || ''
    });
    res.status(201).json({ draft, extracted: draft.extracted });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Design AI extraction failed.' });
  }
});

app.get('/api/design-ai/extractions/:id', requireAuth, (req, res) => {
  const draft = designExtractionFromRow(db.prepare('SELECT * FROM design_ai_extraction_drafts WHERE id=?').get(Number(req.params.id)));
  if (!draft) return res.status(404).json({ error: 'Extraction draft not found.' });
  res.json({ draft });
});

app.patch('/api/design-ai/extractions/:id', requireAuth, (req, res) => {
  const draft = updateExtractionDraft(req.params.id, req.body || {});
  if (!draft) return res.status(404).json({ error: 'Extraction draft not found.' });
  res.json({ draft });
});

app.post('/api/design-ai/extractions/:id/approve', requireAuth, (req, res) => {
  const result = approveExtractionDraft(req.params.id);
  if (!result) return res.status(404).json({ error: 'Extraction draft not found.' });
  res.json(result);
});

app.get('/api/design-ai/vehicles', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM design_ai_vehicle_records
    ORDER BY updated_at DESC, vehicle_id COLLATE NOCASE
  `).all().map(designVehicleRecordFromRow);
  res.json({ records: rows });
});

app.get('/api/design-ai/vehicles/:vehicleId', requireAuth, (req, res) => {
  const record = designVehicleRecordFromRow(db.prepare('SELECT * FROM design_ai_vehicle_records WHERE lower(vehicle_id)=lower(?)').get(text(req.params.vehicleId)));
  if (!record) return res.status(404).json({ error: 'Vehicle record not found.' });
  res.json({ record });
});

app.post('/api/design-ai/vehicles', requireAuth, (req, res) => {
  const vehicleId = text(req.body.vehicle_id);
  if (!vehicleId) return res.status(400).json({ error: 'vehicle_id is required.' });
  const record = upsertDesignVehicleRecord(vehicleId, {
    ...req.body,
    status: req.body.status || 'draft'
  }, {
    manual_create: true,
    created_by_line_user_id: actor(req).userId || '',
    created_at: new Date().toISOString()
  });
  res.status(201).json({ record });
});

app.get('/api/design-ai/vehicles/:vehicleId/geometry-suggestion', requireAuth, async (req, res) => {
  try {
    const vehicleId = text(req.params.vehicleId);
    const vehicle = designVehicleRecordFromRow(
      db.prepare(
        'SELECT * FROM design_ai_vehicle_records WHERE lower(vehicle_id)=lower(?)'
      ).get(vehicleId)
    );

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle record not found.' });
    }

    const files = vehicleResearchFilesForRecord(vehicle);
    const research = await normalizeVehicleResearchFileCandidates(files, vehicle.vehicle_id);
    const researchFiles = vehicleResearchPayload(research, files);
    const layoutCandidate = research.items.layout_constraints;
    const file = layoutCandidate?.file || null;
    if (!file) {
      return res.json({
        status: 'missing',
        summary: {
          status: 'No suggestion found',
          confidence: '',
          source_file: '',
          generated_at: '',
          notes: 'Sync Google Drive after the Vehicle Research Agent uploads layout_constraints.json or an equivalent layout constraints JSON file.',
          warnings: research.warnings || []
        },
        research_files: researchFiles,
        suggestion: null
      });
    }

    const readable = await readDesignLibraryTextFile(file);
    let parsed;
    try {
      parsed = JSON.parse(readable.content || '{}');
    } catch (err) {
      return res.status(422).json({
        status: 'invalid',
        summary: {
          status: 'Invalid suggestion file',
          confidence: '',
          source_file: file.name || 'layout constraints JSON',
          generated_at: file.modified_time || '',
          notes: 'Detected layout constraints file could not be parsed as JSON.',
          warnings: [err.message, ...(research.warnings || [])]
        },
        file: {
          name: file.name,
          path: file.path,
          web_view_link: file.web_view_link || '',
          modified_time: file.modified_time || '',
          detected_type: layoutCandidate?.detected_type || '',
          match_type: layoutCandidate?.match_type || '',
          match_label: layoutCandidate?.match_label || ''
        },
        research_files: researchFiles,
        suggestion: null
      });
    }

    const suggestion = normalizeVehicleLayoutSuggestion(parsed, file);
    res.json({
      status: 'ai_suggested',
      summary: {
        status: 'AI Suggested',
        confidence: suggestion.metadata.confidence || 'MEDIUM',
        source_file: suggestion.metadata.source_file || file.name || 'layout_constraints.json',
        generated_at: suggestion.metadata.generated_at || file.modified_time || '',
        notes: suggestion.metadata.notes || '',
        warnings: [
          ...(suggestion.metadata.warnings || []),
          ...(research.warnings || [])
        ]
      },
      file: {
        name: file.name,
        path: file.path,
        web_view_link: file.web_view_link || '',
        modified_time: file.modified_time || '',
        detected_type: layoutCandidate?.detected_type || '',
        match_type: layoutCandidate?.match_type || '',
        match_label: layoutCandidate?.match_label || ''
      },
      research_files: researchFiles,
      suggestion
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: err.message || 'Vehicle geometry suggestion failed.'
    });
  }
});

app.patch('/api/layout-concepts/vehicles/:vehicleId/template-alignment', requireAuth, (req, res) => {
  const vehicleId = text(req.params.vehicleId);
  if (!vehicleId) return res.status(400).json({ error: 'vehicle id is required.' });

  const row = db.prepare('SELECT * FROM design_ai_vehicle_records WHERE lower(vehicle_id)=lower(?)').get(vehicleId);
  if (!row) return res.status(404).json({ error: 'Vehicle record not found.' });

  const buildArea = req.body?.build_area || {};
  const nextBuildArea = {
    x: number(buildArea.x ?? 0),
    y: number(buildArea.y ?? 0),
    scale: positiveNumber(buildArea.scale, 1)
  };

  if (!nextBuildArea.scale) {
    return res.status(400).json({ error: 'build_area scale is required.' });
  }

  const constraints = parseJsonPayload(row.layout_constraints_json) || {};
  constraints.template_alignment = {
    ...(constraints.template_alignment || {}),
    build_area: nextBuildArea,
    updated_at: new Date().toISOString()
  };

  db.prepare(`
    UPDATE design_ai_vehicle_records
    SET layout_constraints_json=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(JSON.stringify(constraints), row.id);

  const updated = db.prepare('SELECT * FROM design_ai_vehicle_records WHERE id=?').get(row.id);
  res.json({
    ok: true,
    vehicle: layoutConceptVehiclesForLibrary().find(v => String(v.key).toLowerCase() === String(vehicleId).toLowerCase()) || null,
    templateAlignment: layoutVehicleTemplateAlignment(updated)
  });
});

app.patch('/api/design-ai/vehicles/:vehicleId', requireAuth, (req, res) => {
  const vehicleId = text(req.params.vehicleId);
  if (!vehicleId) return res.status(400).json({ error: 'vehicle id is required.' });
  const nextId = text(req.body.vehicle_id || vehicleId);
  if (nextId !== vehicleId && db.prepare('SELECT 1 FROM design_ai_vehicle_records WHERE vehicle_id=?').get(vehicleId)) {
    db.prepare('UPDATE design_ai_vehicle_records SET vehicle_id=?, updated_at=CURRENT_TIMESTAMP WHERE vehicle_id=?').run(nextId, vehicleId);
  }
  const record = upsertDesignVehicleRecord(nextId, {
    ...req.body,
    status: text(req.body.status || undefined)
  }, {
    manual_edit: true,
    edited_by_line_user_id: actor(req).userId || '',
    edited_at: new Date().toISOString()
  });
  res.json({ record });
});

app.get('/api/design-ai/products', requireAuth, (req, res) => {
  const includeArchived = String(req.query.include_archived || '') === '1';
  const rows = db.prepare(`
    SELECT *
    FROM design_ai_product_records
    ${includeArchived ? '' : "WHERE COALESCE(status,'') <> 'archived'"}
    ORDER BY updated_at DESC, product_id COLLATE NOCASE
  `).all().map(designProductRecordFromRow);
  res.json({ records: rows, include_archived: includeArchived });
});

app.get('/api/design-ai/products/:productId', requireAuth, (req, res) => {
  const record = designProductRecordFromRow(db.prepare('SELECT * FROM design_ai_product_records WHERE lower(product_id)=lower(?)').get(text(req.params.productId)));
  if (!record) return res.status(404).json({ error: 'Product record not found.' });
  res.json({ record });
});

app.post('/api/design-ai/products', requireAdmin, (req, res) => {
  const productId = text(req.body.product_id);
  if (!productId) return res.status(400).json({ error: 'product_id is required.' });
  const record = upsertDesignProductRecord(productId, {
    ...req.body,
    status: req.body.status || 'draft'
  }, {
    manual_create: true,
    created_by_line_user_id: actor(req).userId || '',
    created_at: new Date().toISOString()
  });
  res.status(201).json({ record });
});

app.patch('/api/design-ai/products/:productId', requireAdmin, (req, res) => {
  const productId = text(req.params.productId);
  if (!productId) return res.status(400).json({ error: 'product id is required.' });

  const existing = db.prepare('SELECT * FROM design_ai_product_records WHERE lower(product_id)=lower(?)').get(productId);
  if (!existing) return res.status(404).json({ error: 'Product record not found.' });

  const nextId = text(req.body.product_id || productId);
  if (!nextId) return res.status(400).json({ error: 'product_id is required.' });

  if (nextId.toLowerCase() !== productId.toLowerCase()) {
    const duplicate = db.prepare('SELECT 1 FROM design_ai_product_records WHERE lower(product_id)=lower(?) AND id<>?').get(nextId, existing.id);
    if (duplicate) return res.status(409).json({ error: `Product ID already exists: ${nextId}` });
    db.prepare('UPDATE design_ai_product_records SET product_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextId, existing.id);
  }

  const record = upsertDesignProductRecord(nextId, {
    ...req.body,
    product_id: nextId,
    status: text(req.body.status || undefined)
  }, {
    manual_edit: true,
    edited_by_line_user_id: actor(req).userId || '',
    edited_at: new Date().toISOString()
  });
  res.json({ record });
});

app.patch('/api/design-ai/products/:productId/archive', requireAdmin, (req, res) => {
  const productId = text(req.params.productId);
  const record = designProductRecordFromRow(db.prepare('SELECT * FROM design_ai_product_records WHERE lower(product_id)=lower(?)').get(productId));
  if (!record) return res.status(404).json({ error: 'Product record not found.' });
  db.prepare('UPDATE design_ai_product_records SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('archived', record.id);
  res.json({ record: designProductRecordFromRow(db.prepare('SELECT * FROM design_ai_product_records WHERE id=?').get(record.id)) });
});

app.get('/api/design-ai/styles', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM design_ai_style_records
    ORDER BY updated_at DESC, style_id COLLATE NOCASE
  `).all().map(designStyleRecordFromRow);
  res.json({ records: rows });
});

app.get('/api/design-ai/styles/:styleId', requireAuth, (req, res) => {
  const record = designStyleRecordFromRow(db.prepare('SELECT * FROM design_ai_style_records WHERE lower(style_id)=lower(?)').get(text(req.params.styleId)));
  if (!record) return res.status(404).json({ error: 'Style record not found.' });
  res.json({ record });
});

app.post('/api/design-ai/styles', requireAuth, (req, res) => {
  const styleId = text(req.body.style_id);
  if (!styleId) return res.status(400).json({ error: 'style_id is required.' });
  const record = upsertDesignStyleRecord(styleId, { ...req.body, status: req.body.status || 'draft' });
  res.status(201).json({ record });
});

app.patch('/api/design-ai/styles/:styleId', requireAuth, (req, res) => {
  const styleId = text(req.params.styleId);
  if (!styleId) return res.status(400).json({ error: 'style id is required.' });
  const nextId = text(req.body.style_id || styleId);
  if (nextId !== styleId && db.prepare('SELECT 1 FROM design_ai_style_records WHERE style_id=?').get(styleId)) {
    db.prepare('UPDATE design_ai_style_records SET style_id=?, updated_at=CURRENT_TIMESTAMP WHERE style_id=?').run(nextId, styleId);
  }
  const record = upsertDesignStyleRecord(nextId, { ...req.body, status: req.body.status || undefined });
  res.json({ record });
});

app.get('/api/design-ai/workspaces', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM design_ai_workspaces
    ORDER BY updated_at DESC, id DESC
  `).all().map(workspaceFromRow);
  res.json({ workspaces: rows });
});

app.get('/api/design-ai/workspaces/:id', requireAuth, (req, res) => {
  const workspace = workspaceDetail(req.params.id);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found.' });
  const versions = db.prepare(`
    SELECT id, version, created_by_line_user_id, created_at
    FROM design_ai_workspace_versions
    WHERE workspace_id=?
    ORDER BY version DESC
  `).all(workspace.id);
  res.json({ workspace, versions });
});

app.post('/api/design-ai/workspaces', requireAuth, (req, res) => {
  const workspace = insertWorkspace(req.body || {}, actor(req).userId || '');
  res.status(201).json({ workspace });
});

app.patch('/api/design-ai/workspaces/:id', requireAuth, (req, res) => {
  const workspace = updateWorkspace(req.params.id, req.body || {});
  if (!workspace) return res.status(404).json({ error: 'Workspace not found.' });
  res.json({ workspace });
});

app.post('/api/design-ai/workspaces/:id/save-version', requireAuth, (req, res) => {
  const result = saveWorkspaceVersion(req.params.id, actor(req).userId || '');
  if (!result) return res.status(404).json({ error: 'Workspace not found.' });
  res.status(201).json(result);
});

app.post('/api/design-ai/layout/preview', requireAuth, (req, res) => {
  res.json({ layout: layoutPreviewFromInput(req.body || {}) });
});

app.post('/api/design-ai/requests', requireAuth, (req, res) => {
  const vehicleId = text(req.body.vehicle_id || req.body.vehicle_name || req.body.vehicle);
  if (!vehicleId) return res.status(400).json({ error: 'Vehicle ID or vehicle name is required.' });
  const result = db.prepare(`
    INSERT INTO ai_design_requests (
      requested_by_line_user_id, vehicle_id, customer_lifestyle, people_count,
      budget, must_include_json, style_id, notes, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(
    actor(req).userId || '',
    vehicleId,
    text(req.body.customer_lifestyle),
    int(req.body.people_count),
    number(req.body.budget),
    JSON.stringify(parseMustInclude(req.body.must_include ?? req.body.must_include_products)),
    text(req.body.style_id || req.body.style_name),
    text(req.body.notes)
  );
  res.status(201).json(designRequestDetail(result.lastInsertRowid));
});

app.get('/api/design-ai/requests', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.display_name AS requested_by,
      (SELECT created_at FROM ai_design_responses ar WHERE ar.request_id=r.id ORDER BY ar.created_at DESC, ar.id DESC LIMIT 1) AS response_created_at
    FROM ai_design_requests r
    LEFT JOIN users u ON u.line_user_id=r.requested_by_line_user_id
    ORDER BY r.created_at DESC, r.id DESC
  `).all().map(designRequestFromRow);
  res.json({ requests: rows });
});

app.get('/api/design-ai/requests/:id', requireAuth, (req, res) => {
  const detail = designRequestDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Design request not found.' });
  res.json(detail);
});

app.post('/api/design-ai/requests/:id/generate', requireAuth, async (req, res) => {
  const detail = designRequestDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Design request not found.' });
  try {
    db.prepare('UPDATE ai_design_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('generating', detail.request.id);
    const request = db.prepare('SELECT * FROM ai_design_requests WHERE id=?').get(detail.request.id);
    const files = designLibraryFiles('all');
    const generated = await generateDesignResponse(request, files, generationRecordsContext(request));
    const response = saveDesignResponse(request.id, generated);
    const updated = designRequestDetail(request.id);
    notifyDesignResultReady(updated.request).catch(err => {
      console.warn('LINE design notification failed:', err.response?.data || err.message || err);
    });
    res.json({ request: updated.request, response });
  } catch (err) {
    const message = err.message || 'AI design generation failed.';
    db.prepare('UPDATE ai_design_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('error', detail.request.id);
    res.status(err.status || 502).json({ error: message, request: designRequestDetail(detail.request.id)?.request || detail.request });
  }
});

app.post('/api/projects', requireAuth, (req, res) => {
  const owner = text(req.body.owner);
  const name = text(req.body.name || req.body.vehicle);
  if (!owner || !name) return res.status(400).json({ error: 'customer and vehicle are required' });
  const stage = normalizeStage(req.body.stage || '01 Intake');
  const result = db.prepare(`
    INSERT INTO vehicles (
      job_no, owner, name, customer_email, customer_phone, plate, pkg, stage, designer, priority, progress,
      start_date, finish_date, customer_update, customer_action, next_action, notes, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    text(req.body.job_no) || nextJobNo(),
    owner,
    name,
    text(req.body.customer_email),
    text(req.body.customer_phone),
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
      customer_email=?,
      customer_phone=?,
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
      stock_status_json=?,
      timeline_json=?,
      milestones_json=?,
      archived=?,
      updated_at=CURRENT_TIMESTAMP
  WHERE id=?
`).run(
    text(next.job_no),
    text(next.owner),
    text(next.name),
    text(next.customer_email),
    text(next.customer_phone),
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
    text(next.stock_status_json),
    jsonText(next.timeline_json, '{}'),
    jsonText(next.milestones_json, '[]'),
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
    WHERE ci.active=1 AND cc.active=1
    ORDER BY cc.sort_order, ci.sort_order, ci.id
  `).all();
  const selected = db.prepare('SELECT * FROM quote_items WHERE vehicle_id=? AND consultation_item_id IS NOT NULL AND active=1').all(project.id);
  const customItems = db.prepare(`
    SELECT *
    FROM quote_items
    WHERE vehicle_id=? AND consultation_item_id IS NULL
      AND (internal_notes IS NULL OR internal_notes NOT LIKE ?)
    ORDER BY active DESC, sort_order, id
  `).all(project.id, `${DELETED_CUSTOM_NOTE}%`);
  const selectedByItem = new Map(selected.map(row => [row.consultation_item_id, row]));
  const optionValuesByItem = new Map(selected.map(row => {
  try {
    return [row.consultation_item_id, JSON.parse(row.option_values_json || '{}')];
  } catch (err) {
    return [row.consultation_item_id, {}];
  }
}));
  const subpartsByItem = consultationSubpartsByItemIds(items.map(item => item.id));
  const options = db.prepare(`
    SELECT *
    FROM consultation_item_options
    WHERE active=1
    ORDER BY consultation_item_id, sort_order, id
  `).all();

  const choices = db.prepare(`
    SELECT *
    FROM consultation_item_option_choices
    WHERE active=1
    ORDER BY option_id, sort_order, id
  `).all();

  const answers = [];

  const choicesByOption = new Map();
  choices.forEach(choice=>{
    if(!choicesByOption.has(choice.option_id))choicesByOption.set(choice.option_id,[]);
    choicesByOption.get(choice.option_id).push(choice);
  });

  const answersByOption = new Map(answers.map(answer=>[answer.option_id,answer.value]));

  const optionsByItem = new Map();
  options.forEach(option=>{
    if(!optionsByItem.has(option.consultation_item_id))optionsByItem.set(option.consultation_item_id,[]);
    optionsByItem.get(option.consultation_item_id).push({
      ...option,
      value: optionValuesByItem.get(option.consultation_item_id)?.[option.id] ?? option.default_value ?? '',
      choices: choicesByOption.get(option.id) || []
    });
  });
  res.json({
    project: projectSummary(project),
    categories: categories.map(category => ({
      ...category,
      items: items.filter(item => item.category_id === category.id).map(item => ({
  	...item,
  	parts: subpartsByItem.get(item.id) || [],
  	subparts: subpartsByItem.get(item.id) || [],
	options: optionsByItem.get(item.id) || [],
	selected: selectedByItem.has(item.id),
	quote_item: selectedByItem.get(item.id) || null
      }))
	    })),
	    custom_items: customItems,
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
	  const itemOptions = req.body.itemOptions || {};
	  const warnings = [];
	  const packageMeta = packageMetaForVehicle(project.id);
	  const packageItemIds = new Set((packageMeta?.items || []).map(String));

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
    WHERE ci.active=1 AND cc.active=1
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
	      const packageIncluded = packageItemIds.has(String(item.id)) || packageItemIds.has(String(item.slug));
	      const existingPrice = existing && int(existing.customer_price) > 0 ? existing.customer_price : undefined;
	      const customerPrice = packageIncluded ? 0 : int(existingPrice ?? item.default_customer_price);
	      const internalCost = int(existing?.internal_cost ?? item.default_internal_cost);
      const supplier = text(existing?.supplier ?? item.supplier);
      const needOrder = !!item.need_order;
      const partsStatus = needOrder ? 'Need to Order' : 'Not Needed';
      const optionValues = itemOptions[item.slug] || itemOptions[String(item.id)] || {};
      const optionValuesJson = JSON.stringify(optionValues);

      if (existing) {
        db.prepare(`
          UPDATE quote_items
	  SET category=?, description=?, quantity=?, customer_price=?, internal_cost=?, supplier=?,
   	      need_order=?, parts_status=?, option_values_json=?, active=1, updated_at=CURRENT_TIMESTAMP          WHERE id=?
        `).run(
          item.category,
          item.name,
          qty,
          customerPrice,
          internalCost,
          supplier,
          needOrder ? 1 : 0,
          partsStatus,
	  optionValuesJson,
          existing.id
        );
      } else {
        db.prepare(`
          INSERT INTO quote_items (
            vehicle_id, consultation_item_id, category, description, quantity, customer_price,
	    internal_cost, supplier, need_order, parts_status, option_values_json, sort_order
          )
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
	  optionValuesJson,
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

  const customItems = Array.isArray(req.body.customItems) ? req.body.customItems : [];
  let activeCustomCount = 0;

  for (const custom of customItems) {
    const idFromString = String(custom.id || '').match(/^custom-(\d+)$/);
    const quoteItemId = Number(custom.quoteItemId || custom.quote_item_id || custom.dbId || (idFromString ? idFromString[1] : 0));
    const current = quoteItemId
      ? db.prepare('SELECT * FROM quote_items WHERE id=? AND vehicle_id=? AND consultation_item_id IS NULL').get(quoteItemId, project.id)
      : null;
    if (quoteItemId && !current) {
      return res.status(400).json({ error: 'Custom item does not belong to this project' });
    }
    if (current && parsePackageMeta(current.internal_notes)) {
      return res.status(400).json({ error: 'Package rows cannot be saved as custom items' });
    }
    const description = text(custom.description ?? custom.name ?? current?.description);
    const active = custom.active !== false && custom.active !== 0 && custom.selected !== false;

    if (!description && !current) continue;
    if (active) activeCustomCount += 1;

    const needOrder = bool(custom.need_order ?? current?.need_order);
    const partsStatus = needOrder
      ? (PART_STATUSES.includes(custom.parts_status) ? custom.parts_status : (PART_STATUSES.includes(current?.parts_status) ? current.parts_status : 'Need to Order'))
      : 'Not Needed';
    const category = text(custom.category ?? custom.cat ?? current?.category) || 'Custom';
    const qty = Math.max(0.01, number(custom.quantity ?? custom.qty ?? current?.quantity, 1));
    const customerPrice = int(custom.customer_price ?? custom.price ?? current?.customer_price);
    const internalCost = int(custom.internal_cost ?? custom.cost ?? current?.internal_cost);
    const supplier = text(custom.supplier ?? current?.supplier);
    const notes = text(custom.internal_notes ?? current?.internal_notes) || 'Custom consultation item';

    if (current) {
      db.prepare(`
        UPDATE quote_items
        SET category=?, description=?, quantity=?, customer_price=?, internal_cost=?, supplier=?,
            need_order=?, parts_status=?, internal_notes=?, active=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND vehicle_id=?
      `).run(
        category,
        description,
        qty,
        customerPrice,
        internalCost,
        supplier,
        needOrder ? 1 : 0,
        partsStatus,
        notes,
        active ? 1 : 0,
        current.id,
        project.id
      );
    } else if (active) {
      db.prepare(`
        INSERT INTO quote_items (
          vehicle_id, category, description, quantity, customer_price, internal_cost,
          supplier, need_order, parts_status, internal_notes, sort_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id,
        category,
        description,
        qty,
        customerPrice,
        internalCost,
        supplier,
        needOrder ? 1 : 0,
        partsStatus,
        notes,
        nextSort('quote_items', project.id)
      );
    }
  }

  activity(req, project.id, 'consultation saved', null, `${checkedItems.length + activeCustomCount} items selected`);

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
  const itemKey = String(req.params.itemId);

  const item = db.prepare(`
    SELECT *
    FROM consultation_items
    WHERE id=? OR slug=?
    LIMIT 1
  `).get(Number(itemKey) || 0, itemKey);

  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  const status = PART_STATUSES.includes(req.body.parts_status)
    ? req.body.parts_status
    : PART_STATUSES.includes(req.body.status)
      ? req.body.status
      : 'Need to Order';

  const existing = db.prepare(`
    SELECT *
    FROM quote_items
    WHERE vehicle_id=? AND consultation_item_id=? AND active=1
  `).get(project.id, item.id);

  if (!existing) return res.status(404).json({ error: 'Quote item not found' });

  db.prepare(`
    UPDATE quote_items
    SET parts_status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(status, existing.id);

  const activePart = db.prepare(`
    SELECT *
    FROM parts
    WHERE vehicle_id=? AND quote_item_id=? AND active=1
    LIMIT 1
  `).get(project.id, existing.id);

  if (activePart) {
    db.prepare(`
      UPDATE parts
      SET status=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(status, activePart.id);
  }

  activity(req, project.id, 'part status changed', existing.parts_status || '', `${existing.description}: ${status}`);

  res.json({
    ok: true,
    item_id: item.id,
    slug: item.slug,
    parts_status: status
  });
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
  const isProjectCustom = !current.consultation_item_id && !parsePackageMeta(current.internal_notes);
  const notes = isProjectCustom
    ? `${DELETED_CUSTOM_NOTE}:${text(current.internal_notes) || current.description || current.id}`
    : current.internal_notes;
  db.prepare('UPDATE quote_items SET active=0, internal_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(notes, current.id);
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

app.get('/api/packages', requireAuth, (req, res) => {
  let packages = [];
  try {
    const parsed = JSON.parse(setting('packages', '[]') || '[]');
    packages = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    packages = [];
  }
  res.json({ packages });
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
  const categories = db.prepare('SELECT * FROM consultation_categories WHERE active=1 ORDER BY sort_order, id').all();
  const items = db.prepare(`
    SELECT ci.*, cc.name AS category
    FROM consultation_items ci
    JOIN consultation_categories cc ON cc.id=ci.category_id
    WHERE ci.active=1 AND cc.active=1
    ORDER BY cc.sort_order, ci.sort_order, ci.id
  `).all();
  const subpartsByItem = consultationSubpartsByItemIds(items.map(item => item.id));
  const optionRows = db.prepare(`
  SELECT *
  FROM consultation_item_options
  WHERE active=1
  ORDER BY consultation_item_id, sort_order, id
`).all();

const choiceRows = db.prepare(`
  SELECT *
  FROM consultation_item_option_choices
  WHERE active=1
  ORDER BY option_id, sort_order, id
`).all();

const choicesByOption = new Map();

choiceRows.forEach(choice=>{
  if(!choicesByOption.has(choice.option_id)){
    choicesByOption.set(choice.option_id,[]);
  }
  choicesByOption.get(choice.option_id).push(choice);
});

const optionsByItem = new Map();

optionRows.forEach(option=>{
  if(!optionsByItem.has(option.consultation_item_id)){
    optionsByItem.set(option.consultation_item_id,[]);
  }

  optionsByItem.get(option.consultation_item_id).push({
    ...option,
    choices: choicesByOption.get(option.id) || []
  });
});
  res.json({
    users,
    service_master: serviceMaster,
    consultation: categories.map(category => ({
      ...category,
      items: items
        .filter(item => item.category_id === category.id)
	.map(item => ({
  	  ...item,
  	  subparts: subpartsByItem.get(item.id) || [],
  	  options: optionsByItem.get(item.id) || []
	}))
    })),
    pipeline: PIPELINE_STAGES,
    quote_categories: setting('quote_categories', DEFAULT_CATEGORIES.join('\n')),
    parts_categories: setting('parts_categories', DEFAULT_CATEGORIES.join('\n')),
	    quote_terms: setting('quote_terms'),
    contract_terms: setting('contract_terms'),
	    packages: setting('packages', '[]'),
	    ...garageSettings(),
	    google_sheets_sync: setting('google_sheets_sync', 'Not connected'),
	    master_cashflow_entries: setting('master_cashflow_entries', '[]')
	  });
	});
	
	app.patch('/api/admin/settings', requireAdmin, (req, res) => {
	  ['quote_categories', 'parts_categories', 'quote_terms', 'contract_terms', 'packages', 'google_sheets_sync', 'master_cashflow_entries', 'garage_capacity', 'default_deposit_to_design_consulting_days', 'default_design_consulting_to_3d_cad_days', 'default_deposit_to_parts_ordered_days', 'default_parts_ordered_to_arrived_days', 'default_parts_arrived_to_garage_days', 'default_build_days', 'default_qc_days', 'default_qc_to_photoshoot_days', 'default_delivery_buffer_days'].forEach(key => {
	    if (req.body[key] !== undefined) setSetting(key, req.body[key]);
	  });
  if (req.body.packages !== undefined) {
    syncPackageQuoteRows(req.body.packages);
  }
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

function telegramSenderName(from = {}) {
  return [from.first_name, from.last_name].map(text).filter(Boolean).join(' ') || text(from.username) || 'Team';
}

function telegramMockupDescription(caption = '') {
  return text(caption).replace(/^\/mockup(?:@\w+)?\s*/i, '').trim() || 'No description';
}

function normalizeMockupLookup(value = '') {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function mockupLookupTokens(value = '') {
  const stop = new Set(['the', 'and', 'for', 'with', 'crdn', 'mockup', 'photo', 'image', 'black', 'outdoor', 'lifestyle']);
  return normalizeMockupLookup(value).split(/\s+/).filter(token => token.length > 1 && !stop.has(token));
}

function scoreMockupProduct(record, captionNorm, captionTokens) {
  const aliases = [record.product_id, record.sku, record.name].map(normalizeMockupLookup).filter(Boolean);
  let score = 0;
  aliases.forEach((alias, index) => {
    if (!alias) return;
    if (captionNorm === alias) score = Math.max(score, 120 - index);
    if (captionNorm.includes(alias)) score = Math.max(score, 100 - index);
    const aliasTokens = alias.split(/\s+/).filter(Boolean);
    if (aliasTokens.length && aliasTokens.every(token => captionTokens.has(token))) {
      score = Math.max(score, Math.min(95, 45 + aliasTokens.length * 12 - index));
    }
  });
  return score;
}

function mockupProductLibraryFiles(product = {}) {
  const seen = new Map();
  const addRows = rows => rows.forEach(row => {
    if (row && !row.is_folder) seen.set(row.drive_file_id || `${row.name}:${row.path}`, row);
  });
  const sourceId = text(product.source_drive_folder_id);
  if (sourceId) {
    addRows(db.prepare(`
      SELECT drive_file_id, is_folder, name, path, mime_type, web_view_link, modified_time
      FROM design_library_files
      WHERE drive_file_id=? OR parent_drive_file_id=?
      ORDER BY is_folder DESC, modified_time DESC, id DESC
      LIMIT 12
    `).all(sourceId, sourceId));
  }
  (product.reference_files || []).slice(0, 8).forEach(ref => {
    const refId = text(ref.drive_file_id || ref.id);
    const refName = text(ref.name || ref.path);
    if (refId) {
      addRows(db.prepare(`
        SELECT drive_file_id, is_folder, name, path, mime_type, web_view_link, modified_time
        FROM design_library_files
        WHERE drive_file_id=?
        LIMIT 1
      `).all(refId));
    } else if (refName) {
      addRows(db.prepare(`
        SELECT drive_file_id, is_folder, name, path, mime_type, web_view_link, modified_time
        FROM design_library_files
        WHERE lower(name)=lower(?) OR lower(path)=lower(?)
        LIMIT 1
      `).all(refName, refName));
    }
  });
  const tokens = mockupLookupTokens([product.product_id, product.sku, product.name].filter(Boolean).join(' '));
  if (tokens.length) {
    const candidates = db.prepare(`
      SELECT drive_file_id, is_folder, name, path, mime_type, web_view_link, modified_time
      FROM design_library_files
      WHERE folder_type LIKE '%product%' OR folder_type='products'
      ORDER BY modified_time DESC, id DESC
      LIMIT 160
    `).all();
    candidates
      .map(row => ({
        row,
        score: tokens.reduce((sum, token) => sum + (normalizeMockupLookup(`${row.path} ${row.name}`).includes(token) ? 1 : 0), 0)
      }))
      .filter(item => item.score >= Math.min(2, tokens.length))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .forEach(item => addRows([item.row]));
  }
  return [...seen.values()].slice(0, 6);
}

function mockupProductReferenceForCaption(caption = '') {
  const captionNorm = normalizeMockupLookup(caption);
  const captionTokens = new Set(mockupLookupTokens(caption));
  if (!captionNorm) return null;

  const records = db.prepare(`
    SELECT *
    FROM design_ai_product_records
    ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 250
  `).all().map(designProductRecordFromRow);
  const bestRecord = records
    .map(record => ({ type: 'record', product: record, score: scoreMockupProduct(record, captionNorm, captionTokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (bestRecord) {
    const files = mockupProductLibraryFiles(bestRecord.product);
    return { ...bestRecord, files };
  }

  const drafts = db.prepare(`
    SELECT *
    FROM design_ai_extraction_drafts
    WHERE entity_type='product'
    ORDER BY updated_at DESC, id DESC
    LIMIT 150
  `).all().map(designExtractionFromRow);
  const bestDraft = drafts
    .map(draft => {
      const extracted = draft.extracted || {};
      const product = {
        product_id: extracted.product_id || draft.entity_id,
        sku: extracted.sku || '',
        name: extracted.name || draft.entity_id,
        category: extracted.category || '',
        width_mm: extracted.width_mm,
        depth_mm: extracted.depth_mm,
        height_mm: extracted.height_mm,
        mounting_type: extracted.mounting_type || '',
        mounting_notes: extracted.mounting_notes || extracted.notes || '',
        installation_notes: extracted.installation_notes || '',
        status: draft.status || 'draft',
        reference_files: draft.source_files || []
      };
      return { type: 'draft', product, draft_id: draft.id, score: scoreMockupProduct(product, captionNorm, captionTokens), files: draft.source_files || [] };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  return bestDraft || null;
}

function telegramMockupGeneratedPrompt(row = {}) {
  const caption = text(row.caption);
  const match = mockupProductReferenceForCaption(caption);
  const product = match?.product || {};
  const productName = text(product.name || product.product_id || product.sku) || 'the requested CRDN product or accessory';
  const dims = [product.width_mm, product.depth_mm, product.height_mm].filter(value => value !== null && value !== undefined && value !== '').join(' x ');
  const referenceLines = [];
  if (match) {
    referenceLines.push(`Matched CRDN Design AI product reference: ${[product.product_id, product.sku, product.name].map(text).filter(Boolean).join(' · ') || productName}.`);
    if (product.status) referenceLines.push(`Record status: ${product.status}${match.type === 'draft' ? ' extraction draft' : ' product record'}.`);
    if (product.category) referenceLines.push(`Category: ${product.category}.`);
    if (dims) referenceLines.push(`Dimensions: ${dims} ${product.unit || 'mm'}.`);
    if (product.mounting_type) referenceLines.push(`Mounting type: ${product.mounting_type}.`);
    if (product.mounting_notes) referenceLines.push(`Mounting notes: ${product.mounting_notes}.`);
    if (product.installation_notes) referenceLines.push(`Installation notes: ${product.installation_notes}.`);
    const files = (match.files || []).slice(0, 5).map(file => [file.path, file.name].map(text).filter(Boolean).join(' / ') || text(file.web_view_link)).filter(Boolean);
    if (files.length) referenceLines.push(`Google Drive / library references: ${files.join('; ')}.`);
  } else {
    referenceLines.push('No matching saved Design AI product record was found. Use the caption as the primary product request and avoid inventing exact dimensions.');
  }

  const prompt = [
    'Use the uploaded vehicle photo as the base image.',
    row.sender_name ? `This request came from ${text(row.sender_name)}.` : '',
    `Create a realistic customer preview mockup showing ${productName} installed on the vehicle.`,
    caption && caption !== 'No description' ? `Request details: ${caption}.` : '',
    'Use the source vehicle image context: keep the original vehicle shape, camera angle, lighting, proportions, background, and license plate unchanged.',
    ...referenceLines,
    'Apply CRDN brand direction: clean, practical, premium adventure-van hardware with realistic fitment and material finish.',
    'Make it look like a real installed product, not a fantasy concept.',
    'Do not change the vehicle body shape. Output should look like a customer preview mockup.'
  ].filter(Boolean).join(' ');

  return {
    generated_prompt: prompt,
    matched_product: match ? {
      source: match.type,
      product_id: product.product_id || '',
      sku: product.sku || '',
      name: product.name || '',
      status: product.status || '',
      score: match.score || 0
    } : null,
    product_references: match ? {
      product,
      files: (match.files || []).slice(0, 6)
    } : null
  };
}

function telegramMockupResponseRow(row) {
  return row ? { ...row, ...telegramMockupGeneratedPrompt(row) } : null;
}

async function telegramFilePath(fileId) {
  const token = text(process.env.TELEGRAM_BOT_TOKEN);
  if (!token || !fileId) return '';
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!response.ok) return '';
    const data = await response.json();
    return data.ok ? text(data.result?.file_path) : '';
  } catch (err) {
    console.warn('Telegram getFile failed:', err.message || err);
    return '';
  }
}

function telegramFileUrl(filePath) {
  const token = text(process.env.TELEGRAM_BOT_TOKEN);
  const cleanPath = text(filePath);
  if (!token || !cleanPath) return '';
  return `https://api.telegram.org/file/bot${token}/${cleanPath.split('/').map(encodeURIComponent).join('/')}`;
}

function ensureMockupResultDir() {
  fs.mkdirSync(MOCKUP_RESULT_DIR, { recursive: true });
}

function ensureLayoutRenderDir() {
  fs.mkdirSync(LAYOUT_RENDER_DIR, { recursive: true });
}

function mockupResultFilename(value) {
  const filename = path.basename(text(value));
  return filename && /^[a-zA-Z0-9._-]+$/.test(filename) ? filename : '';
}

function mockupResultPath(value) {
  const filename = mockupResultFilename(value);
  return filename ? path.join(MOCKUP_RESULT_DIR, filename) : '';
}

function mockupImageType(filename) {
  const ext = path.extname(text(filename)).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function layoutRenderResultFilename(value) {
  const filename = path.basename(text(value));
  return filename && /^[a-zA-Z0-9._-]+$/.test(filename) ? filename : '';
}

function layoutRenderResultPath(value) {
  const filename = layoutRenderResultFilename(value);
  return filename ? path.join(LAYOUT_RENDER_DIR, filename) : '';
}

function layoutRenderImageType(filename) {
  const ext = path.extname(text(filename)).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function layoutRenderImageExt(filePath, contentType) {
  const type = text(contentType).toLowerCase();
  const ext = path.extname(text(filePath)).toLowerCase().replace('.', '');
  if (type.includes('png') || ext === 'png') return 'png';
  if (type.includes('webp') || ext === 'webp') return 'webp';
  return 'jpg';
}

function layoutRenderRequestIdFromText(value) {
  const body = text(value);
  if (!body) return 0;
  const patterns = [
    /\bRequest\s*ID\s*:?\s*#?(\d+)\b/i,
    /\brender\s+request\s*:?\s*#?(\d+)\b/i,
    /#(\d+)\b/
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) return Number(match[1]) || 0;
  }
  return 0;
}

async function saveTelegramLayoutRenderResult({ requestId, caption, photos }) {
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const current = db.prepare('SELECT * FROM layout_agent_render_requests WHERE id=?').get(id);
  if (!current) return null;

  const photoList = Array.isArray(photos) ? photos : [];
  const largestPhoto = photoList[photoList.length - 1];
  if (!largestPhoto?.file_id) {
    throw Object.assign(new Error('Telegram photo is missing.'), { status: 400 });
  }

  const filePath = await telegramFilePath(largestPhoto.file_id);
  const fileUrl = telegramFileUrl(filePath);
  if (!fileUrl) {
    throw Object.assign(new Error('Telegram photo file is unavailable.'), { status: 502 });
  }

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw Object.assign(new Error(`Telegram photo download failed: HTTP ${response.status}`), { status: 502 });
  }

  const contentType = response.headers.get('content-type') || '';
  const ext = layoutRenderImageExt(filePath, contentType);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
    throw Object.assign(new Error('Telegram photo result is empty or too large.'), { status: 400 });
  }

  ensureLayoutRenderDir();
  const filename = `layout-render-request-${id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const resultPath = path.join(LAYOUT_RENDER_DIR, filename);
  fs.writeFileSync(resultPath, buffer);

  const previousPath = layoutRenderResultPath(current.result_image_path);
  if (previousPath && previousPath !== resultPath && fs.existsSync(previousPath)) {
    try { fs.unlinkSync(previousPath); } catch (err) { console.warn('Previous layout render cleanup failed:', err.message || err); }
  }

  db.prepare(`
    UPDATE layout_agent_render_requests
    SET status='ready',
        result_image_path=?,
        result_notes=?,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(filename, text(caption), id);

  return db.prepare('SELECT * FROM layout_agent_render_requests WHERE id=?').get(id);
}

async function sendTelegramMessage(chatId, reply) {
  const token = text(process.env.TELEGRAM_BOT_TOKEN);
  if (!token || !reply) {
    console.warn('Telegram sendMessage skipped: TELEGRAM_BOT_TOKEN missing or reply empty.');
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });
    if (!response.ok) console.warn('Telegram sendMessage failed:', response.status, await response.text());
    return response.ok;
  } catch (err) {
    console.warn('Telegram sendMessage failed:', err.message || err);
    return false;
  }
}


function findVehicleForLayout(queryText) {
  const q = text(queryText).replace(/^\/layout(?:@\w+)?/i, '').trim();
  if (!q) return null;
  const like = `%${q}%`;
  return db.prepare(`
    SELECT *
    FROM design_ai_vehicle_records
    WHERE vehicle_id LIKE ? OR model LIKE ? OR make LIKE ? OR brand LIKE ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(like, like, like, like);
}

function vehicleLayoutSvg(vehicle) {
  const vehicleName = [vehicle.make || vehicle.brand, vehicle.model || vehicle.vehicle_id].filter(Boolean).join(' ') || vehicle.vehicle_id || 'Vehicle';

  const overallL = Number(vehicle.overall_length_mm || vehicle.interior_length_mm || 0);
  const overallW = Number(vehicle.overall_width_mm || vehicle.interior_width_mm || 0);
  const overallH = Number(vehicle.overall_height_mm || 0);
  const interiorL = Number(vehicle.interior_length_mm || overallL * 0.5);
  const interiorW = Number(vehicle.interior_width_mm || overallW * 0.85);
  const interiorH = Number(vehicle.interior_height_mm || 0);
  const wheelbase = Number(vehicle.wheelbase_mm || 0);
  const sideDoorW = Number(vehicle.side_door_width_mm || 0);
  const sideDoorH = Number(vehicle.side_door_height_mm || 0);
  const payload = Number(vehicle.payload_kg || 0);
  const fmt = v => v ? String(Math.round(v)) : '-';

  const W = 1600;
  const H = 950;

  const tableX = 48;
  const tableY = 145;
  const tableW = 330;

  const carX = 480;
  const carY = 210;
  const carMaxW = 950;
  const carMaxH = 420;
  const scale = Math.min(carMaxW / overallL, carMaxH / overallW);

  const bodyW = overallL * scale;
  const bodyH = overallW * scale;
  const x = carX;
  const y = carY + (carMaxH - bodyH) / 2;

  const cabW = Math.max(180, bodyW * 0.25);
  const cargoW = Math.min(interiorL * scale, bodyW * 0.68);
  const cargoH = Math.min(interiorW * scale, bodyH * 0.78);
  const cargoX = x + bodyW - cargoW - 72;
  const cargoY = y + (bodyH - cargoH) / 2;

  const rearAxleX = x + bodyW * 0.77;
  const frontAxleX = wheelbase ? Math.max(x + bodyW * 0.20, rearAxleX - wheelbase * scale) : x + bodyW * 0.28;
  const wheelW = Math.max(42, bodyW * 0.055);
  const wheelH = Math.max(18, bodyH * 0.13);

  const sideDoorLine = sideDoorW ? `
    <line x1="${cargoX + cargoW * 0.30}" y1="${y + bodyH + 34}" x2="${cargoX + cargoW * 0.30 + Math.min(sideDoorW * scale, cargoW * 0.45)}" y2="${y + bodyH + 34}" stroke="#ca741f" stroke-width="4" stroke-dasharray="10 8"/>
    <text x="${cargoX + cargoW * 0.30}" y="${y + bodyH + 66}" font-family="Arial, sans-serif" font-size="19" fill="#9a4f0f">side door width ${fmt(sideDoorW)}mm</text>` : '';

  const wheelbaseLine = wheelbase ? `
    <line x1="${frontAxleX}" y1="${y + bodyH + 96}" x2="${rearAxleX}" y2="${y + bodyH + 96}" stroke="#111110" stroke-width="3"/>
    <text x="${(frontAxleX + rearAxleX) / 2}" y="${y + bodyH + 126}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="800" fill="#111110">${fmt(wheelbase)}mm wheelbase</text>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#ffffff"/>

  <text x="48" y="64" font-family="Arial, sans-serif" font-size="40" font-weight="900" fill="#111110">${escapeHtml(vehicleName).toUpperCase()}</text>
  <text x="48" y="108" font-family="Arial, sans-serif" font-size="28" font-weight="800" fill="#555">2D BIRD'S-EYE BASE LAYOUT</text>

  <rect x="${tableX}" y="${tableY}" width="${tableW}" height="360" rx="14" fill="#ffffff" stroke="#deded8" stroke-width="2"/>
  <rect x="${tableX}" y="${tableY}" width="${tableW}" height="48" rx="14" fill="#111110"/>
  <text x="${tableX + 22}" y="${tableY + 32}" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="#fff">DIMENSIONS (mm)</text>

  <text x="${tableX + 22}" y="${tableY + 88}" font-family="Arial, sans-serif" font-size="18" fill="#555">Overall L / W / H</text>
  <text x="${tableX + tableW - 22}" y="${tableY + 88}" text-anchor="end" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="#111">${fmt(overallL)} / ${fmt(overallW)} / ${fmt(overallH)}</text>

  <text x="${tableX + 22}" y="${tableY + 132}" font-family="Arial, sans-serif" font-size="18" fill="#555">Interior L / W / H</text>
  <text x="${tableX + tableW - 22}" y="${tableY + 132}" text-anchor="end" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="#111">${fmt(interiorL)} / ${fmt(interiorW)} / ${fmt(interiorH)}</text>

  <text x="${tableX + 22}" y="${tableY + 176}" font-family="Arial, sans-serif" font-size="18" fill="#555">Wheelbase</text>
  <text x="${tableX + tableW - 22}" y="${tableY + 176}" text-anchor="end" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="#111">${fmt(wheelbase)}</text>

  <text x="${tableX + 22}" y="${tableY + 220}" font-family="Arial, sans-serif" font-size="18" fill="#555">Side door W / H</text>
  <text x="${tableX + tableW - 22}" y="${tableY + 220}" text-anchor="end" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="#111">${fmt(sideDoorW)} / ${fmt(sideDoorH)}</text>

  <text x="${tableX + 22}" y="${tableY + 264}" font-family="Arial, sans-serif" font-size="18" fill="#555">Payload</text>
  <text x="${tableX + tableW - 22}" y="${tableY + 264}" text-anchor="end" font-family="Arial, sans-serif" font-size="18" font-weight="800" fill="#111">${payload ? fmt(payload) + ' kg' : '-'}</text>

  <text x="${tableX + 22}" y="${tableY + 318}" font-family="Arial, sans-serif" font-size="16" fill="#777">Vehicle ID: ${escapeHtml(vehicle.vehicle_id || '-')}</text>

  <g id="vehicle-base">
    <rect x="${x}" y="${y}" width="${bodyW}" height="${bodyH}" rx="46" fill="#fafaf7" stroke="#111110" stroke-width="4"/>
    <rect x="${x + 26}" y="${y + 34}" width="${cabW}" height="${bodyH - 68}" rx="28" fill="#eeeeea" stroke="#d0d0c8" stroke-width="2"/>
    <text x="${x + 64}" y="${y + bodyH / 2 + 8}" font-family="Arial, sans-serif" font-size="22" fill="#777">CAB</text>

    <rect x="${cargoX}" y="${cargoY}" width="${cargoW}" height="${cargoH}" rx="24" fill="#ffffff" stroke="#2563eb" stroke-width="4" stroke-dasharray="14 10"/>
    <text x="${cargoX + 28}" y="${cargoY + 42}" font-family="Arial, sans-serif" font-size="21" font-weight="800" fill="#1d4ed8">USABLE INTERIOR AREA</text>
    <text x="${cargoX + 28}" y="${cargoY + 76}" font-family="Arial, sans-serif" font-size="20" fill="#1d4ed8">${fmt(interiorL)}mm × ${fmt(interiorW)}mm</text>

    <rect x="${frontAxleX - wheelW / 2}" y="${y - wheelH / 2}" width="${wheelW}" height="${wheelH}" rx="9" fill="#111110"/>
    <rect x="${frontAxleX - wheelW / 2}" y="${y + bodyH - wheelH / 2}" width="${wheelW}" height="${wheelH}" rx="9" fill="#111110"/>
    <rect x="${rearAxleX - wheelW / 2}" y="${y - wheelH / 2}" width="${wheelW}" height="${wheelH}" rx="9" fill="#111110"/>
    <rect x="${rearAxleX - wheelW / 2}" y="${y + bodyH - wheelH / 2}" width="${wheelW}" height="${wheelH}" rx="9" fill="#111110"/>
  </g>

  <line x1="${x}" y1="${y - 72}" x2="${x + bodyW}" y2="${y - 72}" stroke="#111110" stroke-width="3"/>
  <text x="${x + bodyW / 2}" y="${y - 92}" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="900" fill="#111">${fmt(overallL)}mm overall length</text>

  <line x1="${x + bodyW + 76}" y1="${y}" x2="${x + bodyW + 76}" y2="${y + bodyH}" stroke="#111110" stroke-width="3"/>
  <text x="${x + bodyW + 108}" y="${y + bodyH / 2}" font-family="Arial, sans-serif" font-size="24" font-weight="900" fill="#111">${fmt(overallW)}mm</text>
  <text x="${x + bodyW + 108}" y="${y + bodyH / 2 + 28}" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#555">overall width</text>

  ${sideDoorLine}
  ${wheelbaseLine}

  <rect x="48" y="560" width="330" height="180" rx="14" fill="#ffffff" stroke="#deded8" stroke-width="2"/>
  <text x="70" y="600" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="#111">LEGEND</text>
  <line x1="72" y1="635" x2="135" y2="635" stroke="#2563eb" stroke-width="4" stroke-dasharray="12 8"/>
  <text x="156" y="642" font-family="Arial, sans-serif" font-size="18" fill="#333">usable interior boundary</text>
  <line x1="72" y1="682" x2="135" y2="682" stroke="#ca741f" stroke-width="4" stroke-dasharray="10 8"/>
  <text x="156" y="689" font-family="Arial, sans-serif" font-size="18" fill="#333">side door opening</text>

  <text x="48" y="890" font-family="Arial, sans-serif" font-size="18" fill="#777">Generated from CRDN stored dimensions. Clean base layout for product placement. Verify before fabrication.</text>
</svg>`;
}

async function sendTelegramSvgPhoto(chatId, svg, filename, caption) {
  const token = text(process.env.TELEGRAM_BOT_TOKEN);
  const cleanChatId = text(chatId);
  if (!token) throw Object.assign(new Error('Telegram bot token is not configured.'), { status: 500 });
  if (!cleanChatId) throw Object.assign(new Error('Telegram chat ID is missing.'), { status: 400 });

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const pngFilename = filename.replace(/\.svg$/i, '.png');

  const form = new FormData();
  form.append('chat_id', cleanChatId);
  form.append('caption', caption);
  form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), pngFilename);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Telegram sendPhoto failed: ${await response.text()}`), { status: 502 });
  }

  return response.json().catch(() => ({}));
}

async function telegramVehicleLayoutReply(chatId, queryText) {
  const vehicle = findVehicleForLayout(queryText);

  if (!vehicle) {
    await sendTelegramMessage(chatId, 'Vehicle not found. Usage: /layout VEHICLE_NAME, for example /layout TownAce');
    return true;
  }

  if (!Number(vehicle.overall_length_mm || vehicle.interior_length_mm) || !Number(vehicle.overall_width_mm || vehicle.interior_width_mm)) {
    await sendTelegramMessage(
      chatId,
      `${vehicle.vehicle_id || vehicle.model} exists, but it does not yet have enough dimensions to generate a layout. Add overall/interior length and width first.`
    );
    return true;
  }

  const svg = vehicleLayoutSvg(vehicle);
  const filename = `${slugify(vehicle.vehicle_id || vehicle.model || 'vehicle')}-layout.svg`;
  const caption = `${vehicle.make || vehicle.brand || ''} ${vehicle.model || vehicle.vehicle_id} 2D birdseye layout`.trim();
  await sendTelegramSvgPhoto(chatId, svg, filename, caption);
  return true;
}

async function sendTelegramPhoto(chatId, filename, caption) {
  const token = text(process.env.TELEGRAM_BOT_TOKEN);
  const cleanChatId = text(chatId);
  const resultPath = mockupResultPath(filename);
  if (!token) throw Object.assign(new Error('Telegram bot token is not configured.'), { status: 500 });
  if (!cleanChatId) throw Object.assign(new Error('Telegram chat ID is missing.'), { status: 400 });
  if (!resultPath || !fs.existsSync(resultPath)) throw Object.assign(new Error('Result image is missing.'), { status: 400 });

  const buffer = fs.readFileSync(resultPath);
  const form = new FormData();
  form.append('chat_id', cleanChatId);
  form.append('caption', caption);
  form.append('photo', new Blob([buffer], { type: mockupImageType(filename) }), path.basename(resultPath));

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  if (!response.ok) {
    const body = await response.text();
    throw Object.assign(new Error(`Telegram sendPhoto failed: ${body}`), { status: 502 });
  }
  const data = await response.json().catch(() => ({}));
  if (data && data.ok === false) {
    throw Object.assign(new Error(`Telegram sendPhoto failed: ${data.description || 'Unknown error'}`), { status: 502 });
  }
  return data;
}

function saveTelegramMockupRequest({ chatId, messageId, senderName, caption, fileId, filePath }) {
  const result = db.prepare(`
    INSERT INTO telegram_mockup_requests (
      chat_id, message_id, sender_name, caption, file_id, file_path, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(
    text(chatId),
    text(messageId),
    text(senderName),
    text(caption),
    text(fileId),
    text(filePath)
  );
  return db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(result.lastInsertRowid);
}

app.get('/api/telegram/mockup-requests', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM telegram_mockup_requests
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).all();
  const requests = rows.map(telegramMockupResponseRow);
  const designers = db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE role IN ('admin','member')
    ORDER BY display_name COLLATE NOCASE, id
  `).all();
  res.json({ requests, designers });
});

app.patch('/api/telegram/mockup-requests/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(id);
  if (!current) return res.status(404).json({ error: 'Mockup request not found.' });

  const updates = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    const status = text(req.body.status).toLowerCase();
    if (!TELEGRAM_MOCKUP_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    updates.push('status=?');
    values.push(status);
  }

  if (
    Object.prototype.hasOwnProperty.call(req.body, 'assigned_designer_user_id') ||
    Object.prototype.hasOwnProperty.call(req.body, 'assigned_designer_name')
  ) {
    const rawUserId = text(req.body.assigned_designer_user_id);
    const userId = Number(rawUserId);
    const manualName = text(req.body.assigned_designer_name);
    let designerUserId = null;
    let designerName = '';

    if (rawUserId && (!Number.isInteger(userId) || userId <= 0)) {
      return res.status(400).json({ error: 'Designer must be an active admin or member.' });
    }

    if (Number.isFinite(userId) && userId > 0) {
      const user = db.prepare(`
        SELECT id, display_name
        FROM users
        WHERE id=? AND role IN ('admin','member')
      `).get(userId);
      if (!user) return res.status(400).json({ error: 'Designer must be an active admin or member.' });
      designerUserId = user.id;
      designerName = text(user.display_name) || `User #${user.id}`;
    } else if (manualName) {
      designerName = manualName;
    }

    updates.push('assigned_designer_user_id=?', 'assigned_designer_name=?');
    values.push(designerUserId, designerName);
  }

  if (!updates.length) return res.status(400).json({ error: 'No update supplied.' });

  const result = db.prepare(`
    UPDATE telegram_mockup_requests
    SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(...values, id);
  if (!result.changes) return res.status(404).json({ error: 'Mockup request not found.' });
  const row = db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(id);
  res.json({ request: telegramMockupResponseRow(row) });
});

app.get('/api/telegram/mockup-requests/:id/image', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, file_id, file_path FROM telegram_mockup_requests WHERE id=?').get(id);
  if (!row || !row.file_id) return res.status(404).send('Image not found');

  let filePath = text(row.file_path);
  if (!filePath) {
    filePath = await telegramFilePath(row.file_id);
    if (filePath) {
      db.prepare('UPDATE telegram_mockup_requests SET file_path=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(filePath, id);
    }
  }

  const url = telegramFileUrl(filePath);
  if (!url) return res.status(404).send('Image not available');

  try {
    const response = await fetch(url);
    if (!response.ok) return res.status(502).send('Telegram image fetch failed');
    const type = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (req.query.download === '1') {
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      res.setHeader('Content-Disposition', `attachment; filename="mockup-request-${id}-source.${ext}"`);
    }
    return res.send(buffer);
  } catch (err) {
    console.warn('Telegram image proxy failed:', err.message || err);
    return res.status(502).send('Telegram image fetch failed');
  }
});

app.get('/api/telegram/mockup-requests/:id/result-image', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, result_image_path FROM telegram_mockup_requests WHERE id=?').get(id);
  const resultPath = row ? mockupResultPath(row.result_image_path) : '';
  if (!row || !resultPath || !fs.existsSync(resultPath)) return res.status(404).send('Result image not found');

  res.setHeader('Content-Type', mockupImageType(row.result_image_path));
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="mockup-request-${id}-result${path.extname(resultPath) || '.jpg'}"`);
  }
  return res.sendFile(resultPath);
});

app.post('/api/telegram/mockup-requests/:id/result-image', requireAuth, express.text({ type: 'text/plain', limit: '12mb' }), (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(id);
  if (!current) return res.status(404).json({ error: 'Mockup request not found.' });

  let payload = {};
  try {
    payload = JSON.parse(String(req.body || '{}'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid upload payload.' });
  }

  const mime = text(payload.type).toLowerCase();
  const ext = MOCKUP_IMAGE_TYPES[mime];
  const base64 = text(payload.data).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if (!ext || !base64) return res.status(400).json({ error: 'Upload a JPG, PNG, or WebP image.' });

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Invalid image data.' });
  }
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: 'Result image must be 8MB or smaller.' });
  }

  ensureMockupResultDir();
  const filename = `mockup-result-${id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MOCKUP_RESULT_DIR, filename), buffer);

  const previousPath = mockupResultPath(current.result_image_path);
  if (previousPath && previousPath !== path.join(MOCKUP_RESULT_DIR, filename) && fs.existsSync(previousPath)) {
    try { fs.unlinkSync(previousPath); } catch (err) { console.warn('Previous mockup result cleanup failed:', err.message || err); }
  }

  db.prepare(`
    UPDATE telegram_mockup_requests
    SET result_image_path=?,
        result_uploaded_at=CURRENT_TIMESTAMP,
        result_sent_to_telegram_at=NULL,
        status='done',
        updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(filename, id);
  const row = db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(id);
  res.json({ request: telegramMockupResponseRow(row) });
});

app.post('/api/telegram/mockup-requests/:id/send-result', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Mockup request not found.' });
  if (!row.result_image_path) return res.status(400).json({ error: 'Upload a result image first.' });

  try {
    await sendTelegramPhoto(row.chat_id, row.result_image_path, `Mockup request #${row.id} completed.`);
    db.prepare(`
      UPDATE telegram_mockup_requests
      SET status='done',
          result_sent_to_telegram_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(id);
    const updated = db.prepare('SELECT * FROM telegram_mockup_requests WHERE id=?').get(id);
    res.json({ request: telegramMockupResponseRow(updated) });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Could not send result to Telegram.' });
  }
});


function telegramFormatProjectSummary(project) {
  const parts = [
    `#${project.id} ${project.job_no ? `[${project.job_no}] ` : ''}${project.name || 'Untitled project'}`,
    `Stage: ${project.stage || '-'}`,
    `Designer: ${project.designer || '-'}`,
    `Priority: ${project.priority || '-'}`,
    `Progress: ${project.progress ?? 0}%`
  ];
  if (project.start_date || project.finish_date) parts.push(`Timeline: ${project.start_date || '-'} → ${project.finish_date || '-'}`);
  return parts.join('\n');
}

function telegramListProjectsReply() {
  const projects = db.prepare(`
    SELECT id, job_no, name, stage, designer, priority, progress,
      start_date, finish_date, updated_at
    FROM vehicles
    WHERE archived=0
    ORDER BY updated_at DESC, id DESC
    LIMIT 10
  `).all().map(agentProjectSummary);

  if (!projects.length) return 'No active CRDN projects found.';

  return [
    `Active CRDN projects: ${projects.length} shown`,
    '',
    ...projects.map(p => telegramFormatProjectSummary(p))
  ].join('\n\n');
}

function telegramProjectLookupReply(queryText) {
  const query = text(queryText).replace(/^\/project(?:@\w+)?/i, '').trim();
  if (!query) return 'Usage: /project PROJECT_ID or /project PROJECT_NAME';

  let row = null;
  const id = Number(query);
  if (Number.isFinite(id) && id > 0) {
    row = db.prepare(`
      SELECT id, job_no, name, stage, designer, priority, progress,
        start_date, finish_date, milestones_json, archived, created_at, updated_at
      FROM vehicles
      WHERE id=?
      LIMIT 1
    `).get(id);
  }

  if (!row) {
    row = db.prepare(`
      SELECT id, job_no, name, stage, designer, priority, progress,
        start_date, finish_date, milestones_json, archived, created_at, updated_at
      FROM vehicles
      WHERE archived=0 AND (
        name LIKE ? OR job_no LIKE ? OR stage LIKE ? OR designer LIKE ?
      )
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  }

  const detail = agentProjectDetail(row);
  if (!detail) return `No project found for: ${query}`;

  const milestones = Array.isArray(detail.milestones) ? detail.milestones : [];
  const milestoneLines = milestones.slice(0, 8).map(m => {
    return `- ${m.label || m.key}: ${m.status || '-'}${m.scheduled_date ? ` / ${m.scheduled_date}` : ''}`;
  });

  return [
    telegramFormatProjectSummary(detail),
    '',
    `Updated: ${detail.updated_at || '-'}`,
    milestoneLines.length ? `Milestones:\n${milestoneLines.join('\n')}` : 'Milestones: none'
  ].join('\n');
}

function telegramMockupsReply() {
  const rows = db.prepare(`
    SELECT id, caption, status, assigned_designer_name,
      result_uploaded_at, result_sent_to_telegram_at, created_at, updated_at
    FROM telegram_mockup_requests
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all();

  if (!rows.length) return 'No Telegram mockup requests found.';

  return [
    `Latest mockup requests: ${rows.length} shown`,
    '',
    ...rows.map(r => [
      `#${r.id} ${r.status || 'pending'}`,
      `Caption: ${r.caption || '-'}`,
      `Designer: ${r.assigned_designer_name || '-'}`,
      `Uploaded: ${r.result_uploaded_at ? 'yes' : 'no'}`,
      `Sent: ${r.result_sent_to_telegram_at ? 'yes' : 'no'}`
    ].join('\n'))
  ].join('\n\n');
}

function telegramContextReply() {
  return [
    'CRDN Agent read-only context:',
    '- Active project summaries',
    '- Project detail + milestones',
    '- Design AI vehicle records',
    '- Design AI product records',
    '- Telegram mockup request status',
    '',
    'No customer contact info, LINE auth/session data, Telegram secrets, or write actions are exposed.'
  ].join('\n');
}


async function telegramAgentChatReply(userText) {
  if (!openai) return 'AI chat is not configured yet. OPENAI_API_KEY is missing.';

  const tools = [
    {
      type: 'function',
      name: 'get_crdn_context',
      description: 'Get CRDN read-only API context and available data categories.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      type: 'function',
      name: 'list_crdn_projects',
      description: 'List safe active CRDN project summaries.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      type: 'function',
      name: 'get_crdn_project',
      description: 'Get safe CRDN project detail and milestones by project id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'list_crdn_mockups',
      description: 'List safe Telegram mockup request summaries.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      type: 'function',
      name: 'list_crdn_products',
      description: 'List safe CRDN product records from Design AI database.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      type: 'function',
      name: 'get_crdn_product',
      description: 'Get one safe CRDN product detail by product_id, sku, or name search.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'list_crdn_vehicles',
      description: 'List safe CRDN vehicle records from Design AI database.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      type: 'function',
      name: 'get_crdn_layout_render_request',
      description: 'Get a CRDN layout render request package by request id, including vehicle, layout, products, placements, rotations, and AI render brief.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
        additionalProperties: false
      }
    }
  ];

  const system = [
    'You are CRDN Agent inside Telegram.',
    'Answer naturally and concisely.',
    'Use CRDN tools when the user asks about projects, milestones, mockups, products, vehicles, due dates, current status, or layout render requests. For one specific product, use get_crdn_product before answering. For layout render requests, use get_crdn_layout_render_request, not get_crdn_project.',
    'Do not expose secrets, customer contact info, tokens, LINE auth/session data, or private implementation details.',
    'Telegram AI chat is read-only for now. If the user asks to change data, say you cannot write yet.',
    'For mockup creation, tell the user to send a vehicle photo with /mockup and a description.'
  ].join('\n');

  let input = [
    { role: 'system', content: system },
    { role: 'user', content: userText }
  ];

  for (let i = 0; i < 4; i += 1) {
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input,
      tools,
      max_output_tokens: 700
    });

    const calls = (response.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) {
      const answer = text(response.output_text || '').trim();
      return answer || 'I could not generate a useful answer.';
    }

    input = input.concat(response.output);

    for (const call of calls) {
      let args = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch (_) {
        args = {};
      }

      let result;
      try {
        result = handleMcpToolCall(call.name, args);
      } catch (err) {
        result = { error: err.message || 'Tool call failed.' };
      }

      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result)
      });
    }
  }

  return 'I could not finish the CRDN lookup in time. Please try a more specific question.';
}

app.post('/api/telegram/webhook/:secret', async (req, res) => {
  try {
    if (req.params.secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(403).json({ ok: false });
    }

    const update = req.body;
    const message = update.message;
    if (!message) return res.json({ ok: true });

    const chatId = String(message.chat.id);
    const allowed = process.env.TELEGRAM_ALLOWED_CHAT_IDS;

    if (allowed && !allowed.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).includes(chatId)) {
      return res.json({ ok: true });
    }

    const text = message.text || message.caption || '';
    const senderName = telegramSenderName(message.from);
    const photos = Array.isArray(message.photo) ? message.photo : [];

    let reply = '';
    const layoutRenderRequestId = photos.length && !/^\/mockup(?:@\w+)?/i.test(text)
      ? layoutRenderRequestIdFromText(text)
      : 0;
    if (layoutRenderRequestId) {
      try {
        const saved = await saveTelegramLayoutRenderResult({
          requestId: layoutRenderRequestId,
          caption: text,
          photos
        });
        reply = saved
          ? `Layout render request #${layoutRenderRequestId} saved.\nStatus: ready`
          : `Could not find layout render request #${layoutRenderRequestId}.`;
      } catch (err) {
        console.warn('Layout render Telegram save failed:', err.message || err);
        reply = `Could not save layout render request #${layoutRenderRequestId}: ${err.message || 'Unknown error'}`;
      }
      await sendTelegramMessage(chatId, reply);
      return res.json({ ok: true });
    }

    if (text.startsWith('/status')) {
      reply = `CRDN Agent online.\nChat ID: ${chatId}`;
    } else if (/^\/help(?:@\w+)?/i.test(text)) {
      reply = [
        'CRDN Agent commands:',
        '/status - check bot status',
        '/help - show commands',
        '/context - show read-only agent scope',
        '/projects - list active projects',
        '/project PROJECT_ID_OR_NAME - project lookup',
        '/mockups - list latest mockup requests',
        '/layout VEHICLE_NAME - send 2D vehicle birdseye layout',
        '/mockup DESCRIPTION - save mockup request with photo'
      ].join('\n');
    } else if (/^\/context(?:@\w+)?/i.test(text)) {
      reply = telegramContextReply();
    } else if (/^\/projects(?:@\w+)?/i.test(text)) {
      reply = telegramListProjectsReply();
    } else if (/^\/project(?:@\w+)?/i.test(text)) {
      reply = telegramProjectLookupReply(text);
    } else if (/^\/mockups(?:@\w+)?/i.test(text)) {
      reply = telegramMockupsReply();
    } else if (/^\/layout(?:@\w+)?/i.test(text)) {
      await telegramVehicleLayoutReply(chatId, text);
      return res.json({ ok: true });
    } else if (/^\/mockup(?:@\w+)?/i.test(text)) {
      const largestPhoto = photos[photos.length - 1];

      if (!largestPhoto) {
        reply = 'Please send /mockup with a vehicle photo.';
      } else {
        const description = telegramMockupDescription(text);
        const filePath = await telegramFilePath(largestPhoto.file_id);
        const saved = saveTelegramMockupRequest({
          chatId,
          messageId: message.message_id,
          senderName,
          caption: description,
          fileId: largestPhoto.file_id,
          filePath
        });
        reply = [
          `Mockup request #${saved.id} saved.`,
          `From: ${senderName}`,
          `Description: ${description}`,
          'Status: pending'
        ].join('\n');
      }
    } else {
      reply = await telegramAgentChatReply(text);
    }

    await sendTelegramMessage(chatId, reply);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Telegram webhook error:', err);
    return res.status(500).json({ ok: false });
  }
});

app.post('/api/admin/cashflow/sync', requireAdmin, async (req, res) => {
  try {
    const result = await syncMasterCashflow(db);
    setSetting('master_cashflow_last_synced_at', result.synced_at);
    setSetting('master_cashflow_last_error', '');
    logActivity(null, actor(req).userId || null, actor(req).displayName || null, 'Master cashflow synced', null, result.synced_at);
    res.json(result);
  } catch (err) {
    const message = syncErrorMessage(err);
    setSetting('master_cashflow_last_error', message);
    res.status(err.status || 502).json({ error: message });
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
  const icon = text(req.body.icon);
  const sort = int(req.body.sort_order, db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_categories').get().next);
  const result = db.prepare('INSERT INTO consultation_categories (name, icon, sort_order, active) VALUES (?, ?, ?, ?)').run(name, icon, sort, req.body.active === false ? 0 : 1);
  res.status(201).json(db.prepare('SELECT * FROM consultation_categories WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/consultation/categories/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_categories WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Category not found' });
  db.prepare('UPDATE consultation_categories SET name=?, icon=?, sort_order=?, active=? WHERE id=?')
    .run(text(req.body.name ?? current.name), text(req.body.icon ?? current.icon), int(req.body.sort_order, current.sort_order), bool(req.body.active ?? current.active) ? 1 : 0, current.id);
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

    db.prepare(`
    UPDATE quote_items
    SET customer_price=?,
        internal_cost=?,
        supplier=?,
        need_order=?,
        updated_at=CURRENT_TIMESTAMP
    WHERE consultation_item_id=? AND active=1
  `).run(
    int(next.default_customer_price),
    int(next.default_internal_cost),
    text(next.supplier),
    bool(next.need_order) ? 1 : 0,
    current.id
  );
  res.json(db.prepare('SELECT * FROM consultation_items WHERE id=?').get(current.id));
});
app.post('/api/admin/consultation/items/:id/duplicate', requireAdmin, (req, res) => {
  const source = db.prepare('SELECT * FROM consultation_items WHERE id=?').get(Number(req.params.id));
  if (!source) return res.status(404).json({ error: 'Item not found' });

  let newName = text(req.body.name) || `${source.name} Copy`;
  let suffix = 2;

  while (
    db.prepare(
      'SELECT id FROM consultation_items WHERE category_id=? AND name=?'
    ).get(source.category_id, newName)
  ) {
    newName = `${source.name} Copy ${suffix++}`;
  }
  const baseSlug = slugify(newName);
  let slug = baseSlug;
  let counter = 1;
  while (db.prepare('SELECT id FROM consultation_items WHERE slug=?').get(slug)) {
    slug = `${baseSlug}-${counter++}`;
  }

  const sort = int(
    req.body.sort_order,
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_items WHERE category_id=?').get(source.category_id).next
  );

  const tx = db.transaction(() => {
    const itemResult = db.prepare(`
      INSERT INTO consultation_items (
        category_id, slug, name, description, default_customer_price, default_internal_cost,
        supplier, need_order, sort_order, active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      source.category_id,
      slug,
      newName,
      source.description || '',
      int(source.default_customer_price),
      int(source.default_internal_cost),
      text(source.supplier),
      bool(source.need_order) ? 1 : 0,
      sort
    );

    const newItemId = itemResult.lastInsertRowid;

    const subparts = db.prepare('SELECT * FROM consultation_subparts WHERE consultation_item_id=? AND active=1 ORDER BY sort_order, id').all(source.id);
    const insertSubpart = db.prepare(`
      INSERT INTO consultation_subparts (consultation_item_id, name, cost, sort_order, active)
      VALUES (?, ?, ?, ?, ?)
    `);
    subparts.forEach(sp => {
      insertSubpart.run(newItemId, text(sp.name), int(sp.cost), int(sp.sort_order), 1);
    });

    const options = db.prepare('SELECT * FROM consultation_item_options WHERE consultation_item_id=? AND active=1 ORDER BY sort_order, id').all(source.id);
    const insertOption = db.prepare(`
      INSERT INTO consultation_item_options
        (consultation_item_id, slug, label, input_type, default_value, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChoice = db.prepare(`
      INSERT INTO consultation_item_option_choices
        (option_id, value, label, sort_order, active)
      VALUES (?, ?, ?, ?, ?)
    `);

    options.forEach(opt => {
      let optSlug = opt.slug || slugify(opt.label);
      let optCounter = 1;
      while (db.prepare('SELECT id FROM consultation_item_options WHERE consultation_item_id=? AND slug=?').get(newItemId, optSlug)) {
        optSlug = `${opt.slug || slugify(opt.label)}-${optCounter++}`;
      }

      const optResult = insertOption.run(
        newItemId,
        optSlug,
        text(opt.label),
        text(opt.input_type) || 'select',
        text(opt.default_value),
        int(opt.sort_order),
        1
      );

      const choices = db.prepare('SELECT * FROM consultation_item_option_choices WHERE option_id=? AND active=1 ORDER BY sort_order, id').all(opt.id);
      choices.forEach(choice => {
        insertChoice.run(
          optResult.lastInsertRowid,
          text(choice.value),
          text(choice.label),
          int(choice.sort_order),
          1
        );
      });
    });

    updateConsultationItemCostFromSubparts(newItemId);
    return newItemId;
  });

  const newItemId = tx();
  res.status(201).json(db.prepare('SELECT * FROM consultation_items WHERE id=?').get(newItemId));
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

app.post('/api/admin/consultation/items/:id/options', requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM consultation_items WHERE id=?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });

  const label = text(req.body.label);
  if (!label) return res.status(400).json({ error: 'label is required' });

  const baseSlug = slugify(req.body.slug || label);
  let slug = baseSlug;
  let counter = 1;

  while (db.prepare('SELECT id FROM consultation_item_options WHERE consultation_item_id=? AND slug=?').get(item.id, slug)) {
    slug = `${baseSlug}-${counter++}`;
  }

  const sort = int(
    req.body.sort_order,
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_item_options WHERE consultation_item_id=?').get(item.id).next
  );

  const inputType = ['select', 'yesno', 'number', 'text'].includes(req.body.input_type) ? req.body.input_type : 'select';

  const result = db.prepare(`
    INSERT INTO consultation_item_options
      (consultation_item_id, slug, label, input_type, default_value, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    slug,
    label,
    inputType,
    text(req.body.default_value),
    sort,
    req.body.active === false ? 0 : 1
  );

  res.status(201).json(db.prepare('SELECT * FROM consultation_item_options WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/consultation/options/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_item_options WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Option not found' });

  const next = { ...current, ...req.body };
  const inputType = ['select', 'yesno', 'number', 'text'].includes(next.input_type) ? next.input_type : current.input_type;

  db.prepare(`
    UPDATE consultation_item_options
    SET label=?, input_type=?, default_value=?, sort_order=?, active=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    text(next.label),
    inputType,
    text(next.default_value),
    int(next.sort_order, current.sort_order),
    bool(next.active) ? 1 : 0,
    current.id
  );

  res.json(db.prepare('SELECT * FROM consultation_item_options WHERE id=?').get(current.id));
});

app.delete('/api/admin/consultation/options/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_item_options WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Option not found' });

  db.prepare('UPDATE consultation_item_options SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(current.id);
  res.json({ ok: true });
});

app.post('/api/admin/consultation/options/:id/choices', requireAdmin, (req, res) => {
  const option = db.prepare('SELECT * FROM consultation_item_options WHERE id=?').get(Number(req.params.id));
  if (!option) return res.status(404).json({ error: 'Option not found' });

  const value = text(req.body.value || req.body.label);
  const label = text(req.body.label || req.body.value);
  if (!value && !label) return res.status(400).json({ error: 'value or label is required' });

  const sort = int(
    req.body.sort_order,
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM consultation_item_option_choices WHERE option_id=?').get(option.id).next
  );

  const result = db.prepare(`
    INSERT INTO consultation_item_option_choices
      (option_id, value, label, sort_order, active)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    option.id,
    value || label,
    label || value,
    sort,
    req.body.active === false ? 0 : 1
  );

  res.status(201).json(db.prepare('SELECT * FROM consultation_item_option_choices WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/admin/consultation/choices/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_item_option_choices WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Choice not found' });

  const next = { ...current, ...req.body };

  db.prepare(`
    UPDATE consultation_item_option_choices
    SET value=?, label=?, sort_order=?, active=?
    WHERE id=?
  `).run(
    text(next.value),
    text(next.label),
    int(next.sort_order, current.sort_order),
    bool(next.active) ? 1 : 0,
    current.id
  );

  res.json(db.prepare('SELECT * FROM consultation_item_option_choices WHERE id=?').get(current.id));
});

app.delete('/api/admin/consultation/choices/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM consultation_item_option_choices WHERE id=?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Choice not found' });

  db.prepare('UPDATE consultation_item_option_choices SET active=0 WHERE id=?').run(current.id);
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
app.get('/api/mcp/health', requireAgentRead, (req, res) => {
  res.json({
    ok: true,
    service: 'CRDN MCP read-only wrapper',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
});

function mcpToolResult(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}
function mcpToolDefinitions() {
  return [
    {
      name: 'get_crdn_context',
      description: 'Get CRDN read-only API context and available data categories.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'list_crdn_vehicles',
      description: 'List safe CRDN vehicle records from the Design AI vehicle database.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'list_crdn_products',
      description: 'List safe CRDN product records from the Design AI product database.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'get_crdn_product',
      description: 'Get one safe CRDN product detail by product_id, sku, or name search.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product ID, SKU, or product name search text' }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      name: 'list_crdn_mockups',
      description: 'List safe Telegram mockup request summaries.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'list_crdn_projects',
      description: 'List safe active CRDN project summaries.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'get_crdn_project',
      description: 'Get a safe CRDN project detail summary by project id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'CRDN project id' }
        },
        required: ['id'],
        additionalProperties: false
      }
    },
    {
      name: 'get_crdn_layout_render_request',
      description: 'Get a CRDN layout render request package by request id, including vehicle, layout, products, placements, rotations, and AI render brief.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'CRDN layout render request id' }
        },
        required: ['id'],
        additionalProperties: false
      }
    }
  ];
}
function handleMcpToolCall(name, args = {}) {
  if (name === 'get_crdn_context') {
    return {
      app: 'CRDN Tracking App',
      routes: AGENT_ROUTE_LIST,
      timestamp: new Date().toISOString(),
      exposed_data: 'Read-only summaries for Design AI vehicle/product records, Telegram mockup request status summaries, and minimal project planning fields.'
    };
  }
  if (name === 'list_crdn_vehicles') {
    return {
      records: db.prepare(`
        SELECT *
        FROM design_ai_vehicle_records
        ORDER BY updated_at DESC, vehicle_id COLLATE NOCASE
        LIMIT 500
      `).all().map(agentVehicleRecord)
    };
  }
  if (name === 'list_crdn_products') {
    return {
      records: db.prepare(`
        SELECT *
        FROM design_ai_product_records
        ORDER BY updated_at DESC, product_id COLLATE NOCASE
        LIMIT 500
      `).all().map(agentProductRecord)
    };
  }
  if (name === 'get_crdn_product') {
    const query = text(args.query).trim();
    if (!query) {
      const err = new Error('Product query is required.');
      err.code = -32602;
      throw err;
    }

    const like = `%${query}%`;
    const row = db.prepare(`
      SELECT *
      FROM design_ai_product_records
      WHERE product_id = ?
         OR sku = ?
         OR name = ?
         OR product_id LIKE ?
         OR sku LIKE ?
         OR name LIKE ?
      ORDER BY
        CASE
          WHEN product_id = ? THEN 0
          WHEN sku = ? THEN 1
          WHEN name = ? THEN 2
          ELSE 3
        END,
        updated_at DESC,
        product_id COLLATE NOCASE
      LIMIT 1
    `).get(query, query, query, like, like, like, query, query, query);

    if (!row) {
      const err = new Error('Product not found.');
      err.code = -32004;
      throw err;
    }

    return { product: agentProductRecord(row) };
  }
  if (name === 'list_crdn_mockups') {
    return {
      requests: db.prepare(`
        SELECT id, caption, status, assigned_designer_name,
          result_uploaded_at, result_sent_to_telegram_at, created_at, updated_at
        FROM telegram_mockup_requests
        ORDER BY created_at DESC, id DESC
        LIMIT 200
      `).all().map(row => ({
        id: row.id,
        caption: row.caption || '',
        status: row.status || 'pending',
        assigned_designer_name: row.assigned_designer_name || '',
        result_status: {
          uploaded: Boolean(row.result_uploaded_at),
          sent_to_telegram: Boolean(row.result_sent_to_telegram_at),
          uploaded_at: row.result_uploaded_at || '',
          sent_to_telegram_at: row.result_sent_to_telegram_at || ''
        },
        created_at: row.created_at || '',
        updated_at: row.updated_at || ''
      }))
    };
  }
  if (name === 'list_crdn_projects') {
    return {
      projects: db.prepare(`
        SELECT id, job_no, name, stage, designer, priority, progress,
          start_date, finish_date, updated_at
        FROM vehicles
        WHERE archived=0
        ORDER BY updated_at DESC, id DESC
        LIMIT 300
      `).all().map(agentProjectSummary)
    };
  }
  if (name === 'get_crdn_project') {
    const project = db.prepare(`
      SELECT id, job_no, name, stage, designer, priority, progress,
        start_date, finish_date, milestones_json, archived, created_at, updated_at
      FROM vehicles
      WHERE id=?
      LIMIT 1
    `).get(Number(args.id));
    const detail = agentProjectDetail(project);
    if (!detail) {
      const err = new Error('Project not found.');
      err.code = -32004;
      throw err;
    }
    return { project: detail };
  }
  if (name === 'get_crdn_layout_render_request') {
    const detail = layoutAgentRenderRequestDetail(Number(args.id));
    if (!detail) {
      const err = new Error('Layout render request not found.');
      err.code = -32004;
      throw err;
    }
    return detail;
  }
  const err = new Error(`Unknown tool: ${name}`);
  err.code = -32601;
  throw err;
}
app.get('/api/mcp', requireAgentRead, (req, res) => res.json({ ok: true, service: 'CRDN MCP read-only wrapper', transport: 'json-rpc-post', endpoint: '/api/mcp', protocolVersions: ['2024-11-05','2025-06-18'], tools: mcpToolDefinitions() }));
app.post('/api/mcp', requireAgentRead, (req, res) => {
  const rpc = req.body || {};
  const id = rpc.id ?? null;
  try {
    if (rpc.jsonrpc !== '2.0') {
      return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request.' } });
    }
    if (rpc.method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: rpc.params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'crdn-readonly-mcp',
            version: '0.1.0'
          }
        }
      });
    }
    if (rpc.method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: mcpToolDefinitions()
        }
      });
    }
    if (rpc.method === 'tools/call') {
      const params = rpc.params || {};
      const result = handleMcpToolCall(params.name, params.arguments || {});
      return res.json({
        jsonrpc: '2.0',
        id,
        result: mcpToolResult(result)
      });
    }
    return res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${rpc.method}` }
    });
  } catch (err) {
    console.error('MCP error:', err);
    return res.json({
      jsonrpc: '2.0',
      id,
      error: {
        code: err.code || -32000,
        message: err.message || 'MCP server error.'
      }
    });
  }
});

app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`CRDN tracking app listening on ${PORT}`));
