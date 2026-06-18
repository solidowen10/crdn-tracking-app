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
const { syncMasterCashflow } = require('./cashflowSync');
const {
  driveStatus,
  syncDriveFolders,
  designLibraryReadiness,
  extractDesignEntity,
  generateMoodboardConcept,
  generateDesignResponse,
  REQUIRED_MISSING_DATA
} = require('./designAiServices');

init();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || 'https://tool.creativeden.studio';
const CALLBACK_URL = process.env.LINE_CALLBACK_URL || `${BASE_URL}/auth/callback`;
const allowedLineIds = new Set((process.env.ALLOWED_LINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean));

const PART_STATUSES = ['Not Needed', 'Need to Order', 'Ordered', 'Arrived', 'Installed', 'Backordered', 'Cancelled'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

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
  return {
    total_indexed_files: total,
    folders,
    readiness: designLibraryReadiness(files, designExtractionStatusLookup()),
    last_sync_at: designSetting('last_sync_at'),
    last_sync_error: designSetting('last_sync_error'),
    drive: driveStatus()
  };
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
  'brand', 'model', 'year_range', 'unit', 'interior_length_mm', 'interior_width_mm', 'interior_height_mm',
  'rear_window_width_mm', 'rear_window_height_mm', 'rear_door_width_mm', 'rear_door_height_mm',
  'wheel_arch_width_mm', 'wheel_arch_height_mm', 'wheel_arch_position_x_mm', 'wheel_arch_position_y_mm',
  'floor_plan_notes', 'reference_files_json', 'source_drive_folder_id', 'source_summary_json', 'status'
];
const DESIGN_AI_PRODUCT_FIELDS = [
  'sku', 'name', 'category', 'unit', 'width_mm', 'depth_mm', 'height_mm', 'weight_kg',
  'mounting_type', 'compatible_vehicles_json', 'requires_drilling', 'install_minutes', 'price',
  'mounting_notes', 'installation_notes', 'reference_files_json', 'source_drive_folder_id',
  'source_summary_json', 'status'
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
  'interior_length_mm', 'interior_width_mm', 'interior_height_mm', 'rear_door_width_mm', 'rear_door_height_mm',
  'rear_window_width_mm', 'rear_window_height_mm', 'wheel_arch_width_mm', 'wheel_arch_height_mm',
  'wheel_arch_position_x_mm', 'wheel_arch_position_y_mm', 'width_mm', 'depth_mm', 'height_mm',
  'weight_kg', 'install_minutes', 'price'
]);
const DESIGN_AI_JSON_FIELDS = new Set([
  'compatible_vehicles_json', 'reference_files_json', 'source_summary_json', 'colors_json',
  'materials_json', 'reference_images_json', 'products_json', 'customer_photos_json',
  'layout_json', 'mockup_files_json'
]);
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

function designEntityFolderFiles(entityType, folderPath, entityId) {
  const folderType = designFolderType(entityType);
  const folder = text(folderPath || entityId);
  if (!folder) return [];
  return db.prepare(`
    SELECT *
    FROM design_library_files
    WHERE folder_type=?
      AND (
        path=?
        OR path LIKE ?
        OR lower(name)=lower(?)
      )
    ORDER BY is_folder DESC, path COLLATE NOCASE, modified_time DESC
  `).all(folderType, folder, `${folder}/%`, folder);
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
  return {
    ...row,
    floor_plan_notes: row.floor_plan_notes || row.notes || '',
    reference_files: parseJson(row.reference_files_json, []),
    compatible_vehicles: [],
    source_summary: parseJson(row.source_summary_json, {})
  };
}

function designProductRecordFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    compatible_vehicles: parseJson(row.compatible_vehicles_json, []),
    reference_files: parseJson(row.reference_files_json, []),
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
  if (field === 'requires_drilling') return value ? 1 : 0;
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

function upsertDesignProductRecord(productId, payload, sourceSummary, options = {}) {
  const incoming = { ...payload };
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
    const boxWidth = number(product?.width_mm, 0);
    const boxHeight = number(product?.depth_mm || product?.height_mm, 0);
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
    }, sourceSummary, { defaultStatus: 'approved', preserveExistingEmpty: true });
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
    default_deposit_to_parts_ordered_days: setting('default_deposit_to_parts_ordered_days', '0'),
    default_parts_ordered_to_arrived_days: setting('default_parts_ordered_to_arrived_days', '7'),
    default_parts_arrived_to_garage_days: setting('default_parts_arrived_to_garage_days', '0'),
    default_build_days: setting('default_build_days', '14'),
    default_qc_days: setting('default_qc_days', '2'),
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
app.get([
  '/design-ai',
  '/design-ai/settings',
  '/design-ai/library',
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

app.get('/api/dashboard', requireAuth, (req, res) => {
  const rows = dashboardRows(text(req.query.filter) || 'All');
  const allRows = dashboardRows('All');
  res.json({ summary: dashboardSummary(allRows), projects: rows });
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
    const result = await syncDriveFolders(designAiSettings());
    const upsert = db.prepare(`
      INSERT INTO design_library_files (
        drive_file_id, folder_type, name, path, parent_drive_file_id, mime_type,
        web_view_link, modified_time, size, is_folder, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
        updated_at=CURRENT_TIMESTAMP
    `);
    const tx = db.transaction(files => {
      files.forEach(file => upsert.run(
        text(file.drive_file_id),
        text(file.folder_type),
        text(file.name),
        text(file.path),
        text(file.parent_drive_file_id),
        text(file.mime_type),
        text(file.web_view_link),
        text(file.modified_time),
        text(file.size),
        Number(file.is_folder) ? 1 : 0
      ));
    });
    tx(result.files);
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
  res.json({
    files,
    status: designLibraryStatus(),
    readiness: designLibraryReadiness(files, designExtractionStatusLookup()),
    required_checklist: {
      vehicle_required: ['vehicle.json', 'dimensions.csv', 'floorplan.svg'],
      vehicle_optional: ['mounting_points.csv', 'restricted_zones.csv', 'scan.glb', 'photos/'],
      product_required: ['product.json', 'dimensions.csv', 'footprint.svg', 'installation_rules.json']
    }
  });
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
  const rows = db.prepare(`
    SELECT *
    FROM design_ai_product_records
    ORDER BY updated_at DESC, product_id COLLATE NOCASE
  `).all().map(designProductRecordFromRow);
  res.json({ records: rows });
});

app.get('/api/design-ai/products/:productId', requireAuth, (req, res) => {
  const record = designProductRecordFromRow(db.prepare('SELECT * FROM design_ai_product_records WHERE lower(product_id)=lower(?)').get(text(req.params.productId)));
  if (!record) return res.status(404).json({ error: 'Product record not found.' });
  res.json({ record });
});

app.post('/api/design-ai/products', requireAuth, (req, res) => {
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

app.patch('/api/design-ai/products/:productId', requireAuth, (req, res) => {
  const productId = text(req.params.productId);
  if (!productId) return res.status(400).json({ error: 'product id is required.' });
  const nextId = text(req.body.product_id || productId);
  if (nextId !== productId && db.prepare('SELECT 1 FROM design_ai_product_records WHERE product_id=?').get(productId)) {
    db.prepare('UPDATE design_ai_product_records SET product_id=?, updated_at=CURRENT_TIMESTAMP WHERE product_id=?').run(nextId, productId);
  }
  const record = upsertDesignProductRecord(nextId, {
    ...req.body,
    status: text(req.body.status || undefined)
  }, {
    manual_edit: true,
    edited_by_line_user_id: actor(req).userId || '',
    edited_at: new Date().toISOString()
  });
  res.json({ record });
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
	  ['quote_categories', 'parts_categories', 'quote_terms', 'contract_terms', 'packages', 'google_sheets_sync', 'master_cashflow_entries', 'garage_capacity', 'default_deposit_to_parts_ordered_days', 'default_parts_ordered_to_arrived_days', 'default_parts_arrived_to_garage_days', 'default_build_days', 'default_qc_days', 'default_delivery_buffer_days'].forEach(key => {
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

app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`CRDN tracking app listening on ${PORT}`));
