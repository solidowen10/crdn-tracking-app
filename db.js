const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/crdn.db';
const absoluteDbPath = path.resolve(dbPath);
fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });

const db = new Database(absoluteDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const PIPELINE_STAGES = [
  { label: '01 Intake', progress: 5 },
  { label: '02 Consultation', progress: 10 },
  { label: '03 Quoting', progress: 20 },
  { label: '04 Waiting Approval', progress: 25 },
  { label: '05 Deposit Paid', progress: 35 },
  { label: '06 Design / Planning', progress: 45 },
  { label: '07 Parts Ordering', progress: 55 },
  { label: '08 Parts Arrived', progress: 65 },
  { label: '09 Building', progress: 75 },
  { label: '10 Installation', progress: 85 },
  { label: '11 QC', progress: 95 },
  { label: '12 Ready for Delivery', progress: 98 },
  { label: '13 Delivered', progress: 100 },
  { label: '14 Archived', progress: 100 }
];

const DEFAULT_CATEGORIES = [
  'Bed System',
  'Cabinet',
  'Battery Holder',
  'Electrical',
  'Water System',
  'Ceiling / Wall Panels',
  'Storage',
  'Custom Fabrication',
  'Installation Labor',
  'Design / Planning',
  'Other'
];

const DEFAULT_TERMS = '付款條件：確認訂單需支付 50% 訂金，完工交車前付清尾款。價格以新台幣計算，實際工期可能依零件到貨狀況調整。\n\nPayment terms: 50% deposit is required to confirm the order. Remaining balance is due before delivery. Prices are in NTD. Timeline may change depending on parts availability.';

const DEFAULT_CHECKLIST_ITEMS = [
  ['Bed System', "Rock N' Roll bed system", 'Foldable bed platform with seat conversion.', 65000, 38000, 'EU Import', 1],
  ['Bed System', 'Fixed rear bed platform', 'Custom fixed bed base with storage access.', 52000, 30000, 'Local Fabrication', 1],
  ['Cabinet', 'Kitchen cabinet unit', 'Birch plywood cabinet with soft-close hardware.', 52000, 28000, 'Formosa', 1],
  ['Cabinet', 'Overhead storage cabinets', 'Upper storage modules with custom finish.', 36000, 18000, 'Formosa', 1],
  ['Battery Holder', 'Battery mounting tray', 'Secure battery holder and tie-down system.', 12000, 5500, 'Local Fabrication', 1],
  ['Electrical', '12V power system', 'Main 12V power layout and wiring.', 28000, 16000, 'Victron TW', 1],
  ['Electrical', 'LED strip lighting', 'Warm white LED strip lighting package.', 12000, 4500, 'RS Taiwan', 1],
  ['Water System', 'Fresh water pump kit', 'Compact water pump, fittings, and routing.', 22000, 12000, 'Local Supplier', 1],
  ['Ceiling / Wall Panels', 'Ceiling panel and insulation', 'Panel trim, insulation, and finish installation.', 18000, 9000, 'Local Supplier', 1],
  ['Storage', 'Rear storage drawer', 'Heavy-duty storage drawer with rails.', 26000, 14000, 'Local Fabrication', 1],
  ['Custom Fabrication', 'Custom bracket or mount', 'Custom fabricated bracket, mount, or adapter.', 15000, 7000, 'Local Fabrication', 1],
  ['Installation Labor', 'Installation labor', 'Workshop installation and fitment labor.', 22000, 0, '', 0],
  ['Design / Planning', 'Design and consultation fee', 'Layout planning, drawing, and customer consultation.', 15000, 0, '', 0],
  ['Other', 'Other custom item', 'Custom item to be defined during consultation.', 0, 0, '', 0]
];

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function addColumn(table, column, definition) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function stageProgress(stage) {
  return (PIPELINE_STAGES.find(s => s.label === stage) || PIPELINE_STAGES[0]).progress;
}

function normalizeStage(stage) {
  const map = {
    New: '01 Intake',
    Consultation: '02 Consultation',
    Design: '06 Design / Planning',
    Approved: '05 Deposit Paid',
    Production: '07 Parts Ordering',
    Installation: '10 Installation',
    QC: '11 QC',
    Delivered: '13 Delivered',
    '03 Parts': '07 Parts Ordering',
    '04 Build': '09 Building',
    '05 QC': '11 QC',
    '06 Handover': '13 Delivered'
  };
  if (PIPELINE_STAGES.some(s => s.label === stage)) return stage;
  return map[stage] || '01 Intake';
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_no TEXT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      plate TEXT,
      pkg TEXT,
      stage TEXT NOT NULL DEFAULT '01 Intake',
      designer TEXT,
      priority TEXT NOT NULL DEFAULT 'Normal',
      progress INTEGER NOT NULL DEFAULT 5,
      start_date TEXT,
      finish_date TEXT,
      customer_update TEXT,
      customer_action TEXT,
      next_action TEXT,
      notes TEXT,
      timeline_json TEXT DEFAULT '{}',
      archived INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      user_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS catalog_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS catalog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES catalog_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      default_price INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(category_id, name)
    );

    CREATE TABLE IF NOT EXISTS vehicle_checklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      checked INTEGER NOT NULL DEFAULT 0,
      custom_price INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(vehicle_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_quote_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicle_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      part_name TEXT NOT NULL,
      category TEXT,
      qty REAL,
      unit TEXT,
      spec_note TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      supplier TEXT,
      eta TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vehicle_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      task TEXT NOT NULL,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'Not Started',
      due_date TEXT,
      completed_at TEXT,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS consultation_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS consultation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES consultation_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      default_customer_price INTEGER NOT NULL DEFAULT 0,
      default_internal_cost INTEGER NOT NULL DEFAULT 0,
      supplier TEXT,
      need_order INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(category_id, name)
    );

    CREATE TABLE IF NOT EXISTS consultation_subparts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_item_id INTEGER NOT NULL REFERENCES consultation_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cost INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quote_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      consultation_item_id INTEGER REFERENCES consultation_items(id) ON DELETE SET NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      customer_price INTEGER NOT NULL DEFAULT 0,
      internal_cost INTEGER NOT NULL DEFAULT 0,
      supplier TEXT,
      need_order INTEGER NOT NULL DEFAULT 0,
      parts_status TEXT NOT NULL DEFAULT 'Not Needed',
      internal_notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      quote_item_id INTEGER REFERENCES quote_items(id) ON DELETE SET NULL,
      part_name TEXT NOT NULL,
      supplier TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      cost INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Need to Order',
      eta TEXT,
      arrived_date TEXT,
      installed_date TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS services_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS project_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      service_master_id INTEGER REFERENCES services_master(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(vehicle_id, service_master_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
      user_id TEXT,
      display_name TEXT,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumn('vehicles', 'job_no', 'TEXT');
  addColumn('quote_items', 'option_values_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('vehicles', 'priority', "TEXT NOT NULL DEFAULT 'Normal'");
  addColumn('vehicles', 'progress', 'INTEGER NOT NULL DEFAULT 5');
  addColumn('vehicles', 'start_date', 'TEXT');
  addColumn('vehicles', 'customer_update', 'TEXT');
  addColumn('vehicles', 'customer_action', 'TEXT');
  addColumn('vehicles', 'next_action', 'TEXT');
  addColumn('vehicles', 'customer_email', "TEXT NOT NULL DEFAULT ''");
  addColumn('vehicles', 'customer_phone', "TEXT NOT NULL DEFAULT ''");
  addColumn('vehicles', 'timeline_json', "TEXT DEFAULT '{}'");
  addColumn('catalog_items', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn('catalog_items', 'active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('consultation_categories', 'icon', "TEXT NOT NULL DEFAULT ''");
  addColumn('consultation_items', 'slug', 'TEXT');

  const setIcon = db.prepare("UPDATE consultation_categories SET icon=? WHERE name=? AND (icon IS NULL OR icon='')");
  DEFAULT_CATEGORIES.forEach(name => setIcon.run(categoryIcon(name), name));

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_consultation_items_active_name
    ON consultation_items(category_id, active, name);

    CREATE INDEX IF NOT EXISTS idx_consultation_items_slug_lookup
    ON consultation_items(slug);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vehicles_job_no ON vehicles(job_no);
    CREATE INDEX IF NOT EXISTS idx_quote_items_vehicle ON quote_items(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_parts_vehicle ON parts(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consultation_subparts_item ON consultation_subparts(consultation_item_id);
  `);
}

const defaultCatalog = [
  { name: 'Exterior Wrap', items: [['Full body wrap', 88000], ['Partial wrap', 42000], ['Roof wrap', 12000], ['Mirror wrap', 6000]] },
  { name: 'Paint Protection Film', items: [['Front bumper PPF', 28000], ['Full front PPF', 68000], ['Door cup PPF', 3500], ['Headlight PPF', 7000]] },
  { name: 'Window Film', items: [['Front windshield film', 18000], ['Side windows film', 16000], ['Rear windshield film', 12000]] },
  { name: 'Detailing', items: [['Exterior detail', 12000], ['Interior detail', 10000], ['Engine bay detail', 6000], ['Ceramic coating', 32000]] },
  { name: 'Design & Production', items: [['Design fee', 8000], ['Print production', 18000], ['Color proof', 2500], ['Logo redraw', 3500]] },
  { name: 'Installation', items: [['Standard install', 26000], ['Complex install surcharge', 12000], ['Removal old wrap', 18000]] },
  { name: 'Aftercare', items: [['First inspection', 0], ['Repair patch', 4500], ['Maintenance wash', 2500]] }
];

function seedCatalog() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM catalog_categories').get().count;
  if (existing > 0) return;
  const insertCat = db.prepare('INSERT INTO catalog_categories (name, sort_order) VALUES (?, ?)');
  const insertItem = db.prepare('INSERT INTO catalog_items (category_id, name, default_price, sort_order) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    defaultCatalog.forEach((cat, catIndex) => {
      const result = insertCat.run(cat.name, catIndex + 1);
      cat.items.forEach(([itemName, price], itemIndex) => {
        insertItem.run(result.lastInsertRowid, itemName, price, itemIndex + 1);
      });
    });
  });
  tx();
}

function categoryIcon(name) {
  const key = String(name || '').toLowerCase();
  if (key.includes('bed')) return '🛏';
  if (key.includes('cabinet') || key.includes('storage')) return '🗄';
  if (key.includes('battery')) return '🔋';
  if (key.includes('electrical')) return '⚡';
  if (key.includes('water')) return '💧';
  if (key.includes('ceiling') || key.includes('wall') || key.includes('panel')) return '🪵';
  if (key.includes('fabrication') || key.includes('installation') || key.includes('labor') || key.includes('labour')) return '🔧';
  if (key.includes('design')) return '✏️';
  return '📦';
}

function seedConsultationChecklist() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM consultation_categories').get().count;
  if (existing > 0) return;
  const insertCat = db.prepare('INSERT INTO consultation_categories (name, icon, sort_order) VALUES (?, ?, ?)');
  const insertItem = db.prepare(`
    INSERT INTO consultation_items (
      category_id, name, description, default_customer_price, default_internal_cost,
      supplier, need_order, sort_order
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    const categoryIds = new Map();
    DEFAULT_CATEGORIES.forEach((name, index) => {
      categoryIds.set(name, insertCat.run(name, categoryIcon(name), index + 1).lastInsertRowid);
    });
    const counters = new Map();
    DEFAULT_CHECKLIST_ITEMS.forEach(([cat, name, description, price, cost, supplier, needOrder]) => {
      const sort = (counters.get(cat) || 0) + 1;
      counters.set(cat, sort);
      insertItem.run(categoryIds.get(cat), name, description, price, cost, supplier, needOrder, sort);
    });
  });
  tx();
}

function seedServices() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM services_master').get().count;
  if (existing > 0) return;
  const insert = db.prepare('INSERT INTO services_master (name, description, sort_order) VALUES (?, ?, ?)');
  DEFAULT_CATEGORIES.forEach((name, index) => insert.run(name, `${name} scope for camper van projects.`, index + 1));
}

function seedSettings() {
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO NOTHING
  `);
  upsert.run('quote_terms', DEFAULT_TERMS);
  upsert.run('quote_categories', DEFAULT_CATEGORIES.join('\n'));
  upsert.run('parts_categories', DEFAULT_CATEGORIES.join('\n'));
  upsert.run('google_sheets_sync', 'Not connected');
  upsert.run('google_sheets_last_synced_at', '');
  upsert.run('google_sheets_last_error', '');
  upsert.run('garage_capacity', '2');
  upsert.run('default_build_days', '14');
  upsert.run('default_qc_days', '2');
  upsert.run('default_delivery_buffer_days', '1');
}

function ensureBilingualTerms() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='quote_terms'").get();
  const current = row?.value || '';
  const oldDefault = '50% deposit required to confirm booking. Balance due upon completion. Prices in NTD. Estimated completion is subject to parts availability.';
  if (!current || current === oldDefault || !current.includes('付款條件')) {
    db.prepare("UPDATE app_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='quote_terms'").run(DEFAULT_TERMS);
  }
}

function syncAllowedAdmins() {
  const ids = (process.env.ALLOWED_LINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const upsert = db.prepare(`
    INSERT INTO users (line_user_id, role, created_at) VALUES (?, 'admin', CURRENT_TIMESTAMP)
    ON CONFLICT(line_user_id) DO UPDATE SET role = 'admin'
  `);
  ids.forEach(id => upsert.run(id));
}

function nextJobNo() {
  const current = db.prepare(
    "SELECT value FROM app_settings WHERE key='next_job_no'"
  ).get();

  let next = Number(current?.value || 0);

  if (!next) {
    const rows = db.prepare(
      "SELECT job_no FROM vehicles WHERE job_no LIKE 'CRDN-%'"
    ).all();

    next = rows.reduce((highest, row) => {
      const match = String(row.job_no || '').match(/^CRDN-(\d+)$/);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
  }

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('next_job_no', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key)
    DO UPDATE SET
      value=excluded.value,
      updated_at=CURRENT_TIMESTAMP
  `).run(String(next + 1));

  return `CRDN-${String(next).padStart(3, '0')}`;
}

function normalizeVehicles() {
  const rows = db.prepare('SELECT id, job_no, stage, progress, archived FROM vehicles ORDER BY id').all();
  const update = db.prepare('UPDATE vehicles SET job_no=?, stage=?, progress=?, archived=? WHERE id=?');
  const tx = db.transaction(() => {
    rows.forEach(row => {
      const stage = normalizeStage(row.stage);
      update.run(row.job_no || nextJobNo(), stage, stageProgress(stage), stage === '14 Archived' ? 1 : row.archived, row.id);
    });
  });
  tx();
}

function migrateLegacyQuoteData() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM quote_items').get().count;
  if (existing > 0) return;

  const insertQuote = db.prepare(`
    INSERT INTO quote_items (
      vehicle_id, consultation_item_id, category, description, quantity, customer_price,
      internal_cost, supplier, need_order, parts_status, internal_notes, active, sort_order
    )
    VALUES (?, NULL, ?, ?, 1, ?, 0, '', 0, 'Not Needed', '', 1, ?)
  `);

  const checked = db.prepare(`
    SELECT vc.vehicle_id, cc.name AS category, ci.name, COALESCE(vc.custom_price, ci.default_price) AS price
    FROM vehicle_checklist vc
    JOIN catalog_items ci ON ci.id=vc.item_id
    JOIN catalog_categories cc ON cc.id=ci.category_id
    WHERE vc.checked=1
    ORDER BY vc.vehicle_id, ci.sort_order, ci.id
  `).all();

  const custom = db.prepare(`
    SELECT vehicle_id, description, price, sort_order
    FROM vehicle_quote_items
    ORDER BY vehicle_id, sort_order, id
  `).all();

  const sortByVehicle = new Map();
  const nextSort = vehicleId => {
    const next = (sortByVehicle.get(vehicleId) || 0) + 1;
    sortByVehicle.set(vehicleId, next);
    return next;
  };

  const tx = db.transaction(() => {
    checked.forEach(row => insertQuote.run(row.vehicle_id, row.category || 'Other', row.name, row.price || 0, nextSort(row.vehicle_id)));
    custom.forEach(row => insertQuote.run(row.vehicle_id, 'Other', row.description, row.price || 0, row.sort_order || nextSort(row.vehicle_id)));
  });
  tx();
}

function logActivity(projectId, userId, displayName, action, oldValue = null, newValue = null) {
  db.prepare(`
    INSERT INTO activity_log (project_id, user_id, display_name, action, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId || null, userId || null, displayName || null, action, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue));
}

function logVehicleHistory(vehicleId, userId, action, details = null) {
  db.prepare('INSERT INTO vehicle_history (vehicle_id, user_id, action, details) VALUES (?, ?, ?, ?)')
    .run(vehicleId, userId || null, action, details ? JSON.stringify(details) : null);
}

function init() {
  migrate();
  seedCatalog();
  seedConsultationChecklist();
  seedServices();
  seedSettings();
  ensureBilingualTerms();
  syncAllowedAdmins();
  normalizeVehicles();
  migrateLegacyQuoteData();
}

module.exports = {
  db,
  init,
  logVehicleHistory,
  logActivity,
  nextJobNo,
  normalizeStage,
  stageProgress,
  PIPELINE_STAGES,
  DEFAULT_CATEGORIES
};
