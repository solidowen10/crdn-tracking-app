const fs = require('fs');
const { google } = require('googleapis');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];
const REQUIRED_MISSING_DATA = [
  'vehicle.json',
  'dimensions.csv',
  'mounting_points.csv',
  'restricted_zones.csv',
  'floorplan.svg',
  'product.json',
  'product dimensions',
  'product footprint.svg'
];
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DESIGN_AI_LOG_PREFIX = '[design-ai]';

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function designAiLog(event, details = {}) {
  try {
    console.log(DESIGN_AI_LOG_PREFIX, JSON.stringify({ event, ...details }));
  } catch (err) {
    console.log(DESIGN_AI_LOG_PREFIX, event);
  }
}

function labelFromKey(key) {
  return clean(key)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function textBlock(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return clean(value);
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        const line = textBlock(item);
        return line ? `- ${line.replace(/\n/g, '\n  ')}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const line = textBlock(item);
        if (!line) return '';
        const label = labelFromKey(key);
        return label ? `${label}:\n${line}` : line;
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function normalizeDesignerNotes(value) {
  if (Array.isArray(value)) return value.map(textBlock).filter(Boolean);
  const note = textBlock(value);
  return note ? [note] : [];
}

function normalizeZone(zone, fallbackName) {
  if (zone && typeof zone === 'object' && !Array.isArray(zone)) {
    return {
      ...zone,
      name: clean(zone.name || zone.zone || fallbackName) || 'Zone',
      intent: textBlock(zone.intent || zone.description || zone.notes || zone.details || zone)
    };
  }
  return {
    name: clean(fallbackName) || 'Zone',
    intent: textBlock(zone)
  };
}

function normalizeZones(value) {
  if (Array.isArray(value)) return value.map((zone, index) => normalizeZone(zone, `Zone ${index + 1}`));
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, zone]) => normalizeZone(zone, labelFromKey(key)));
  }
  return [];
}

function normalizeLayout(value) {
  const layout = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const zoneSource = layout.zones || layout.recommended_zones || layout.layout_zones || layout.areas;
  const zones = normalizeZones(zoneSource);
  if (zones.length) layout.zones = zones;
  return layout;
}

function parseServiceAccountFile(filePath) {
  if (!filePath) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      clientEmail: clean(raw.client_email),
      privateKey: clean(raw.private_key),
      projectId: clean(raw.project_id)
    };
  } catch (err) {
    return {};
  }
}

function driveCredentials() {
  const fromFile = parseServiceAccountFile(clean(process.env.GOOGLE_APPLICATION_CREDENTIALS));
  const clientEmail = clean(process.env.GOOGLE_DRIVE_CLIENT_EMAIL || fromFile.clientEmail);
  const rawKey = clean(process.env.GOOGLE_DRIVE_PRIVATE_KEY || fromFile.privateKey);
  return {
    clientEmail,
    privateKey: rawKey.replace(/\\n/g, '\n'),
    projectId: clean(process.env.GOOGLE_DRIVE_PROJECT_ID) || fromFile.projectId,
    configured: Boolean(clientEmail && rawKey)
  };
}

function driveStatus() {
  const creds = driveCredentials();
  return {
    credentials_configured: creds.configured,
    service_account_email: creds.clientEmail || '',
    project_id: creds.projectId || ''
  };
}

function requireDriveClient() {
  const creds = driveCredentials();
  if (!creds.configured) {
    const err = new Error('Google Drive credentials are not configured. Add GOOGLE_DRIVE_CLIENT_EMAIL and GOOGLE_DRIVE_PRIVATE_KEY, then share the Drive folders with that service account.');
    err.status = 409;
    throw err;
  }
  const auth = new google.auth.JWT({
    email: creds.clientEmail,
    key: creds.privateKey,
    scopes: DRIVE_SCOPES
  });
  return google.drive({ version: 'v3', auth });
}

function driveQueryId(id) {
  return clean(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function listDriveFolderFiles(drive, folderId, folderType) {
  const files = [];
  let pageToken = undefined;
  do {
    const response = await drive.files.list({
      q: `'${driveQueryId(folderId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, size)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    files.push(...(response.data.files || []).map(file => ({
      drive_file_id: file.id,
      folder_type: folderType,
      name: file.name || '',
      mime_type: file.mimeType || '',
      web_view_link: file.webViewLink || '',
      modified_time: file.modifiedTime || '',
      size: file.size || ''
    })));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function syncDriveFolders(settings) {
  const drive = requireDriveClient();
  const folderMap = {
    root: clean(settings.google_drive_root_folder_id),
    vehicles: clean(settings.vehicles_folder_id),
    products: clean(settings.products_folder_id),
    styles: clean(settings.styles_folder_id),
    templates: clean(settings.templates_folder_id)
  };
  const folders = {};
  const files = [];
  for (const [folderType, folderId] of Object.entries(folderMap)) {
    if (!folderId) {
      folders[folderType] = { folder_id: '', count: 0, skipped: true };
      continue;
    }
    const folderFiles = await listDriveFolderFiles(drive, folderId, folderType);
    folders[folderType] = { folder_id: folderId, count: folderFiles.length, skipped: false };
    files.push(...folderFiles);
  }
  return {
    files,
    folders,
    synced_at: new Date().toISOString()
  };
}

function fallbackDesignResponse(request, files, warning) {
  const vehicle = clean(request.vehicle_id) || 'selected vehicle';
  const lifestyle = clean(request.customer_lifestyle) || 'balanced everyday travel';
  let mustInclude = [];
  try {
    mustInclude = JSON.parse(request.must_include_json || '[]');
  } catch (err) {
    mustInclude = [];
  }
  const products = mustInclude.filter(Boolean);
  const fileNames = files.map(file => file.name).filter(Boolean).slice(0, 20);
  const missing = [...REQUIRED_MISSING_DATA];
  const summary = `Draft design direction for ${vehicle}: prioritize a flexible interior for ${lifestyle}, with sleeping, storage, and clean access zones planned around confirmed vehicle dimensions once library files are uploaded.`;
  const layout = {
    vehicle,
    zones: [
      { name: 'Rear utility zone', intent: 'Storage and modular gear access' },
      { name: 'Center living zone', intent: 'Convertible seating and circulation' },
      { name: 'Side service zone', intent: 'Power, water, and product mounting once dimensions are confirmed' }
    ],
    recommended_products: products,
    constraints: ['This MVP treats 3D files as references only.', 'Final fitment requires verified dimensions and restricted zones.'],
    missing_data: missing,
    indexed_files_seen: fileNames
  };
  const customerProposal = `We recommend starting with a flexible CRDN layout for ${vehicle}, tuned for ${lifestyle}. The first concept keeps the cabin adaptable, reserves space for priority products${products.length ? ` (${products.join(', ')})` : ''}, and leaves final mounting decisions pending verified vehicle and product data.`;
  const lifestylePrompt = `Photorealistic camper van interior concept for ${vehicle}, warm CRDN craftsmanship, modular storage, practical lifestyle details for ${lifestyle}, clean natural lighting, premium utility aesthetic.`;
  return {
    ai_summary: summary,
    layout,
    customer_proposal: customerProposal,
    lifestyle_prompt: lifestylePrompt,
    designer_notes: [
      warning || 'Generated as an MVP placeholder direction.',
      `Accurate floor plan requires: ${missing.join(', ')}.`
    ]
  };
}

function buildPrompt(request, files) {
  const safeFiles = files.slice(0, 80).map(file => ({
    folder_type: file.folder_type,
    name: file.name,
    mime_type: file.mime_type,
    modified_time: file.modified_time
  }));
  return {
    request: {
      vehicle_id: request.vehicle_id || '',
      customer_lifestyle: request.customer_lifestyle || '',
      people_count: request.people_count || '',
      budget: request.budget || '',
      must_include_json: request.must_include_json || '[]',
      style_id: request.style_id || '',
      notes: request.notes || ''
    },
    indexed_library_files: safeFiles,
    required_missing_data_warning: REQUIRED_MISSING_DATA
  };
}

function parseJsonObject(text) {
  const raw = clean(text);
  if (!raw) throw new Error('OpenAI returned an empty response.');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw err;
  }
}

async function generateDesignResponse(request, files) {
  const apiKey = clean(process.env.OPENAI_API_KEY);
  const model = clean(process.env.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL;
  const requestId = request?.id || null;
  designAiLog('generation config', {
    openai_enabled: Boolean(apiKey),
    model,
    request_id: requestId
  });
  if (!apiKey) {
    designAiLog('fallback', {
      reason: 'missing_openai_api_key',
      request_id: requestId,
      model
    });
    return fallbackDesignResponse(
      request,
      files,
      'OPENAI_API_KEY is not configured. This saved result is a backend-generated placeholder so the MVP workflow remains usable.'
    );
  }

  const prompt = buildPrompt(request, files);
  designAiLog('request sent', {
    request_id: requestId,
    model,
    indexed_file_count: files.length,
    prompt_bytes: Buffer.byteLength(JSON.stringify(prompt), 'utf8')
  });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are CRDN internal AI Design Library. Return concise valid JSON with ai_summary, layout, customer_proposal, lifestyle_prompt, and designer_notes. layout must include zones as an array of objects with name and intent whenever any layout recommendation is possible. customer_proposal must be customer-ready text, not a JSON object. Include missing_data warnings whenever accurate floor plans cannot be verified from library metadata.'
        },
        {
          role: 'user',
          content: JSON.stringify(prompt)
        }
      ],
      temperature: 0.4
    })
  });

  if (!response.ok) {
    const body = await response.text();
    designAiLog('response error', {
      request_id: requestId,
      model,
      status: response.status,
      body_sample: body.slice(0, 240)
    });
    const err = new Error(`OpenAI generation failed: ${body.slice(0, 240)}`);
    err.status = 502;
    throw err;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  designAiLog('response received', {
    request_id: requestId,
    model: data.model || model,
    choice_count: Array.isArray(data.choices) ? data.choices.length : 0,
    content_bytes: Buffer.byteLength(content, 'utf8')
  });
  const parsed = parseJsonObject(content);
  const layout = normalizeLayout(parsed.layout || parsed.recommended_layout || parsed.recommendedLayout || {});
  const customerProposal = textBlock(
    parsed.customer_proposal ||
    parsed.customerProposal ||
    parsed.customer_proposal_text ||
    parsed.proposal ||
    ''
  );
  designAiLog('response parsed', {
    request_id: requestId,
    keys: Object.keys(parsed),
    layout_keys: Object.keys(layout),
    layout_zone_count: Array.isArray(layout.zones) ? layout.zones.length : 0,
    customer_proposal_type: typeof parsed.customer_proposal
  });
  return {
    ai_summary: textBlock(parsed.ai_summary),
    layout,
    customer_proposal: customerProposal,
    lifestyle_prompt: textBlock(parsed.lifestyle_prompt),
    designer_notes: normalizeDesignerNotes(parsed.designer_notes),
    raw_openai_response: data
  };
}

module.exports = {
  driveStatus,
  syncDriveFolders,
  fallbackDesignResponse,
  generateDesignResponse,
  REQUIRED_MISSING_DATA
};
