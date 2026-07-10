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
  { label: '06 Design / Consulting', progress: 45 },
  { label: '07 Design / 3D CAD', progress: 55 },
  { label: '08 Parts Ordering', progress: 65 },
  { label: '09 Parts Arrived', progress: 75 },
  { label: '10 Building', progress: 82 },
  { label: '11 Installation', progress: 88 },
  { label: '12 QC', progress: 93 },
  { label: '13 Photoshoot', progress: 96 },
  { label: '14 Ready for Delivery', progress: 98 },
  { label: '15 Delivered', progress: 100 },
  { label: '16 Archived', progress: 100 }
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
  'Design / Consulting',
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
  ['Design / Consulting', 'Design and consultation fee', 'Layout planning, drawing, and customer consultation.', 15000, 0, '', 0],
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
    Design: '06 Design / Consulting',
    Approved: '05 Deposit Paid',
    Production: '08 Parts Ordering',
    Installation: '10 Installation',
    QC: '11 QC',
    Delivered: '13 Delivered',
    '03 Parts': '08 Parts Ordering',
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
      milestones_json TEXT DEFAULT '[]',
      cashflow_json TEXT DEFAULT '',
      stock_status_json TEXT DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS consultation_item_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_item_id INTEGER NOT NULL REFERENCES consultation_items(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      input_type TEXT NOT NULL DEFAULT 'select',
      default_value TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(consultation_item_id, slug)
    );

    CREATE TABLE IF NOT EXISTS consultation_item_option_choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_id INTEGER NOT NULL REFERENCES consultation_item_options(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS design_ai_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_library_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drive_file_id TEXT UNIQUE,
      folder_type TEXT,
      name TEXT,
      path TEXT DEFAULT '',
      parent_drive_file_id TEXT DEFAULT '',
      mime_type TEXT,
      web_view_link TEXT,
      modified_time TEXT,
      size TEXT,
      is_folder INTEGER NOT NULL DEFAULT 0,
      file_status TEXT NOT NULL DEFAULT 'active',
      extraction_role TEXT NOT NULL DEFAULT '',
      ignored_at TEXT,
      archived_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_design_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_by_line_user_id TEXT,
      vehicle_id TEXT,
      customer_lifestyle TEXT,
      people_count INTEGER,
      budget REAL,
      must_include_json TEXT,
      style_id TEXT,
      notes TEXT,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_design_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER REFERENCES ai_design_requests(id) ON DELETE CASCADE,
      ai_summary TEXT,
      layout_json TEXT,
      customer_proposal TEXT,
      lifestyle_prompt TEXT,
      raw_response_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_extraction_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      folder_path TEXT,
      source_drive_folder_id TEXT,
      extracted_json TEXT,
      confidence_json TEXT,
      source_files_json TEXT,
      status TEXT DEFAULT 'draft',
      created_by_line_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_vehicle_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id TEXT UNIQUE NOT NULL,
      brand TEXT,
      make TEXT,
      model TEXT,
      generation TEXT,
      market TEXT,
      body_type TEXT,
      year_range TEXT,
      unit TEXT DEFAULT 'mm',
      overall_length_mm REAL,
      overall_width_mm REAL,
      overall_height_mm REAL,
      wheelbase_mm REAL,
      interior_length_mm REAL,
      interior_width_mm REAL,
      interior_height_mm REAL,
      side_door_width_mm REAL,
      side_door_height_mm REAL,
      rear_window_width_mm REAL,
      rear_window_height_mm REAL,
      rear_door_width_mm REAL,
      rear_door_height_mm REAL,
      wheel_arch_width_mm REAL,
      wheel_arch_height_mm REAL,
      wheel_arch_position_x_mm REAL,
      wheel_arch_position_y_mm REAL,
      payload_kg REAL,
      floor_plan_notes TEXT,
      reference_files_json TEXT,
      source_drive_folder_id TEXT,
      source_summary_json TEXT,
      version INTEGER DEFAULT 1,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_product_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT UNIQUE NOT NULL,
      sku TEXT,
      name TEXT,
      category TEXT,
      description TEXT,
      unit TEXT DEFAULT 'mm',
      width_mm REAL,
      depth_mm REAL,
      height_mm REAL,
      weight_kg REAL,
      mounting_type TEXT,
      compatible_vehicles_json TEXT,
      requires_drilling INTEGER DEFAULT 0,
      install_minutes INTEGER,
      price REAL,
      mounting_notes TEXT,
      installation_notes TEXT,
      dimension_confidence TEXT,
      material TEXT,
      color TEXT,
      layout_component_type TEXT,
      layout_width_mm REAL,
      layout_depth_mm REAL,
      layout_height_mm REAL,
      layout_modes_json TEXT,
      shape_rule TEXT,
      orientation_options_json TEXT,
      allowed_zones_json TEXT,
      clearance_notes TEXT,
      is_configurable INTEGER DEFAULT 0,
      configurable_dimensions_json TEXT,
      default_variant_json TEXT,
      variants_json TEXT,
      fitment_confidence TEXT,
      fitment_reason TEXT,
      confirmed_data_json TEXT,
      estimated_data_json TEXT,
      production_warning TEXT,
      production_ready INTEGER DEFAULT 0,
      source_notes TEXT,
      seat_mode_width_mm REAL,
      seat_mode_depth_mm REAL,
      bed_mode_width_mm REAL,
      bed_mode_depth_mm REAL,
      extended_bed_mode_width_mm REAL,
      extended_bed_mode_depth_mm REAL,
      seat_panel_depth_mm REAL,
      back_panel_depth_mm REAL,
      optional_extension_depth_mm REAL,
      reference_files_json TEXT,
      source_drive_folder_id TEXT,
      source_summary_json TEXT,
      version INTEGER DEFAULT 1,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_style_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      style_id TEXT UNIQUE NOT NULL,
      name TEXT,
      description TEXT,
      colors_json TEXT,
      materials_json TEXT,
      reference_images_json TEXT,
      moodboard_notes TEXT,
      status TEXT DEFAULT 'draft',
      version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      customer_name TEXT,
      vehicle_id TEXT,
      products_json TEXT,
      style_id TEXT,
      customer_notes TEXT,
      customer_photos_json TEXT,
      layout_json TEXT,
      layout_notes TEXT,
      moodboard_text TEXT,
      brochure_copy TEXT,
      mockup_files_json TEXT,
      status TEXT DEFAULT 'draft',
      created_by_line_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_workspace_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_by_line_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_ai_moodboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      vehicle_id TEXT,
      title TEXT,
      concept_text TEXT,
      key_features_json TEXT,
      layout_modes_json TEXT,
      material_palette_json TEXT,
      image_prompts_json TEXT,
      brochure_copy TEXT,
      customer_vehicle_image_drive_id TEXT,
      raw_response_json TEXT,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS design_layout_concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      vehicle_key TEXT NOT NULL,
      vehicle_name TEXT,
      layout_json TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_by_line_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS layout_agent_render_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layout_concept_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_by_line_user_id TEXT,
      requested_by_name TEXT,
      telegram_chat_id TEXT,
      telegram_message_id TEXT,
      result_image_path TEXT,
      result_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telegram_mockup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      message_id TEXT,
      sender_name TEXT,
      caption TEXT,
      file_id TEXT,
      file_path TEXT,
      assigned_designer_user_id INTEGER,
      assigned_designer_name TEXT,
      result_image_path TEXT,
      result_uploaded_at DATETIME,
      result_sent_to_telegram_at DATETIME,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  addColumn('vehicles', 'milestones_json', "TEXT DEFAULT '[]'");
  addColumn('vehicles', 'cashflow_json', "TEXT DEFAULT ''");
  addColumn('vehicles', 'stock_status_json', "TEXT DEFAULT '{}'");
  addColumn('design_library_files', 'path', "TEXT DEFAULT ''");
  addColumn('design_library_files', 'parent_drive_file_id', "TEXT DEFAULT ''");
  addColumn('design_library_files', 'is_folder', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('design_library_files', 'file_status', "TEXT NOT NULL DEFAULT 'active'");
  addColumn('design_library_files', 'extraction_role', "TEXT NOT NULL DEFAULT ''");
  addColumn('design_library_files', 'ignored_at', 'TEXT');
  addColumn('design_library_files', 'archived_at', 'TEXT');
  addColumn('design_ai_vehicle_records', 'make', 'TEXT');
  addColumn('design_ai_vehicle_records', 'generation', 'TEXT');
  addColumn('design_ai_vehicle_records', 'market', 'TEXT');
  addColumn('design_ai_vehicle_records', 'body_type', 'TEXT');
  addColumn('design_ai_vehicle_records', 'overall_length_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'overall_width_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'overall_height_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'wheelbase_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'side_door_width_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'side_door_height_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'payload_kg', 'REAL');
  addColumn('design_ai_vehicle_records', 'rear_window_width_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'rear_window_height_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'wheel_arch_position_x_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'wheel_arch_position_y_mm', 'REAL');
  addColumn('design_ai_vehicle_records', 'floor_plan_notes', 'TEXT');
  addColumn('design_ai_vehicle_records', 'layout_constraints_json', "TEXT DEFAULT '{}'");
  addColumn('design_ai_vehicle_records', 'reference_files_json', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_ai_product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  addColumn('design_ai_product_records', 'product_sort_order', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('design_ai_product_records', 'mounting_notes', 'TEXT');
  addColumn('design_ai_product_records', 'installation_notes', 'TEXT');
  addColumn('design_ai_product_records', 'reference_files_json', 'TEXT');
  addColumn('design_ai_product_records', 'description', 'TEXT');
  addColumn('design_ai_product_records', 'dimension_confidence', 'TEXT');
  addColumn('design_ai_product_records', 'material', 'TEXT');
  addColumn('design_ai_product_records', 'color', 'TEXT');
  addColumn('design_ai_product_records', 'layout_component_type', 'TEXT');
  addColumn('design_ai_product_records', 'layout_width_mm', 'REAL');
  addColumn('design_ai_product_records', 'layout_depth_mm', 'REAL');
  addColumn('design_ai_product_records', 'layout_height_mm', 'REAL');
  addColumn('design_ai_product_records', 'layout_modes_json', 'TEXT');
  addColumn('design_ai_product_records', 'shape_rule', 'TEXT');
  addColumn('design_ai_product_records', 'orientation_options_json', 'TEXT');
  addColumn('design_ai_product_records', 'allowed_zones_json', 'TEXT');
  addColumn('design_ai_product_records', 'clearance_notes', 'TEXT');
  addColumn('design_ai_product_records', 'is_configurable', 'INTEGER DEFAULT 0');
  addColumn('design_ai_product_records', 'configurable_dimensions_json', 'TEXT');
  addColumn('design_ai_product_records', 'default_variant_json', 'TEXT');
  addColumn('design_ai_product_records', 'variants_json', 'TEXT');
  addColumn('design_ai_product_records', 'fitment_confidence', 'TEXT');
  addColumn('design_ai_product_records', 'fitment_reason', 'TEXT');
  addColumn('design_ai_product_records', 'confirmed_data_json', 'TEXT');
  addColumn('design_ai_product_records', 'estimated_data_json', 'TEXT');
  addColumn('design_ai_product_records', 'production_warning', 'TEXT');
  addColumn('design_ai_product_records', 'production_ready', 'INTEGER DEFAULT 0');
  addColumn('design_ai_product_records', 'source_notes', 'TEXT');
  addColumn('design_ai_product_records', 'seat_mode_width_mm', 'REAL');
  addColumn('design_ai_product_records', 'seat_mode_depth_mm', 'REAL');
  addColumn('design_ai_product_records', 'bed_mode_width_mm', 'REAL');
  addColumn('design_ai_product_records', 'bed_mode_depth_mm', 'REAL');
  addColumn('design_ai_product_records', 'extended_bed_mode_width_mm', 'REAL');
  addColumn('design_ai_product_records', 'extended_bed_mode_depth_mm', 'REAL');
  addColumn('design_ai_product_records', 'seat_panel_depth_mm', 'REAL');
  addColumn('design_ai_product_records', 'back_panel_depth_mm', 'REAL');
  addColumn('design_ai_product_records', 'optional_extension_depth_mm', 'REAL');
  addColumn('catalog_items', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn('catalog_items', 'active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('consultation_categories', 'icon', "TEXT NOT NULL DEFAULT ''");
  addColumn('consultation_items', 'slug', 'TEXT');
  addColumn('telegram_mockup_requests', 'assigned_designer_user_id', 'INTEGER');
  addColumn('telegram_mockup_requests', 'assigned_designer_name', 'TEXT');
  addColumn('telegram_mockup_requests', 'result_image_path', 'TEXT');
  addColumn('telegram_mockup_requests', 'result_uploaded_at', 'DATETIME');
  addColumn('telegram_mockup_requests', 'result_sent_to_telegram_at', 'DATETIME');

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
    CREATE INDEX IF NOT EXISTS idx_design_library_files_folder ON design_library_files(folder_type, modified_time);
    CREATE INDEX IF NOT EXISTS idx_ai_design_requests_created ON ai_design_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_design_responses_request ON ai_design_responses(request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_extraction_entity ON design_ai_extraction_drafts(entity_type, entity_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_vehicle_records_status ON design_ai_vehicle_records(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_product_records_status ON design_ai_product_records(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_product_records_category_order
    ON design_ai_product_records(category, product_sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_design_ai_product_categories_order
    ON design_ai_product_categories(active, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_design_ai_style_records_status ON design_ai_style_records(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_workspaces_status ON design_ai_workspaces(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_workspace_versions_workspace ON design_ai_workspace_versions(workspace_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_design_ai_moodboards_status ON design_ai_moodboards(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_layout_concepts_updated ON design_layout_concepts(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_layout_agent_render_requests_layout ON layout_agent_render_requests(layout_concept_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_layout_agent_render_requests_status ON layout_agent_render_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_telegram_mockup_requests_status ON telegram_mockup_requests(status, created_at DESC);
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

const LAYOUT_READY_PRODUCTS = [
  {
    product_id: 'neu-rock-roll-bed-universal',
    sku: '',
    name: "Neu_Rock N' Roll Bed",
    category: 'camper seating / convertible bed',
    status: 'approved',
    unit: 'mm',
    width_mm: 1300,
    depth_mm: 900,
    layout_component_type: 'convertible_seat_bed',
    shape_rule: 'convertible_mode_footprint',
    layout_width_mm: 1300,
    layout_depth_mm: 900,
    dimension_confidence: 'MEDIUM',
    seat_panel_depth_mm: 450,
    back_panel_depth_mm: 450,
    optional_extension_depth_mm: 210,
    seat_mode_width_mm: 1300,
    seat_mode_depth_mm: 450,
    bed_mode_width_mm: 1300,
    bed_mode_depth_mm: 900,
    extended_bed_mode_width_mm: 1300,
    extended_bed_mode_depth_mm: 1110,
    layout_modes_json: JSON.stringify([
      { mode: 'seat_mode', width_mm: 1300, depth_mm: 450 },
      { mode: 'bed_mode', width_mm: 1300, depth_mm: 900 },
      { mode: 'extended_bed_mode', width_mm: 1300, depth_mm: 1110 }
    ]),
    default_variant_json: JSON.stringify({ mode: 'bed_mode', width_mm: 1300, depth_mm: 900 }),
    compatible_vehicles_json: JSON.stringify(['universal', 'TownAce concept reference']),
    orientation_options_json: JSON.stringify(['longitudinal', 'rear_crosswise']),
    allowed_zones_json: JSON.stringify(['floor']),
    is_configurable: 0,
    fitment_confidence: 'MEDIUM',
    production_ready: 0,
    production_warning: 'Concept-only until mounting, clearances, and safety details are verified.',
    source_notes: 'Seeded CRDN layout-ready product. Confirm mounting and safety requirements before production use.'
  },
  {
    product_id: 'crdn-rect-cabinet-system-970x380',
    sku: 'CRDN-CAB-970-380',
    name: 'CRDN Universal Rectangle Cabinet System - Deep',
    category: 'modular cabinet / utility storage',
    status: 'approved',
    unit: 'mm',
    width_mm: 970.21,
    depth_mm: 380.04,
    layout_component_type: 'rectangular_cabinet',
    shape_rule: 'configurable_rectangle_footprint',
    layout_width_mm: 970.21,
    layout_depth_mm: 380.04,
    dimension_confidence: 'MEDIUM',
    is_configurable: 1,
    configurable_dimensions_json: JSON.stringify({
      width_mm: { default: 970.21, min: 700, max: 1300, step: 1 },
      depth_mm: { default: 380.04, min: 250, max: 500, step: 1 },
      height_mm: { default: null, min: null, max: null, step: 1 }
    }),
    default_variant_json: JSON.stringify({ width_mm: 970.21, depth_mm: 380.04, height_mm: null }),
    compatible_vehicles_json: JSON.stringify(['universal', 'TownAce concept reference']),
    orientation_options_json: JSON.stringify(['driver_side', 'passenger_side', 'rear_crosswise', 'longitudinal']),
    allowed_zones_json: JSON.stringify(['floor', 'side_wall']),
    fitment_confidence: 'MEDIUM',
    production_ready: 0,
    production_warning: 'Concept-only until mounting and fabrication details are verified.',
    source_notes: 'Seeded CRDN configurable cabinet product for layout planning.'
  },
  {
    product_id: 'crdn-rect-cabinet-system-970x252',
    sku: 'CRDN-CAB-970-252',
    name: 'CRDN Universal Rectangle Cabinet System - Slim',
    category: 'modular cabinet / utility storage',
    status: 'approved',
    unit: 'mm',
    width_mm: 970.21,
    depth_mm: 252.26,
    layout_component_type: 'rectangular_cabinet',
    shape_rule: 'configurable_rectangle_footprint',
    layout_width_mm: 970.21,
    layout_depth_mm: 252.26,
    dimension_confidence: 'MEDIUM',
    is_configurable: 1,
    configurable_dimensions_json: JSON.stringify({
      width_mm: { default: 970.21, min: 700, max: 1300, step: 1 },
      depth_mm: { default: 252.26, min: 200, max: 420, step: 1 },
      height_mm: { default: null, min: null, max: null, step: 1 }
    }),
    default_variant_json: JSON.stringify({ width_mm: 970.21, depth_mm: 252.26, height_mm: null }),
    compatible_vehicles_json: JSON.stringify(['universal', 'TownAce concept reference']),
    orientation_options_json: JSON.stringify(['driver_side', 'passenger_side', 'rear_crosswise', 'longitudinal']),
    allowed_zones_json: JSON.stringify(['floor', 'side_wall']),
    fitment_confidence: 'MEDIUM',
    production_ready: 0,
    production_warning: 'Concept-only until mounting and fabrication details are verified.',
    source_notes: 'Seeded CRDN configurable cabinet product for layout planning.'
  }
];

function seedDesignAiProducts() {
  const fields = [
    'sku', 'name', 'category', 'unit', 'width_mm', 'depth_mm', 'height_mm', 'weight_kg',
    'compatible_vehicles_json', 'price', 'mounting_notes', 'installation_notes',
    'dimension_confidence', 'material', 'color', 'layout_component_type', 'layout_width_mm',
    'layout_depth_mm', 'layout_height_mm', 'layout_modes_json', 'shape_rule',
    'orientation_options_json', 'allowed_zones_json', 'clearance_notes', 'is_configurable',
    'configurable_dimensions_json', 'default_variant_json', 'variants_json', 'fitment_confidence',
    'fitment_reason', 'confirmed_data_json', 'estimated_data_json', 'production_warning',
    'production_ready', 'source_notes', 'seat_mode_width_mm', 'seat_mode_depth_mm',
    'bed_mode_width_mm', 'bed_mode_depth_mm', 'extended_bed_mode_width_mm',
    'extended_bed_mode_depth_mm', 'seat_panel_depth_mm', 'back_panel_depth_mm',
    'optional_extension_depth_mm', 'status'
  ];
  const insert = db.prepare(`
    INSERT INTO design_ai_product_records (product_id, ${fields.join(', ')}, version, updated_at)
    VALUES (?, ${fields.map(() => '?').join(', ')}, 1, CURRENT_TIMESTAMP)
  `);
  const shouldFill = (field, existing, incoming, row) => {
    if (incoming === undefined || incoming === null) return false;
    if (field === 'is_configurable') return Number(incoming) === 1 && Number(existing || 0) !== 1 && !row.source_notes;
    if (field === 'production_ready') return existing === undefined || existing === null;
    if (field === 'status') return existing === undefined || existing === null || existing === '';
    return existing === undefined || existing === null || existing === '';
  };
  const tx = db.transaction(() => {
    LAYOUT_READY_PRODUCTS.forEach(product => {
      const existing = db.prepare('SELECT * FROM design_ai_product_records WHERE product_id=?').get(product.product_id);
      if (!existing) {
        insert.run(product.product_id, ...fields.map(field => product[field] ?? null));
        return;
      }
      const updates = [];
      const values = [];
      fields.forEach(field => {
        if (!shouldFill(field, existing[field], product[field], existing)) return;
        updates.push(`${field}=?`);
        values.push(product[field]);
      });
      if (!updates.length) return;
      db.prepare(`
        UPDATE design_ai_product_records
        SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP
        WHERE product_id=?
      `).run(...values, product.product_id);
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
  upsert.run('default_deposit_to_design_consulting_days', '0');
  upsert.run('default_design_consulting_to_3d_cad_days', '0');
  upsert.run('default_deposit_to_parts_ordered_days', '0');
  upsert.run('default_parts_ordered_to_arrived_days', '7');
  upsert.run('default_parts_arrived_to_garage_days', '0');
  upsert.run('default_build_days', '14');
  upsert.run('default_qc_days', '2');
  upsert.run('default_qc_to_photoshoot_days', '0');
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
  const rows = db.prepare(
    "SELECT job_no FROM vehicles WHERE job_no LIKE 'CRDN-%'"
  ).all();

  const highest = rows.reduce((max, row) => {
    const match = String(row.job_no || '').match(/^CRDN-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  const next = highest + 1;
  return `CRDN-${String(next).padStart(3, '0')}`;
}

function normalizeVehicles() {
  const rows = db.prepare('SELECT id, job_no, stage, progress, archived FROM vehicles ORDER BY id').all();
  const update = db.prepare('UPDATE vehicles SET job_no=?, stage=?, progress=?, archived=? WHERE id=?');
  const tx = db.transaction(() => {
    rows.forEach(row => {
      const stage = normalizeStage(row.stage);
      update.run(row.job_no || nextJobNo(), stage, stageProgress(stage), stage === '16 Archived' ? 1 : row.archived, row.id);
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
  seedDesignAiProducts();
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
