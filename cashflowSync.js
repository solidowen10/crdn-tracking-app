const { google } = require('googleapis');
const fs = require('fs');

const SHEET_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const CASHFLOW_SPREADSHEET_ID =
  process.env.GOOGLE_CASHFLOW_SPREADSHEET_ID ||
  '1kMPlZymdUNhorXmwkMsCSBiuVyj8MTPE3BgDrnThTSc';
const SYNC_NOTE = 'Auto-synced from CRDN cashflow';
const MONTH_TAB_RE = /^\d{4}-\d{2}$/;

function syncEnabled() {
  return String(process.env.GOOGLE_SHEETS_SYNC_ENABLED || '').toLowerCase() === 'true';
}

function spreadsheetId() {
  return String(CASHFLOW_SPREADSHEET_ID || '').trim();
}

function requireConfig() {
  if (!syncEnabled()) {
    const err = new Error('Google Sheets sync is disabled. Set GOOGLE_SHEETS_SYNC_ENABLED=true.');
    err.status = 409;
    throw err;
  }
  if (!spreadsheetId()) {
    const err = new Error('Missing Google Cashflow spreadsheet ID.');
    err.status = 409;
    throw err;
  }
  if (!String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()) {
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

function serviceAccountEmail() {
  const file = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!file) return '';
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).client_email || '';
  } catch (err) {
    return '';
  }
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function money(value) {
  return Number(String(value ?? '').replace(/[^\d.-]/g, '')) || 0;
}

function parseArrayJson(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function parseProjectCashflow(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return {
      deposits: Array.isArray(parsed.deposits) ? parsed.deposits : [],
      vendorPayments: Array.isArray(parsed.vendorPayments) ? parsed.vendorPayments : []
    };
  } catch (err) {
    return { deposits: [], vendorPayments: [] };
  }
}

function monthTab(date) {
  const value = text(date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 7);
  return new Date().toISOString().slice(0, 7);
}

function rowHasContent(entry) {
  return Boolean(text(entry.date) || text(entry.desc) || text(entry.note) || money(entry.amount));
}

function cashflowRows(db) {
  const rows = [];
  const projects = db.prepare(`
    SELECT id, job_no, owner, name, stage, archived, cashflow_json
    FROM vehicles
    WHERE archived=0 AND stage!='14 Archived'
    ORDER BY job_no, id
  `).all();

  projects.forEach(project => {
    const source = `${project.job_no || project.id} · ${project.name || ''} — ${project.owner || ''}`;
    const cf = parseProjectCashflow(project.cashflow_json);
    (cf.deposits || []).forEach((entry, index) => {
      if (!rowHasContent(entry)) return;
      const amount = money(entry.amount);
      rows.push({
        key: `project:${project.id}:deposit:${index}`,
        month: monthTab(entry.date),
        date: text(entry.date),
        type: 'Project deposit',
        category: 'Project deposit',
        description: text(entry.desc) || 'Deposit collected',
        source,
        moneyIn: amount,
        moneyOut: 0,
        group: 'project_deposit'
      });
    });
    (cf.vendorPayments || []).forEach((entry, index) => {
      if (!rowHasContent(entry)) return;
      const amount = money(entry.amount);
      rows.push({
        key: `project:${project.id}:vendor:${index}`,
        month: monthTab(entry.date),
        date: text(entry.date),
        type: 'Project vendor payment',
        category: 'Vendor / parts',
        description: text(entry.desc) || 'Vendor payment',
        source,
        moneyIn: 0,
        moneyOut: amount,
        group: 'project_vendor'
      });
    });
  });

  const settingsRow = db.prepare("SELECT value FROM app_settings WHERE key='master_cashflow_entries'").get();
  parseArrayJson(settingsRow?.value).forEach((entry, index) => {
    if (!rowHasContent(entry)) return;
    const isIncome = entry.type === 'income';
    rows.push({
      key: `company:${entry.id || index}`,
      month: monthTab(entry.date),
      date: text(entry.date),
      type: isIncome ? 'Company income' : 'Company expense',
      category: text(entry.category) || (isIncome ? 'Other income' : 'Other expense'),
      description: text(entry.desc),
      source: text(entry.note) || 'Company',
      moneyIn: isIncome ? money(entry.amount) : 0,
      moneyOut: isIncome ? 0 : money(entry.amount),
      group: isIncome ? 'company_income' : 'company_expense'
    });
  });

  return rows.sort((a, b) => {
    const dateCompare = String(a.date).localeCompare(String(b.date));
    return dateCompare || String(a.key).localeCompare(String(b.key));
  });
}

function sheetRange(tab, a1) {
  return `'${String(tab).replace(/'/g, "''")}'!${a1}`;
}

async function spreadsheetInfo(sheets, id) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: id,
    fields: 'spreadsheetId,properties.title,sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description))'
  });
  return {
    spreadsheetId: response.data.spreadsheetId,
    title: response.data.properties?.title || '',
    sheets: new Map((response.data.sheets || []).map(sheet => [sheet.properties.title, sheet]))
  };
}

async function ensureMonthTabs(sheets, id, months) {
  let info = await spreadsheetInfo(sheets, id);
  const missing = months.filter(month => !info.sheets.has(month));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: missing.map(title => ({ addSheet: { properties: { title } } }))
      }
    });
    info = await spreadsheetInfo(sheets, id);
  }
  return info;
}

async function readExistingRows(sheets, id, tab) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: sheetRange(tab, 'A2:I')
  }).catch(err => {
    if (err.code === 400) return { data: { values: [] } };
    throw err;
  });
  const values = response.data.values || [];
  const rowsByKey = new Map();
  values.forEach((row, index) => {
    const key = text(row[0]);
    if (key) rowsByKey.set(key, { rowNumber: index + 2, note: row[8] || '' });
  });
  return { rowsByKey, lastRow: values.length + 1 };
}

function dataValues(row) {
  return [
    row.key,
    row.date,
    row.type,
    row.category,
    row.description,
    row.source,
    row.moneyIn || '',
    row.moneyOut || ''
  ];
}

function summaryRows(rows) {
  const projectDeposits = rows.filter(row => row.group === 'project_deposit').reduce((sum, row) => sum + row.moneyIn, 0);
  const companyIncome = rows.filter(row => row.group === 'company_income').reduce((sum, row) => sum + row.moneyIn, 0);
  const projectVendor = rows.filter(row => row.group === 'project_vendor').reduce((sum, row) => sum + row.moneyOut, 0);
  const companyExpenses = rows.filter(row => row.group === 'company_expense').reduce((sum, row) => sum + row.moneyOut, 0);
  const totalIncome = projectDeposits + companyIncome;
  const totalExpenses = projectVendor + companyExpenses;
  return [
    ['Project deposits', projectDeposits],
    ['Company income', companyIncome],
    ['Total income', totalIncome],
    ['Project vendor payments', projectVendor],
    ['Company expenses', companyExpenses],
    ['Total expenses', totalExpenses],
    ['Net P&L', totalIncome - totalExpenses],
    ['Synced rows', rows.length]
  ];
}

async function formatMonthSheet(sheets, id, sheet, tab) {
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId === undefined) return;
  const dataDescription = `CRDN cashflow synced data: ${tab}`;
  const pnlDescription = `CRDN cashflow P&L: ${tab}`;
  const deleteExisting = (sheet.protectedRanges || [])
    .filter(range => [dataDescription, pnlDescription].includes(range.description))
    .map(range => ({ deleteProtectedRange: { protectedRangeId: range.protectedRangeId } }));
  const email = serviceAccountEmail();
  const dataProtectedRange = {
    range: { sheetId, startColumnIndex: 0, endColumnIndex: 8 },
    description: dataDescription,
    warningOnly: false
  };
  const pnlProtectedRange = {
    range: { sheetId, startColumnIndex: 10, endColumnIndex: 12 },
    description: pnlDescription,
    warningOnly: false
  };
  if (email) {
    dataProtectedRange.editors = { users: [email] };
    pnlProtectedRange.editors = { users: [email] };
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        ...deleteExisting,
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount'
          }
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
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
            range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 } } },
            fields: 'userEnteredFormat.backgroundColor'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 8, endColumnIndex: 9 },
            cell: {
              note: 'Manual notes - editable',
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 0.96, blue: 0.78 },
                textFormat: { bold: true }
              }
            },
            fields: 'note,userEnteredFormat(backgroundColor,textFormat)'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 8, endColumnIndex: 9 },
            cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.98, blue: 0.86 } } },
            fields: 'userEnteredFormat.backgroundColor'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 10, endColumnIndex: 12 },
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
            range: { sheetId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 12 },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.94, green: 0.94, blue: 0.94 } } },
            fields: 'userEnteredFormat.backgroundColor'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 8 },
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
            fields: 'userEnteredFormat.numberFormat'
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 },
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } },
            fields: 'userEnteredFormat.numberFormat'
          }
        },
        { addProtectedRange: { protectedRange: dataProtectedRange } },
        { addProtectedRange: { protectedRange: pnlProtectedRange } }
      ]
    }
  });
}

async function syncMonth(sheets, id, sheet, tab, rows) {
  const headers = [
    'Row Key',
    'Date',
    'Type',
    'Category',
    'Description',
    'Source / Project',
    'Money In',
    'Money Out',
    'Notes',
    '',
    'P&L Metric',
    'Amount (NT$)'
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: sheetRange(tab, 'A1:L1'),
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  });

  const existing = await readExistingRows(sheets, id, tab);
  const desiredKeys = new Set(rows.map(row => row.key));
  let nextRow = Math.max(existing.lastRow + 1, 2);
  const data = [];

  rows.forEach(row => {
    const existingRow = existing.rowsByKey.get(row.key)?.rowNumber;
    const rowNumber = existingRow || nextRow++;
    data.push({
      range: sheetRange(tab, `A${rowNumber}:H${rowNumber}`),
      values: [dataValues(row)]
    });
    if (!existingRow) {
      data.push({
        range: sheetRange(tab, `I${rowNumber}:I${rowNumber}`),
        values: [['']]
      });
    }
  });

  for (const [key, current] of existing.rowsByKey.entries()) {
    if (!desiredKeys.has(key)) {
      data.push({
        range: sheetRange(tab, `A${current.rowNumber}:H${current.rowNumber}`),
        values: [Array(8).fill('')]
      });
    }
  }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: id,
    range: sheetRange(tab, 'K2:L20')
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: sheetRange(tab, 'K2:L9'),
    valueInputOption: 'RAW',
    requestBody: { values: summaryRows(rows) }
  });

  await formatMonthSheet(sheets, id, sheet, tab);
  return rows.length;
}

async function syncMasterCashflow(db) {
  const sheets = sheetsClient();
  const id = spreadsheetId();
  const rows = cashflowRows(db);
  const rowsByMonth = new Map();
  rows.forEach(row => {
    if (!rowsByMonth.has(row.month)) rowsByMonth.set(row.month, []);
    rowsByMonth.get(row.month).push(row);
  });
  const currentMonth = new Date().toISOString().slice(0, 7);
  const requiredMonths = rowsByMonth.size ? [...rowsByMonth.keys()] : [currentMonth];
  let info = await ensureMonthTabs(sheets, id, requiredMonths);
  const existingMonthTabs = [...info.sheets.keys()].filter(title => MONTH_TAB_RE.test(title));
  const tabs = [...new Set([...requiredMonths, ...existingMonthTabs])].sort();
  info = await ensureMonthTabs(sheets, id, tabs);

  const counts = {};
  for (const tab of tabs) {
    counts[tab] = await syncMonth(sheets, id, info.sheets.get(tab), tab, rowsByMonth.get(tab) || []);
  }

  return {
    ok: true,
    spreadsheet_id: id,
    tabs,
    counts,
    synced_at: new Date().toISOString()
  };
}

module.exports = {
  syncMasterCashflow
};
