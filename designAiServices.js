const fs = require('fs');
const { google } = require('googleapis');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_LIST_MAX_DEPTH = 5;
const TEXT_FILE_EXTENSIONS = new Set(['.json', '.csv', '.txt', '.md', '.svg']);
const EXTRACTION_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.json', '.csv', '.svg']);
const BINARY_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const VEHICLE_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.svg']);
const PRODUCT_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md']);
const REFERENCE_FILE_EXTENSIONS = new Set(['.glb', '.obj', '.fbx', '.step', '.ply', '.e57']);
const DIMENSION_LIKE_NAME_PARTS = ['dimension', 'size', 'measurement', 'install', 'spec', 'drawing', 'floorplan', 'layout', 'scan'];
const MAX_TEXT_FILE_BYTES = Number(process.env.DESIGN_AI_FILE_CONTENT_MAX_BYTES || 48 * 1024);
const MAX_PROMPT_CONTENT_BYTES = Number(process.env.DESIGN_AI_PROMPT_CONTENT_MAX_BYTES || 180 * 1024);
const MAX_PROMPT_CONTENT_FILES = 14;
const VEHICLE_REQUIRED_FILES = ['vehicle.json', 'dimensions.csv', 'floorplan.svg'];
const VEHICLE_OPTIONAL_FILES = ['mounting_points.csv', 'restricted_zones.csv', 'scan.glb', 'photos/'];
const PRODUCT_REQUIRED_FILES = ['product.json', 'dimensions.csv', 'footprint.svg', 'installation_rules.json'];
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

function fileExtension(name) {
  const base = clean(name).toLowerCase().split('?')[0].split('#')[0];
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index) : '';
}

function pathParts(file) {
  return clean(file.path || file.name).split('/').map(part => clean(part)).filter(Boolean);
}

function filePath(file) {
  return pathParts(file).join('/') || clean(file.name);
}

function isDriveFolder(file) {
  return Number(file.is_folder) === 1 || file.mime_type === DRIVE_FOLDER_MIME;
}

function fileCanonicalName(file) {
  const parts = pathParts(file);
  const name = clean(parts[parts.length - 1] || file.name).toLowerCase();
  if (isDriveFolder(file) && name === 'photos') return 'photos/';
  return name;
}

function entityNameForFile(file) {
  const parts = pathParts(file);
  if (parts.length > 1) return parts[0];
  if (parts.length === 1 && isDriveFolder(file)) return parts[0];
  const folder = clean(file.folder_type || 'library');
  return `${labelFromKey(folder)} Root`;
}

function isTextReadableFile(file) {
  if (isDriveFolder(file)) return false;
  return TEXT_FILE_EXTENSIONS.has(fileExtension(file.name || file.path));
}

function isReferenceOnlyFile(file) {
  const canonical = fileCanonicalName(file);
  if (canonical === 'photos/') return true;
  return REFERENCE_FILE_EXTENSIONS.has(fileExtension(file.name || file.path));
}

function isStructuredLibraryFile(file) {
  const canonical = fileCanonicalName(file);
  return VEHICLE_REQUIRED_FILES.includes(canonical) ||
    PRODUCT_REQUIRED_FILES.includes(canonical) ||
    VEHICLE_OPTIONAL_FILES.includes(canonical);
}

function isExtractionEvidenceFile(file) {
  if (isDriveFolder(file)) return false;
  return EXTRACTION_EVIDENCE_EXTENSIONS.has(fileExtension(file.name || file.path));
}

function isEntityEvidenceFile(file, folderType) {
  if (isDriveFolder(file)) return false;
  const extension = fileExtension(file.name || file.path);
  if (isStructuredLibraryFile(file)) return true;
  if (folderType === 'vehicles') return VEHICLE_EVIDENCE_EXTENSIONS.has(extension);
  if (folderType === 'products') return PRODUCT_EVIDENCE_EXTENSIONS.has(extension);
  return EXTRACTION_EVIDENCE_EXTENSIONS.has(extension);
}

function isDimensionLikeEvidence(file, folderType) {
  const canonical = fileCanonicalName(file);
  const haystack = normalizeSearchText(`${filePath(file)} ${file.name}`);
  if (folderType === 'vehicles' && ['dimensions.csv', 'floorplan.svg', 'mounting_points.csv', 'restricted_zones.csv', 'scan.glb'].includes(canonical)) {
    return true;
  }
  if (folderType === 'products' && ['dimensions.csv', 'footprint.svg', 'installation_rules.json'].includes(canonical)) {
    return true;
  }
  return DIMENSION_LIKE_NAME_PARTS.some(part => haystack.includes(part));
}

function normalizeSearchText(value) {
  return clean(value).toLowerCase();
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw.map(clean).filter(Boolean);
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : [];
  } catch (err) {
    return clean(raw).split(',').map(item => item.trim()).filter(Boolean);
  }
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

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePlacement(placement, index) {
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) return null;
  const id = clean(placement.id || placement.key || placement.name || placement.label || `placement-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `placement-${index + 1}`;
  return {
    id,
    label: clean(placement.label || placement.name || placement.zone || labelFromKey(id)) || `Placement ${index + 1}`,
    type: clean(placement.type || 'zone'),
    x: finiteNumber(placement.x),
    y: finiteNumber(placement.y),
    width: finiteNumber(placement.width || placement.w),
    depth: finiteNumber(placement.depth || placement.height || placement.d),
    notes: textBlock(placement.notes || placement.intent || placement.description || '')
  };
}

function normalizePlacements(value) {
  if (Array.isArray(value)) return value.map(normalizePlacement).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, placement], index) => {
      const normalized = normalizePlacement(placement, index);
      if (normalized && (!placement.id && !placement.label && !placement.name)) {
        normalized.id = clean(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || normalized.id;
        normalized.label = labelFromKey(key) || normalized.label;
      }
      return normalized;
    }).filter(Boolean);
  }
  return [];
}

function normalizeLayout(value) {
  const layout = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const placements = normalizePlacements(layout.placements || layout.placement || layout.layout_placements);
  if (placements.length) layout.placements = placements;
  const zoneSource = layout.zones || layout.recommended_zones || layout.layout_zones || layout.areas;
  const zones = normalizeZones(zoneSource);
  if (zones.length) layout.zones = zones;
  if (!Array.isArray(layout.constraints)) layout.constraints = normalizeDesignerNotes(layout.constraints);
  if (!Array.isArray(layout.missing_data)) layout.missing_data = normalizeDesignerNotes(layout.missing_data);
  return layout;
}

function designLibraryReadiness(files = [], extractionStatusByEntity = {}) {
  const groupsByKey = new Map();
  files.forEach(file => {
    const folderType = clean(file.folder_type || 'root');
    const entity = entityNameForFile(file);
    const key = `${folderType}:${entity}`;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        folder_type: folderType,
        entity,
        files_count: 0,
        readable_files_count: 0,
        reference_files_count: 0,
        evidence_files_count: 0,
        dimension_evidence_count: 0,
        required_present: [],
        required_missing: [],
        optional_present: [],
        optional_missing: [],
        evidence_files: [],
        dimension_evidence_files: [],
        reference_files: [],
        source_drive_folder_id: '',
        files: []
      });
    }
    const group = groupsByKey.get(key);
    group.files_count += 1;
    if (isTextReadableFile(file)) group.readable_files_count += 1;
    if (!group.source_drive_folder_id && isDriveFolder(file) && pathParts(file).length <= 1) {
      group.source_drive_folder_id = clean(file.drive_file_id);
    }
    if (!group.source_drive_folder_id) group.source_drive_folder_id = clean(file.parent_drive_file_id || file.drive_file_id);
    if (isReferenceOnlyFile(file)) {
      group.reference_files_count += 1;
      group.reference_files.push(filePath(file));
    }
    if (isEntityEvidenceFile(file, folderType)) {
      group.evidence_files_count += 1;
      group.evidence_files.push(filePath(file));
    }
    if (isDimensionLikeEvidence(file, folderType)) {
      group.dimension_evidence_count += 1;
      group.dimension_evidence_files.push(filePath(file));
    }
    group.files.push(file);
  });

  const groups = Array.from(groupsByKey.values()).map(group => {
    const required = group.folder_type === 'vehicles'
      ? VEHICLE_REQUIRED_FILES
      : group.folder_type === 'products'
        ? PRODUCT_REQUIRED_FILES
        : [];
    const optional = group.folder_type === 'vehicles'
      ? VEHICLE_OPTIONAL_FILES
      : [];
    const present = new Set(group.files.map(fileCanonicalName));
    group.required_present = required.filter(name => present.has(name));
    group.required_missing = required.filter(name => !present.has(name));
    group.optional_present = optional.filter(name => present.has(name));
    group.optional_missing = optional.filter(name => !present.has(name));
    const lookup = extractionStatusByEntity[`${group.folder_type}:${group.entity}`] ||
      extractionStatusByEntity[`${group.folder_type}:${normalizeSearchText(group.entity)}`] ||
      {};
    group.extraction_status = clean(lookup.status || '');
    group.latest_extraction_id = lookup.latest_extraction_id || null;
    group.approved_record_id = lookup.approved_record_id || null;
    if (group.approved_record_id || group.extraction_status === 'approved') {
      group.status = 'Approved';
    } else if (group.latest_extraction_id || group.extraction_status === 'draft') {
      group.status = 'Extracted Draft';
    } else if (group.evidence_files_count) {
      group.status = 'Ready for Extraction';
    } else if (group.reference_files_count) {
      group.status = 'Reference Only';
    } else {
      group.status = 'Missing Evidence';
    }
    group.has_dimension_evidence = group.dimension_evidence_count > 0;
    group.missing_evidence = group.evidence_files_count === 0;
    delete group.files;
    return group;
  }).sort((a, b) => a.folder_type.localeCompare(b.folder_type) || a.entity.localeCompare(b.entity));

  return {
    groups,
    summary: {
      ready_for_extraction: groups.filter(group => group.status === 'Ready for Extraction').length,
      extracted_draft: groups.filter(group => group.status === 'Extracted Draft').length,
      approved: groups.filter(group => group.status === 'Approved').length,
      missing_evidence: groups.filter(group => group.status === 'Missing Evidence').length,
      reference_only: groups.filter(group => group.status === 'Reference Only').length
    }
  };
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

async function listDriveFolderFiles(drive, folderId, folderType, parentPath = [], depth = 0) {
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
    for (const file of response.data.files || []) {
      const isFolder = file.mimeType === DRIVE_FOLDER_MIME;
      const currentPath = [...parentPath, file.name || 'Untitled'];
      files.push({
        drive_file_id: file.id,
        folder_type: folderType,
        name: file.name || '',
        path: currentPath.join('/'),
        parent_drive_file_id: folderId,
        mime_type: file.mimeType || '',
        web_view_link: file.webViewLink || '',
        modified_time: file.modifiedTime || '',
        size: file.size || '',
        is_folder: isFolder ? 1 : 0
      });
      if (isFolder && depth < DRIVE_LIST_MAX_DEPTH) {
        const childFiles = await listDriveFolderFiles(drive, file.id, folderType, currentPath, depth + 1);
        files.push(...childFiles);
      }
    }
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

function promptFileMetadata(file) {
  return {
    folder_type: file.folder_type,
    entity: entityNameForFile(file),
    name: file.name,
    path: filePath(file),
    mime_type: file.mime_type,
    modified_time: file.modified_time,
    size: file.size,
    is_folder: Boolean(Number(file.is_folder))
  };
}

function searchableFileText(file) {
  return normalizeSearchText([
    file.folder_type,
    entityNameForFile(file),
    file.name,
    filePath(file)
  ].join(' '));
}

function requestPromptTerms(request) {
  return {
    vehicle: normalizeSearchText(request.vehicle_id),
    products: parseJsonArray(request.must_include_json).map(normalizeSearchText).filter(Boolean),
    style: normalizeSearchText(request.style_id)
  };
}

function scorePromptFile(file, terms, groupCounts) {
  if (!isTextReadableFile(file)) return -1;
  const haystack = searchableFileText(file);
  let score = 0;
  if (file.folder_type === 'vehicles') {
    score += 20;
    if (terms.vehicle && haystack.includes(terms.vehicle)) score += 100;
    else if ((groupCounts.vehicles || 0) <= 1) score += 35;
  }
  if (file.folder_type === 'products') {
    score += 15;
    if (terms.products.some(term => term && haystack.includes(term))) score += 100;
    else if (!terms.products.length && (groupCounts.products || 0) <= 3) score += 20;
  }
  if (file.folder_type === 'styles') {
    score += 10;
    if (terms.style && haystack.includes(terms.style)) score += 90;
    else if (!terms.style && (groupCounts.styles || 0) <= 2) score += 20;
  }
  if (file.folder_type === 'templates') score += 5;
  return score;
}

function selectedPromptFiles(request, files) {
  const terms = requestPromptTerms(request);
  const readiness = designLibraryReadiness(files);
  const groupCounts = readiness.groups.reduce((acc, group) => {
    acc[group.folder_type] = (acc[group.folder_type] || 0) + 1;
    return acc;
  }, {});
  return files
    .map(file => ({ file, score: scorePromptFile(file, terms, groupCounts) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || filePath(a.file).localeCompare(filePath(b.file)))
    .slice(0, MAX_PROMPT_CONTENT_FILES)
    .map(item => item.file);
}

function truncateToBytes(value, maxBytes) {
  const buffer = Buffer.from(clean(value), 'utf8');
  if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false, bytes: buffer.length };
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    bytes: buffer.length
  };
}

async function readDriveTextFile(drive, file, remainingBytes) {
  const size = Number(file.size || 0);
  const limit = Math.min(MAX_TEXT_FILE_BYTES, remainingBytes);
  if (!limit) {
    return { skipped: true, reason: 'prompt_content_limit_reached' };
  }
  if (size && size > MAX_TEXT_FILE_BYTES) {
    return { skipped: true, reason: `file_too_large_${size}_bytes` };
  }
  const response = await drive.files.get(
    { fileId: file.drive_file_id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');
  const truncated = truncateToBytes(raw, limit);
  return {
    ...promptFileMetadata(file),
    content: truncated.text,
    content_bytes: truncated.bytes,
    truncated: truncated.truncated
  };
}

async function buildLibraryPromptContext(request, files) {
  const readiness = designLibraryReadiness(files);
  const selectedFiles = selectedPromptFiles(request, files);
  const assetReferences = files
    .filter(isReferenceOnlyFile)
    .slice(0, 40)
    .map(promptFileMetadata);
  const warnings = [];
  const readableFileContents = [];

  if (!selectedFiles.length) {
    return {
      readiness,
      selected_files: [],
      readable_file_contents: [],
      asset_references: assetReferences,
      content_warnings: warnings
    };
  }

  let drive;
  try {
    drive = requireDriveClient();
  } catch (err) {
    warnings.push(`Drive content read skipped: ${err.message}`);
    return {
      readiness,
      selected_files: selectedFiles.map(promptFileMetadata),
      readable_file_contents: readableFileContents,
      asset_references: assetReferences,
      content_warnings: warnings
    };
  }

  let usedBytes = 0;
  for (const file of selectedFiles) {
    try {
      const result = await readDriveTextFile(drive, file, MAX_PROMPT_CONTENT_BYTES - usedBytes);
      if (result.skipped) {
        warnings.push(`${filePath(file)} skipped: ${result.reason}`);
        continue;
      }
      usedBytes += Buffer.byteLength(result.content, 'utf8');
      readableFileContents.push(result);
    } catch (err) {
      warnings.push(`${filePath(file)} read failed: ${err.message}`);
    }
  }

  return {
    readiness,
    selected_files: selectedFiles.map(promptFileMetadata),
    readable_file_contents: readableFileContents,
    asset_references: assetReferences,
    content_warnings: warnings
  };
}

function extractionTemplate(entityType, entityId) {
  if (entityType === 'vehicle') {
    return {
      entity_type: 'vehicle',
      vehicle_id: entityId,
      brand: '',
      model: '',
      year_range: '',
      interior_length_mm: null,
      interior_width_mm: null,
      interior_height_mm: null,
      rear_door_width_mm: null,
      rear_door_height_mm: null,
      wheel_arch_width_mm: null,
      wheel_arch_height_mm: null,
      notes: '',
      field_confidence: {},
      source_evidence: []
    };
  }
  return {
    entity_type: 'product',
    product_id: entityId,
    sku: '',
    name: '',
    category: '',
    width_mm: null,
    depth_mm: null,
    height_mm: null,
    weight_kg: null,
    mounting_type: '',
    compatible_vehicles: [],
    requires_drilling: null,
    install_minutes: null,
    price: null,
    notes: '',
    field_confidence: {},
    source_evidence: []
  };
}

function normalizeExtractionValue(value) {
  if (value === undefined) return null;
  return value;
}

function normalizeExtractionResult(entityType, entityId, parsed) {
  const template = extractionTemplate(entityType, entityId);
  const normalized = { ...template };
  Object.keys(template).forEach(key => {
    if (key === 'field_confidence' || key === 'source_evidence') return;
    if (parsed[key] !== undefined && parsed[key] !== null) normalized[key] = parsed[key];
  });
  if (entityType === 'product') {
    normalized.product_id = clean(normalized.product_id || entityId);
    normalized.compatible_vehicles = Array.isArray(parsed.compatible_vehicles) ? parsed.compatible_vehicles.map(clean).filter(Boolean) : [];
  } else {
    normalized.vehicle_id = clean(normalized.vehicle_id || entityId);
  }
  normalized.field_confidence = parsed.field_confidence && typeof parsed.field_confidence === 'object' ? parsed.field_confidence : {};
  normalized.source_evidence = Array.isArray(parsed.source_evidence) ? parsed.source_evidence : [];
  Object.keys(normalized).forEach(key => {
    if (Array.isArray(normalized[key]) || normalized[key] === null || typeof normalized[key] === 'object') return;
    normalized[key] = normalizeExtractionValue(normalized[key]);
  });
  return normalized;
}

async function buildExtractionEvidenceContext(files = []) {
  const evidenceFiles = files.filter(isExtractionEvidenceFile);
  const warnings = [];
  const sourceFiles = evidenceFiles.map(file => ({
    ...promptFileMetadata(file),
    evidence_type: BINARY_EVIDENCE_EXTENSIONS.has(fileExtension(file.name || file.path)) ? 'binary_reference' : 'readable_text',
    direct_content_available: isTextReadableFile(file)
  }));
  const readableFileContents = [];
  const textFiles = evidenceFiles.filter(isTextReadableFile).slice(0, MAX_PROMPT_CONTENT_FILES);

  if (!textFiles.length) {
    if (evidenceFiles.length) {
      warnings.push('Only PDF/image evidence metadata is available right now. Upload text, markdown, CSV, JSON, or SVG evidence for stronger extraction.');
    }
    return { source_files: sourceFiles, readable_file_contents: readableFileContents, content_warnings: warnings };
  }

  let drive;
  try {
    drive = requireDriveClient();
  } catch (err) {
    warnings.push(`Drive content read skipped: ${err.message}`);
    return { source_files: sourceFiles, readable_file_contents: readableFileContents, content_warnings: warnings };
  }

  let usedBytes = 0;
  for (const file of textFiles) {
    try {
      const result = await readDriveTextFile(drive, file, MAX_PROMPT_CONTENT_BYTES - usedBytes);
      if (result.skipped) {
        warnings.push(`${filePath(file)} skipped: ${result.reason}`);
        continue;
      }
      usedBytes += Buffer.byteLength(result.content, 'utf8');
      readableFileContents.push(result);
    } catch (err) {
      warnings.push(`${filePath(file)} read failed: ${err.message}`);
    }
  }

  return { source_files: sourceFiles, readable_file_contents: readableFileContents, content_warnings: warnings };
}

function extractionSystemPrompt(entityType) {
  const shape = extractionTemplate(entityType, '');
  return [
    'You are CRDN internal Design AI extraction. Return concise valid JSON only.',
    'Extract structured dimensions and installation/product/vehicle facts from the provided evidence.',
    'Use millimeters for dimensions, kilograms for weight, and null when a value is unknown.',
    'Do not invent exact measurements from photos, PDFs, screenshots, scans, or 3D asset references when the content is not directly readable.',
    'For each populated field, add field_confidence[field] from 0 to 1 and list source_evidence entries naming the source file.',
    `Return this shape for ${entityType}: ${JSON.stringify(shape)}`
  ].join(' ');
}

async function extractDesignEntity({ entity_type, entity_id, folder_path, files }) {
  const entityType = clean(entity_type).toLowerCase();
  if (!['product', 'vehicle'].includes(entityType)) {
    const err = new Error('entity_type must be product or vehicle.');
    err.status = 400;
    throw err;
  }
  const entityId = clean(entity_id || folder_path);
  const evidence = await buildExtractionEvidenceContext(files || []);
  const apiKey = clean(process.env.OPENAI_API_KEY);
  const model = clean(process.env.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL;
  if (!apiKey) {
    const extracted = extractionTemplate(entityType, entityId);
    extracted.notes = 'OPENAI_API_KEY is not configured. This draft contains source evidence metadata only.';
    extracted.source_evidence = evidence.source_files.map(file => file.path || file.name).filter(Boolean);
    return {
      extracted,
      confidence: extracted.field_confidence,
      source_files: evidence.source_files,
      content_warnings: [...evidence.content_warnings, 'OpenAI extraction skipped because OPENAI_API_KEY is missing.'],
      raw_openai_response: null
    };
  }

  designAiLog('extraction request sent', {
    entity_type: entityType,
    entity_id: entityId,
    folder_path: folder_path || '',
    source_file_count: evidence.source_files.length,
    readable_content_file_count: evidence.readable_file_contents.length,
    model
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
        { role: 'system', content: extractionSystemPrompt(entityType) },
        {
          role: 'user',
          content: JSON.stringify({
            entity_type: entityType,
            entity_id: entityId,
            folder_path: folder_path || '',
            source_files: evidence.source_files,
            readable_file_contents: evidence.readable_file_contents,
            content_warnings: evidence.content_warnings
          })
        }
      ],
      temperature: 0.1
    })
  });
  if (!response.ok) {
    const body = await response.text();
    designAiLog('extraction response error', {
      entity_type: entityType,
      entity_id: entityId,
      status: response.status,
      body_sample: body.slice(0, 240)
    });
    const err = new Error(`OpenAI extraction failed: ${body.slice(0, 240)}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  const extracted = normalizeExtractionResult(entityType, entityId, parsed);
  designAiLog('extraction response parsed', {
    entity_type: entityType,
    entity_id: entityId,
    keys: Object.keys(parsed),
    source_file_count: evidence.source_files.length
  });
  return {
    extracted,
    confidence: extracted.field_confidence,
    source_files: evidence.source_files,
    content_warnings: evidence.content_warnings,
    raw_openai_response: data
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

function buildPrompt(request, files, libraryContext = {}, recordsContext = {}) {
  const safeFiles = files.slice(0, 80).map(file => ({
    folder_type: file.folder_type,
    name: file.name,
    path: filePath(file),
    mime_type: file.mime_type,
    modified_time: file.modified_time,
    size: file.size,
    is_folder: Boolean(Number(file.is_folder))
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
    library_readiness: libraryContext.readiness || designLibraryReadiness(files),
    approved_records: recordsContext.approved_records || {},
    latest_extraction_drafts: recordsContext.latest_extraction_drafts || {},
    selected_content_files: libraryContext.selected_files || [],
    readable_file_contents: libraryContext.readable_file_contents || [],
    asset_references: libraryContext.asset_references || [],
    content_warnings: libraryContext.content_warnings || [],
    expected_layout_shape: {
      placements: [
        {
          id: 'sleeping-area',
          label: 'Sleeping Area',
          type: 'zone',
          x: 0,
          y: 0,
          width: 1200,
          depth: 900,
          notes: ''
        }
      ],
      constraints: [],
      missing_data: []
    },
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

async function generateDesignResponse(request, files, recordsContext = {}) {
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

  const libraryContext = await buildLibraryPromptContext(request, files);
  const prompt = buildPrompt(request, files, libraryContext, recordsContext);
  designAiLog('request sent', {
    request_id: requestId,
    model,
    indexed_file_count: files.length,
    selected_content_file_count: libraryContext.selected_files.length,
    readable_content_file_count: libraryContext.readable_file_contents.length,
    asset_reference_count: libraryContext.asset_references.length,
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
          content: 'You are CRDN internal AI Design Library. Return concise valid JSON with ai_summary, layout, customer_proposal, lifestyle_prompt, and designer_notes. layout must include placements as an array of top-view placement objects using millimeters: id, label, type, x, y, width, depth, notes. layout must also include constraints and missing_data arrays. Prioritize information in this order: approved_records, latest_extraction_drafts, readable_file_contents or evidence summaries, indexed file names. Treat 3D files and photos as asset references only; do not infer exact fit from them. customer_proposal must be customer-ready text, not a JSON object. Preserve missing-data warnings whenever accurate floor plans, dimensions, mounting points, restricted zones, footprints, or installation rules are unavailable.'
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
    layout_placement_count: Array.isArray(layout.placements) ? layout.placements.length : 0,
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
  designLibraryReadiness,
  extractDesignEntity,
  fallbackDesignResponse,
  generateDesignResponse,
  REQUIRED_MISSING_DATA
};
