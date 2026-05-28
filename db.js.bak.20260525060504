const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/crdn.db';
const absoluteDbPath = path.resolve(dbPath);
fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });

const db = new Database(absoluteDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      plate TEXT,
      pkg TEXT,
      stage TEXT NOT NULL DEFAULT 'New',
      designer TEXT,
      finish_date TEXT,
      notes TEXT,
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
      default_price INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
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

function syncAllowedAdmins() {
  const ids = (process.env.ALLOWED_LINE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const upsert = db.prepare(`
    INSERT INTO users (line_user_id, role, created_at) VALUES (?, 'admin', CURRENT_TIMESTAMP)
    ON CONFLICT(line_user_id) DO UPDATE SET role = 'admin'
  `);
  ids.forEach(id => upsert.run(id));
}

function init() {
  migrate();
  seedCatalog();
  syncAllowedAdmins();
}

function logVehicleHistory(vehicleId, userId, action, details = null) {
  db.prepare('INSERT INTO vehicle_history (vehicle_id, user_id, action, details) VALUES (?, ?, ?, ?)')
    .run(vehicleId, userId || null, action, details ? JSON.stringify(details) : null);
}

module.exports = { db, init, logVehicleHistory };
