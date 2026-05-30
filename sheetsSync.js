const { google } = require('googleapis');
const fs = require('fs');

const SHEET_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SHEET_TABS = ['Projects', 'Quote Items', 'Parts', 'Services', 'Activity', 'Users'];
const SYNC_NOTE = 'Auto-synced from CRDN';

function syncEnabled() {
  return String(process.env.GOOGLE_SHEETS_SYNC_ENABLED || '').toLowerCase() === 'true';
}

function spreadsheetId() {
  return String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '').trim();
}

function credentialsConfigured() {
  return Boolean(String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim());
}

function googleSheetsStatus(lastSyncedAt = '', lastError = '') {
  return {
    enabled: syncEnabled(),
    spreadsheet_id: spreadsheetId(),
    credentials_configured: credentialsConfigured(),
    tabs: SHEET_TABS,
    last_synced_at: lastSyncedAt || '',
    last_error: lastError || ''
  };
}

function requireConfig() {
  if (!syncEnabled()) {
    const err = new Error('Google Sheets sync is disabled. Set GOOGLE_SHEETS_SYNC_ENABLED=true.');
    err.status = 409;
    throw err;
  }
  if (!spreadsheetId()) {
    const err = new Error('Missing GOOGLE_SHEETS_SPREADSHEET_ID.');
    err.status = 409;
    throw err;
  }
  if (!credentialsConfigured()) {
    const err = new Error('Missing GOOGLE_APPLICATION_CREDENTIALS.');
    err.status = 409;
    throw err;
  }
}

function sheetsClient() {
  requireConfig();
  const auth = new google.auth.GoogleAuth({ scopes: SHEET_SCOPES });
  return google.sheets({ version: 'v4', auth });
}

function value(value) {
  if (value === null || value === undefined) return '';
  return value;
}

function columnName(index) {
  let name = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetRange(tab, a1) {
  return `'${String(tab).replace(/'/g, "''")}'!${a1}`;
}

function keyValue(row) {
  return String(row?.[0] ?? '').trim();
}

function serviceAccountEmail() {
  const file = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!file) return '';
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).client_email || '';
  } catch (err) {
    return '';
  }
}

function moneyTotal(price, qty) {
  return Number(price || 0) * Number(qty || 1);
}

function rowsWithHeader(headers, rows) {
  return [headers, ...rows.map(row => headers.map(header => value(row[header])))];
}

function exportData(db) {
  const projects = db.prepare(`
    SELECT
      job_no AS "Project #",
      owner AS "Customer",
      name AS "Vehicle",
      plate AS "Plate / ID",
      pkg AS "Package",
      stage AS "Stage",
      progress AS "Progress %",
      priority AS "Priority",
      designer AS "Designer",
      start_date AS "Start Date",
      finish_date AS "Est. Finish",
      customer_update AS "Customer Update",
      customer_action AS "Customer Action",
      next_action AS "Next Action",
      notes AS "Notes",
      archived AS "Archived",
      created_at AS "Created At",
      updated_at AS "Updated At"
    FROM vehicles
    ORDER BY archived, updated_at DESC, id DESC
  `).all();

  const quoteItems = db.prepare(`
    SELECT
      qi.id AS "Quote Item ID",
      v.job_no AS "Project #",
      v.owner AS "Customer",
      v.name AS "Vehicle",
      qi.category AS "Category",
      qi.description AS "Description",
      qi.quantity AS "Quantity",
      qi.customer_price AS "Customer Unit Price",
      qi.internal_cost AS "Internal Unit Cost",
      qi.supplier AS "Supplier",
      qi.parts_status AS "Parts Status",
      qi.internal_notes AS "Internal Notes",
      qi.active AS "Active",
      qi.created_at AS "Created At",
      qi.updated_at AS "Updated At"
    FROM quote_items qi
    JOIN vehicles v ON v.id=qi.vehicle_id
    WHERE qi.active=1
    ORDER BY v.job_no, qi.sort_order, qi.id
  `).all().map(row => ({
    ...row,
    'Customer Subtotal': moneyTotal(row['Customer Unit Price'], row.Quantity),
    'Internal Subtotal': moneyTotal(row['Internal Unit Cost'], row.Quantity),
    Profit: moneyTotal(row['Customer Unit Price'], row.Quantity) - moneyTotal(row['Internal Unit Cost'], row.Quantity)
  }));

  const parts = db.prepare(`
    SELECT
      p.id AS "Part ID",
      v.job_no AS "Project #",
      v.owner AS "Customer",
      v.name AS "Vehicle",
      p.quote_item_id AS "Quote Item ID",
      qi.description AS "Linked Quote Item",
      qi.consultation_item_id AS "Consultation Item ID",
      p.part_name AS "Part / Item",
      p.supplier AS "Supplier",
      p.quantity AS "Quantity",
      p.cost AS "Cost",
      p.status AS "Status",
      p.eta AS "ETA",
      p.arrived_date AS "Arrived Date",
      p.installed_date AS "Installed Date",
      p.notes AS "Notes",
      p.created_at AS "Created At",
      p.updated_at AS "Updated At"
    FROM parts p
    JOIN vehicles v ON v.id=p.vehicle_id
    LEFT JOIN quote_items qi ON qi.id=p.quote_item_id
    WHERE p.active=1
    ORDER BY v.job_no, p.sort_order, p.id
  `).all();
  const partItemIds = parts.map(row => row['Consultation Item ID']).filter(Boolean);
  const subpartsByItem = new Map();
  if (partItemIds.length) {
    const placeholders = partItemIds.map(() => '?').join(',');
    db.prepare(`
      SELECT *
      FROM consultation_subparts
      WHERE active=1 AND consultation_item_id IN (${placeholders})
      ORDER BY consultation_item_id, sort_order, id
    `).all(...partItemIds).forEach(row => {
      if (!subpartsByItem.has(row.consultation_item_id)) subpartsByItem.set(row.consultation_item_id, []);
      subpartsByItem.get(row.consultation_item_id).push(row);
    });
  }
  const partsExport = parts.map(row => {
    const subparts = subpartsByItem.get(row['Consultation Item ID']) || [];
    return {
      ...row,
      'Sub-parts': subparts.map(part => `${part.name}: ${part.cost}`).join('\n'),
      'Sub-parts Cost Total': subparts.reduce((sum, part) => sum + Number(part.cost || 0), 0)
    };
  });

  const services = db.prepare(`
    SELECT
      ps.id AS "Project Service ID",
      v.job_no AS "Project #",
      v.owner AS "Customer",
      v.name AS "Vehicle",
      ps.name AS "Service",
      ps.description AS "Description",
      ps.active AS "Active",
      ps.created_at AS "Created At",
      ps.updated_at AS "Updated At"
    FROM project_services ps
    JOIN vehicles v ON v.id=ps.vehicle_id
    WHERE ps.active=1
    ORDER BY v.job_no, ps.sort_order, ps.id
  `).all();

  const activity = db.prepare(`
    SELECT
      al.id AS "Activity ID",
      v.job_no AS "Project #",
      v.owner AS "Customer",
      v.name AS "Vehicle",
      al.display_name AS "User",
      al.user_id AS "LINE User ID",
      al.action AS "Action",
      al.old_value AS "Old Value",
      al.new_value AS "New Value",
      al.created_at AS "Created At"
    FROM activity_log al
    LEFT JOIN vehicles v ON v.id=al.project_id
    ORDER BY al.created_at DESC, al.id DESC
  `).all();

  const users = db.prepare(`
    SELECT
      id AS "User ID",
      line_user_id AS "LINE User ID",
      display_name AS "Display Name",
      role AS "Role",
      last_login_at AS "Last Login At",
      created_at AS "Created At"
    FROM users
    ORDER BY created_at DESC, id DESC
  `).all();

  return {
    Projects: rowsWithHeader([
      'Project #', 'Customer', 'Vehicle', 'Plate / ID', 'Package', 'Stage',
      'Progress %', 'Priority', 'Designer', 'Start Date', 'Est. Finish',
      'Customer Update', 'Customer Action', 'Next Action', 'Notes', 'Archived',
      'Created At', 'Updated At'
    ], projects),
    'Quote Items': rowsWithHeader([
      'Quote Item ID', 'Project #', 'Customer', 'Vehicle', 'Category',
      'Description', 'Quantity', 'Customer Unit Price', 'Customer Subtotal',
      'Internal Unit Cost', 'Internal Subtotal', 'Profit', 'Supplier',
      'Parts Status', 'Internal Notes', 'Active', 'Created At', 'Updated At'
    ], quoteItems),
    Parts: rowsWithHeader([
      'Part ID', 'Project #', 'Customer', 'Vehicle', 'Quote Item ID',
      'Linked Quote Item', 'Part / Item', 'Supplier', 'Quantity', 'Cost',
      'Status', 'ETA', 'Arrived Date', 'Installed Date', 'Notes',
      'Created At', 'Updated At',
      'Sub-parts', 'Sub-parts Cost Total'
    ], partsExport),
    Services: rowsWithHeader([
      'Project Service ID', 'Project #', 'Customer', 'Vehicle',
      'Service', 'Description', 'Active', 'Created At', 'Updated At'
    ], services),
    Activity: rowsWithHeader([
      'Activity ID', 'Project #', 'Customer', 'Vehicle', 'User',
      'LINE User ID', 'Action', 'Old Value', 'New Value', 'Created At'
    ], activity),
    Users: rowsWithHeader([
      'User ID', 'LINE User ID', 'Display Name', 'Role', 'Last Login At', 'Created At'
    ], users)
  };
}

async function ensureSheets(sheets, id) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: 'spreadsheetId,properties.title,sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description))'
  });
  const sheetInfo = new Map((response.data.sheets || []).map(sheet => [sheet.properties.title, sheet]));
  const existingTabs = new Set(sheetInfo.keys());
  const missing = SHEET_TABS.filter(tab => !existingTabs.has(tab));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: missing.map(title => ({ addSheet: { properties: { title } } }))
      }
    });
    return ensureSheets(sheets, id);
  }
  return {
    spreadsheet_id: response.data.spreadsheetId,
    title: response.data.properties?.title || '',
    sheets: sheetInfo
  };
}

async function formatSyncedColumns(sheets, id, sheet, tab, headerCount) {
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined || !headerCount) return;
  const description = `CRDN auto-synced columns: ${tab}`;
  const deleteExisting = (sheet.protectedRanges || [])
    .filter(range => range.description === description)
    .map(range => ({ deleteProtectedRange: { protectedRangeId: range.protectedRangeId } }));
  const email = serviceAccountEmail();
  const protectedRange = {
    range: { sheetId, startColumnIndex: 0, endColumnIndex: headerCount },
    description,
    warningOnly: false
  };
  if (email) protectedRange.editors = { users: [email] };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        ...deleteExisting,
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: headerCount },
            cell: {
              note: SYNC_NOTE,
              userEnteredFormat: {
                backgroundColor: { red: 0.82, green: 0.82, blue: 0.82 },
                textFormat: { bold: true }
              }
            },
            fields: 'note,userEnteredFormat(backgroundColor,textFormat)'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: headerCount },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 }
              }
            },
            fields: 'userEnteredFormat.backgroundColor'
          }
        },
        { addProtectedRange: { protectedRange } }
      ]
    }
  });
}

async function syncTab(sheets, id, tab, values, sheet) {
  const headers = values[0] || [];
  const rows = values.slice(1);
  if (!headers.length) return 0;

  const lastCol = columnName(headers.length);
  const fullRange = sheetRange(tab, `A1:${lastCol}`);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: id,
    range: fullRange
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: sheetRange(tab, `A1:${lastCol}${values.length}`),
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  await formatSyncedColumns(sheets, id, sheet, tab, headers.length);
  return rows.length;
}

async function testGoogleSheetsConnection() {
  const sheets = sheetsClient();
  const info = await ensureSheets(sheets, spreadsheetId());
  return { ok: true, spreadsheet_id: info.spreadsheet_id, title: info.title, tabs: SHEET_TABS };
}

async function syncGoogleSheets(db) {
  const sheets = sheetsClient();
  const id = spreadsheetId();
  const info = await ensureSheets(sheets, id);
  const data = exportData(db);
  const counts = {};

  for (const tab of SHEET_TABS) {
    const values = data[tab];
    counts[tab] = await syncTab(sheets, id, tab, values, info.sheets.get(tab));
  }

  return {
    ok: true,
    spreadsheet_id: id,
    title: info.title,
    tabs: SHEET_TABS,
    counts,
    synced_at: new Date().toISOString()
  };
}

module.exports = {
  googleSheetsStatus,
  testGoogleSheetsConnection,
  syncGoogleSheets
};
