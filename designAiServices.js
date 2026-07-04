const fs = require('fs');
const { google } = require('googleapis');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_LIST_MAX_DEPTH = 5;
const TEXT_FILE_EXTENSIONS = new Set(['.json', '.csv', '.txt', '.md', '.svg']);
const EXTRACTION_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.json', '.csv', '.svg']);
const BINARY_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const VEHICLE_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.json', '.csv', '.svg']);
const PRODUCT_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.json', '.csv']);
const REFERENCE_FILE_EXTENSIONS = new Set(['.glb', '.obj', '.fbx', '.step', '.ply', '.e57']);
const DIMENSION_LIKE_NAME_PARTS = ['dimension', 'size', 'measurement', 'install', 'spec', 'drawing', 'floorplan', 'layout', 'scan'];
const MAX_TEXT_FILE_BYTES = Number(process.env.DESIGN_AI_FILE_CONTENT_MAX_BYTES || 48 * 1024);
const MAX_PROMPT_CONTENT_BYTES = Number(process.env.DESIGN_AI_PROMPT_CONTENT_MAX_BYTES || 180 * 1024);
const MAX_PROMPT_CONTENT_FILES = 14;
const VEHICLE_REQUIRED_FILES = ['vehicle.json', 'dimensions.csv', 'topdown_base.png'];
const VEHICLE_OPTIONAL_FILES = ['floorplan.svg', 'mounting_points.csv', 'restricted_zones.csv', 'layout_constraints.json', 'buildability_report.md', 'manifest.json', 'vehicle_knowledge_sheet.pdf', 'scan.glb', 'photos/'];
const VEHICLE_TOPDOWN_BASE_NAMES = ['topdown_base.png', 'topdown_base.jpg', 'topdown_base.jpeg', 'topdown.png', 'topdown.jpg', 'topdown.jpeg', 'vehicle_topdown_base.png', 'vehicle_topdown_base.jpg', 'vehicle_topdown_base.jpeg'];
const PRODUCT_REQUIRED_FILES = ['product.json', 'dimensions.csv', 'footprint.svg', 'installation_rules.json'];
const VEHICLE_RESEARCH_MATCH_RANK = {
  exact_preferred: 10,
  exact_filename: 20,
  fallback_pattern: 30,
  content: 40
};
const VEHICLE_RESEARCH_TYPES = {
  vehicle_record: {
    label: 'Vehicle record',
    detected_type: 'vehicle_record_json',
    preferred: ['extracted/vehicle_record.json', 'extracted/vehicle.json'],
    exactNames: ['vehicle_record.json', 'vehicle.json']
  },
  dimensions_csv: {
    label: 'Dimensions CSV',
    detected_type: 'dimensions_csv',
    preferred: ['extracted/dimensions.csv'],
    exactNames: ['dimensions.csv']
  },
  layout_constraints: {
    label: 'Layout constraints',
    detected_type: 'layout_constraints_json',
    preferred: ['extracted/layout_constraints.json'],
    exactNames: ['layout_constraints.json']
  },
  buildability_report: {
    label: 'Buildability report',
    detected_type: 'buildability_report',
    preferred: ['extracted/buildability_report.md'],
    exactNames: ['buildability_report.md', 'buildability.md', 'geometry.md', 'layout.md']
  },
  manifest: {
    label: 'Manifest',
    detected_type: 'manifest_json',
    preferred: ['extracted/manifest.json'],
    exactNames: ['manifest.json']
  },
  knowledge_sheet: {
    label: 'Knowledge sheet',
    detected_type: 'vehicle_knowledge_sheet',
    preferred: ['source/vehicle_knowledge_sheet.png', 'source/vehicle_knowledge_sheet.jpg', 'source/vehicle_knowledge_sheet.pdf'],
    exactNames: ['vehicle_knowledge_sheet.png', 'vehicle_knowledge_sheet.jpg', 'vehicle_knowledge_sheet.jpeg', 'vehicle_knowledge_sheet.pdf']
  }
};
const VEHICLE_RESEARCH_ORDER = ['vehicle_record', 'layout_constraints', 'dimensions_csv', 'manifest', 'buildability_report', 'knowledge_sheet'];
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
const DESIGN_AI_DEBUG_LOGS = process.env.DESIGN_AI_DEBUG_LOGS === '1';
const VEHICLE_METADATA_FIELDS = new Set([
  'brand', 'make', 'model', 'generation', 'market', 'body_type', 'year_range', 'notes'
]);
const VEHICLE_NUMERIC_FIELDS = new Set([
  'overall_length_mm', 'overall_width_mm', 'overall_height_mm', 'wheelbase_mm',
  'interior_length_mm', 'interior_width_mm', 'interior_height_mm',
  'side_door_width_mm', 'side_door_height_mm', 'rear_door_width_mm', 'rear_door_height_mm',
  'rear_window_width_mm', 'rear_window_height_mm',
  'wheel_arch_width_mm', 'wheel_arch_height_mm', 'wheel_arch_position_x_mm', 'wheel_arch_position_y_mm',
  'payload_kg'
]);
const VEHICLE_PHYSICAL_MEASUREMENT_FIELDS = [
  'wheel_arch_width_mm',
  'wheel_arch_height_mm',
  'rear_window_width_mm',
  'rear_window_height_mm',
  'mounting_point_locations'
];
const VEHICLE_FIELD_ALIASES = {
  brand: ['brand', 'make', 'manufacturer', 'marque'],
  make: ['make', 'brand', 'manufacturer', 'marque'],
  model: ['model', 'vehicle_model', 'model_name'],
  generation: ['generation', 'gen', 'model_generation', 'series'],
  market: ['market', 'region', 'country', 'market_region'],
  body_type: ['body_type', 'body style', 'body_style', 'vehicle_type', 'van_type'],
  year_range: ['year_range', 'model_years', 'production_years', 'years', 'year'],
  overall_length_mm: ['overall_length_mm', 'exterior_length_mm', 'vehicle_length_mm', 'length_mm', 'overall length', 'exterior length'],
  overall_width_mm: ['overall_width_mm', 'exterior_width_mm', 'vehicle_width_mm', 'width_mm', 'overall width', 'exterior width'],
  overall_height_mm: ['overall_height_mm', 'exterior_height_mm', 'vehicle_height_mm', 'height_mm', 'overall height', 'exterior height'],
  wheelbase_mm: ['wheelbase_mm', 'wheel_base_mm', 'wheelbase', 'wheel base'],
  interior_length_mm: [
    'interior_length_mm', 'cargo_length_mm', 'load_length_mm', 'luggage_length_mm',
    'max_cargo_length_mm', 'max_cargo_length_2_seat_mm', 'maximum_cargo_length_mm',
    'cargo floor length', 'cargo length', 'load length', 'luggage length'
  ],
  interior_width_mm: [
    'interior_width_mm', 'cargo_width_mm', 'load_width_mm', 'luggage_width_mm',
    'max_cargo_width_mm', 'maximum_cargo_width_mm', 'cargo width', 'load width', 'luggage width'
  ],
  interior_height_mm: [
    'interior_height_mm', 'cargo_height_mm', 'load_height_mm', 'luggage_height_mm',
    'max_cargo_height_mm', 'cargo height', 'load height', 'luggage height'
  ],
  side_door_width_mm: [
    'side_door_width_mm', 'side_door_opening_width_mm', 'side_sliding_door_opening_width_mm',
    'sliding_door_opening_width_mm', 'side sliding door opening width', 'side door opening width'
  ],
  side_door_height_mm: [
    'side_door_height_mm', 'side_door_opening_height_mm', 'side_sliding_door_opening_height_mm',
    'sliding_door_opening_height_mm', 'side sliding door opening height', 'side door opening height'
  ],
  rear_door_width_mm: [
    'rear_door_width_mm', 'rear_door_opening_width_mm', 'back_door_opening_width_mm',
    'tailgate_opening_width_mm', 'rear door opening width'
  ],
  rear_door_height_mm: [
    'rear_door_height_mm', 'rear_door_opening_height_mm', 'back_door_opening_height_mm',
    'tailgate_opening_height_mm', 'rear door opening height'
  ],
  rear_window_width_mm: ['rear_window_width_mm', 'back_window_width_mm', 'tailgate_window_width_mm', 'rear window width'],
  rear_window_height_mm: ['rear_window_height_mm', 'back_window_height_mm', 'tailgate_window_height_mm', 'rear window height'],
  wheel_arch_width_mm: ['wheel_arch_width_mm', 'wheel_well_width_mm', 'wheelhouse_width_mm', 'wheel arch width'],
  wheel_arch_height_mm: ['wheel_arch_height_mm', 'wheel_well_height_mm', 'wheelhouse_height_mm', 'wheel arch height'],
  wheel_arch_position_x_mm: ['wheel_arch_position_x_mm', 'wheel_arch_x_mm', 'wheelhouse_position_x_mm'],
  wheel_arch_position_y_mm: ['wheel_arch_position_y_mm', 'wheel_arch_y_mm', 'wheelhouse_position_y_mm'],
  payload_kg: ['payload_kg', 'payload', 'max_payload_kg', 'maximum_payload_kg', 'cargo_payload_kg']
};
const VEHICLE_ALIAS_LOOKUP = Object.entries(VEHICLE_FIELD_ALIASES).reduce((acc, [field, aliases]) => {
  aliases.forEach(alias => {
    acc[normalizeSourceFieldName(alias)] = field;
  });
  return acc;
}, {});

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeDrivePath(value) {
  return clean(value).split('/').map(part => clean(part)).filter(Boolean).join('/');
}

function normalizeDrivePathSegments(segments = []) {
  return segments.map(part => clean(part)).filter(Boolean);
}

function designAiLog(event, details = {}) {
  if (!DESIGN_AI_DEBUG_LOGS) return;
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

function normalizeSourceFieldName(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(mm|millimeters?|kg|kilograms?|m|meters?|litres?|liters?|l)\b/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sourceFieldSegments(sourceField) {
  return clean(sourceField)
    .split(/[./>]+/)
    .map(segment => segment.replace(/\[[^\]]*\]/g, ''))
    .map(normalizeSourceFieldName)
    .filter(Boolean);
}

function vehicleFieldMatch(sourceField) {
  const segments = sourceFieldSegments(sourceField);
  const candidates = [
    normalizeSourceFieldName(sourceField),
    ...segments,
    segments.slice(-2).join('_'),
    segments.slice(-3).join('_')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (VEHICLE_NUMERIC_FIELDS.has(candidate) || VEHICLE_METADATA_FIELDS.has(candidate)) {
      return { field: candidate, confidence: 'HIGH', match_type: 'direct' };
    }
  }
  for (const candidate of candidates) {
    const field = VEHICLE_ALIAS_LOOKUP[candidate];
    if (field) return { field, confidence: 'MEDIUM', match_type: 'alias' };
  }
  return null;
}

function fileExtension(name) {
  const base = clean(name).toLowerCase().split('?')[0].split('#')[0];
  const index = base.lastIndexOf('.');
  return index >= 0 ? base.slice(index) : '';
}

function pathParts(file) {
  return normalizeDrivePath(file.path || file.name).split('/').filter(Boolean);
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
  if (clean(file.folder_type).toLowerCase() === 'vehicles' && isTopdownBaseImage(file)) return true;
  if (clean(file.folder_type).toLowerCase() === 'vehicles' && classifyDesignLibraryFile(file).detected_type !== 'unclassified') return true;
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
  const vehicleMatch = folderType === 'vehicles' ? classifyDesignLibraryFile(file) : null;
  if (vehicleMatch && ['dimensions_csv', 'layout_constraints', 'vehicle_record'].includes(vehicleMatch.key)) return true;
  if (folderType === 'vehicles' && (isTopdownBaseImage(file) || ['dimensions.csv', 'floorplan.svg', 'mounting_points.csv', 'restricted_zones.csv', 'scan.glb'].includes(canonical))) {
    return true;
  }
  if (folderType === 'products' && ['dimensions.csv', 'footprint.svg', 'installation_rules.json'].includes(canonical)) {
    return true;
  }
  return DIMENSION_LIKE_NAME_PARTS.some(part => haystack.includes(part));
}

function fileSimpleName(file) {
  const name = fileCanonicalName(file).replace(/\.[^.]+$/, '');
  return name.replace(/[^a-z0-9]+/g, '');
}

function normalizedVehicleId(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isTopdownBaseImage(file, vehicleId = '') {
  if (isDriveFolder(file)) return false;
  const extension = fileExtension(file.name || file.path);
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) return false;
  const name = fileCanonicalName(file);
  const simple = fileSimpleName(file);
  const id = normalizedVehicleId(vehicleId || entityNameForFile(file));
  if (VEHICLE_TOPDOWN_BASE_NAMES.includes(name)) return true;
  if (['topdownbase', 'topdown', 'vehicletopdownbase'].includes(simple)) return true;
  return Boolean(id && simple === `${id}topdownbase`);
}

function designLibraryFileStatus(file) {
  return clean(file.file_status || 'active');
}

function isActiveDesignLibraryFile(file) {
  return !['ignored', 'archived', 'reset_pending'].includes(designLibraryFileStatus(file));
}

function vehicleResearchCandidate(file, key, matchType, extra = {}) {
  const type = VEHICLE_RESEARCH_TYPES[key];
  const role = clean(file.extraction_role || '');
  const baseRank = VEHICLE_RESEARCH_MATCH_RANK[matchType] || 999;
  return {
    id: file.id || null,
    key,
    label: type.label,
    detected_type: extra.detected_type || type.detected_type,
    match_type: matchType,
    match_label: matchType.replace(/_/g, ' '),
    rank: role === 'primary' ? 1 : baseRank,
    current_role: role === 'primary' ? 'primary' : '',
    file_status: designLibraryFileStatus(file),
    extraction_role: role,
    name: clean(file.name),
    path: filePath(file),
    drive_file_id: clean(file.drive_file_id),
    web_view_link: clean(file.web_view_link),
    modified_time: clean(file.modified_time),
    file
  };
}

function pathMatchesPreferred(file, preferredPath) {
  const pathValue = filePath(file).toLowerCase();
  const preferred = clean(preferredPath).toLowerCase();
  return pathValue === preferred || pathValue.endsWith(`/${preferred}`);
}

function vehicleResearchFilenameCandidates(file) {
  if (isDriveFolder(file)) return [];
  const out = [];
  const name = fileCanonicalName(file);
  const simple = fileSimpleName(file);
  const extension = fileExtension(file.name || file.path);
  Object.entries(VEHICLE_RESEARCH_TYPES).forEach(([key, type]) => {
    if ((type.preferred || []).some(preferred => pathMatchesPreferred(file, preferred))) {
      out.push(vehicleResearchCandidate(file, key, 'exact_preferred'));
    } else if ((type.exactNames || []).includes(name)) {
      out.push(vehicleResearchCandidate(file, key, 'exact_filename'));
    }
  });
  if (extension === '.json') {
    if (simple.endsWith('vehiclerecord') || simple.startsWith('vehiclerecord') || simple.includes('vehiclerecord')) {
      out.push(vehicleResearchCandidate(file, 'vehicle_record', 'fallback_pattern'));
    }
    if (simple.includes('layoutconstraints') || name === 'buildability.json') {
      out.push(vehicleResearchCandidate(file, 'layout_constraints', 'fallback_pattern'));
    }
    if (simple.endsWith('manifest') || simple.includes('manifest')) {
      out.push(vehicleResearchCandidate(file, 'manifest', 'fallback_pattern'));
    }
  }
  if (extension === '.csv') {
    if (simple.endsWith('vehiclerecord') || simple.startsWith('vehiclerecord') || simple.includes('vehiclerecord')) {
      out.push(vehicleResearchCandidate(file, 'dimensions_csv', 'fallback_pattern'));
    }
  }
  if (extension === '.md') {
    if (['buildability', 'buildabilityreport', 'geometry', 'layout'].includes(simple) || simple.includes('buildabilityreport')) {
      out.push(vehicleResearchCandidate(file, 'buildability_report', 'fallback_pattern'));
    }
  }
  if (['.pdf', '.png', '.jpg', '.jpeg'].includes(extension)) {
    if (simple.includes('vehiclescansheet') || simple.startsWith('knowledgesheet') || simple.startsWith('scansheet')) {
      out.push(vehicleResearchCandidate(file, 'knowledge_sheet', 'fallback_pattern'));
    }
  }
  return out;
}

function contentMapValue(contentByFile, file) {
  if (!contentByFile) return undefined;
  const keys = [
    clean(file.drive_file_id),
    filePath(file),
    clean(file.name)
  ].filter(Boolean);
  for (const key of keys) {
    if (contentByFile instanceof Map && contentByFile.has(key)) return contentByFile.get(key);
    if (!(contentByFile instanceof Map) && Object.prototype.hasOwnProperty.call(contentByFile, key)) return contentByFile[key];
  }
  return undefined;
}

function jsonObject(content) {
  try {
    const parsed = JSON.parse(clean(content));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

function collectJsonKeys(value, keys = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return keys;
  Object.entries(value).forEach(([key, item]) => {
    keys.add(normalizeSourceFieldName(key));
    if (item && typeof item === 'object') collectJsonKeys(item, keys, depth + 1);
  });
  return keys;
}

function isVehicleRecordJson(content) {
  const parsed = jsonObject(content);
  if (!parsed) return false;
  const keys = collectJsonKeys(parsed);
  const vehicleFields = [...VEHICLE_NUMERIC_FIELDS].filter(field => keys.has(field));
  const hasVehicleId = keys.has('vehicle_id') || keys.has('vehicleid') || clean(parsed.vehicle_id);
  const hasIdentity = hasVehicleId || keys.has('make') || keys.has('model') || keys.has('brand');
  return Boolean((hasVehicleId && vehicleFields.length) || (hasIdentity && vehicleFields.length >= 2));
}

function isLayoutConstraintsJson(content) {
  const parsed = jsonObject(content);
  if (!parsed) return false;
  const input = parsed.layout_constraints_json || parsed.layout_constraints || parsed;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const flatBuildKeys = [
    'build_origin_x_mm',
    'build_origin_y_mm',
    'buildable_length_mm',
    'buildable_width_mm',
    'buildable_height_mm',
    'front_clearance_mm',
    'rear_clearance_mm',
    'left_clearance_mm',
    'right_clearance_mm',
    'minimum_walkway_mm'
  ];
  return Boolean(
    input.build_area ||
    input.clearance ||
    input.restricted_zones ||
    input.mounting_points ||
    (input.schema_version && input.metadata) ||
    flatBuildKeys.some(key => input[key] !== undefined)
  );
}

function isManifestJson(content) {
  const parsed = jsonObject(content);
  if (!parsed) return false;
  return Boolean(parsed.package_version || parsed.required_files || parsed.generated_by);
}

function isDimensionsCsv(content) {
  const rows = parseCsvRows(content);
  if (!rows.length) return false;
  const headers = (rows[0] || []).map(normalizeSourceFieldName);
  const headerSet = new Set(headers);
  const hasDimensionTableHeaders = headerSet.has('field') && (
    headerSet.has('value') ||
    headerSet.has('value_mm') ||
    headerSet.has('unit') ||
    headerSet.has('confidence')
  );
  const body = rows.slice(0, 80).flat().map(normalizeSourceFieldName);
  const dimensionHits = body.filter(cell => VEHICLE_NUMERIC_FIELDS.has(cell)).length;
  return hasDimensionTableHeaders || dimensionHits > 0;
}

function vehicleResearchContentCandidates(file, content) {
  if (content === undefined || content === null || isDriveFolder(file)) return [];
  const extension = fileExtension(file.name || file.path);
  const out = [];
  if (extension === '.json') {
    if (isLayoutConstraintsJson(content)) out.push(vehicleResearchCandidate(file, 'layout_constraints', 'content'));
    if (isVehicleRecordJson(content)) out.push(vehicleResearchCandidate(file, 'vehicle_record', 'content'));
    if (isManifestJson(content)) out.push(vehicleResearchCandidate(file, 'manifest', 'content'));
  }
  if (extension === '.csv' && isDimensionsCsv(content)) {
    out.push(vehicleResearchCandidate(file, 'dimensions_csv', 'content'));
  }
  return out;
}

function classifyDesignLibraryFile(file, content) {
  const candidates = [
    ...vehicleResearchFilenameCandidates(file),
    ...vehicleResearchContentCandidates(file, content)
  ].sort(compareVehicleResearchCandidates);
  return candidates[0] || {
    key: '',
    label: '',
    detected_type: 'unclassified',
    match_type: '',
    match_label: '',
    rank: 999,
    name: clean(file.name),
    path: filePath(file),
    drive_file_id: clean(file.drive_file_id),
    web_view_link: clean(file.web_view_link),
    modified_time: clean(file.modified_time),
    file
  };
}

function compareVehicleResearchCandidates(a, b) {
  const primaryRank = candidate => candidate.extraction_role === 'primary' ? 0 : 1;
  const activeRank = candidate => isActiveDesignLibraryFile(candidate) ? 0 : 1;
  const exactRank = candidate => candidate.match_type === 'exact_filename' ? 0 : candidate.match_type === 'exact_preferred' ? -1 : 1;
  return primaryRank(a) - primaryRank(b) ||
    activeRank(a) - activeRank(b) ||
    clean(b.modified_time).localeCompare(clean(a.modified_time)) ||
    exactRank(a) - exactRank(b) ||
    a.rank - b.rank ||
    normalizeDrivePath(a.path).localeCompare(normalizeDrivePath(b.path));
}

function dedupeVehicleResearchCandidates(candidates = []) {
  const byIdentity = new Map();
  candidates.forEach(candidate => {
    const identity = clean(candidate.drive_file_id) || normalizeDrivePath(candidate.path).toLowerCase();
    if (!identity) return;
    const current = byIdentity.get(identity);
    if (!current || compareVehicleResearchCandidates(candidate, current) < 0) {
      byIdentity.set(identity, candidate);
    }
  });
  return Array.from(byIdentity.values()).sort(compareVehicleResearchCandidates);
}

function duplicateVehicleResearchMessage(type, selected, candidates) {
  const others = candidates.filter(candidate => candidate !== selected);
  const selectedLabel = fileExtension(selected?.name) ? `${fileExtension(selected.name).replace('.', '').toUpperCase()} selected` : `${selected?.name || 'file'} selected`;
  const duplicateLabels = [...new Set(others.map(candidate => {
    const ext = fileExtension(candidate.name).replace('.', '').toUpperCase();
    return ext || candidate.name || 'file';
  }).filter(Boolean))];
  const duplicateText = duplicateLabels.length ? `${duplicateLabels.join('/')} marked duplicate` : 'older files marked duplicate';
  return `Multiple ${type.label.toLowerCase()} found: ${selectedLabel}, ${duplicateText}.`;
}

function samePriorityCandidateCount(candidates = [], selected) {
  if (!selected) return 0;
  return candidates.filter(candidate => (
    candidate.rank === selected.rank &&
    candidate.extraction_role === selected.extraction_role &&
    designLibraryFileStatus(candidate) === designLibraryFileStatus(selected)
  )).length;
}

function sanitizeVehicleResearchDuplicateFile(candidate, selected) {
  const isSelected = clean(candidate.drive_file_id) && clean(candidate.drive_file_id) === clean(selected.drive_file_id)
    ? true
    : normalizeDrivePath(candidate.path) === normalizeDrivePath(selected.path);
  return {
    id: candidate.id || null,
    name: candidate.name,
    path: candidate.path,
    modified_time: candidate.modified_time,
    current_role: isSelected ? 'primary' : 'duplicate',
    file_status: candidate.file_status || 'active',
    match_type: candidate.match_type,
    web_view_link: candidate.web_view_link
  };
}

function sanitizeVehicleResearchStatus(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id || null,
    key: candidate.key,
    label: candidate.label,
    found: true,
    detected_type: candidate.detected_type,
    original_filename: candidate.name,
    path: candidate.path,
    match_type: candidate.match_type,
    match_label: candidate.match_label,
    current_role: candidate.current_role || 'primary',
    file_status: candidate.file_status || 'active',
    extraction_role: candidate.extraction_role || '',
    modified_time: candidate.modified_time,
    web_view_link: candidate.web_view_link,
    candidate_count: candidate.candidate_count || 1,
    same_priority_count: candidate.same_priority_count || 1
  };
}

function findVehicleResearchFiles(files = [], vehicleId = '', contentByFile = null) {
  const candidatesByType = {};
  VEHICLE_RESEARCH_ORDER.forEach(key => {
    candidatesByType[key] = [];
  });
  files.filter(file => clean(file.folder_type || 'vehicles').toLowerCase() === 'vehicles' && !isDriveFolder(file) && isActiveDesignLibraryFile(file)).forEach(file => {
    const candidates = [
      ...vehicleResearchFilenameCandidates(file),
      ...vehicleResearchContentCandidates(file, contentMapValue(contentByFile, file))
    ];
    candidates.forEach(candidate => {
      candidatesByType[candidate.key].push(candidate);
    });
  });

  const items = {};
  const warnings = [];
  const duplicates = [];
  const statuses = VEHICLE_RESEARCH_ORDER.map(key => {
    const type = VEHICLE_RESEARCH_TYPES[key];
    const candidates = dedupeVehicleResearchCandidates(candidatesByType[key] || []);
    const selected = candidates[0] || null;
    if (!selected) {
      return {
        key,
        label: type.label,
        found: false,
        detected_type: type.detected_type,
        original_filename: '',
        path: '',
        match_type: '',
        match_label: '',
        modified_time: '',
        web_view_link: '',
        candidate_count: 0,
        same_priority_count: 0
      };
    }
    const samePriority = samePriorityCandidateCount(candidates, selected);
    selected.candidate_count = candidates.length;
    selected.same_priority_count = samePriority;
    items[key] = selected;
    if (candidates.length > 1) {
      warnings.push(duplicateVehicleResearchMessage(type, selected, candidates));
      duplicates.push({
        key,
        label: type.label,
        message: duplicateVehicleResearchMessage(type, selected, candidates),
        files: candidates.map(candidate => sanitizeVehicleResearchDuplicateFile(candidate, selected))
      });
    }
    return sanitizeVehicleResearchStatus(selected);
  });

  return {
    vehicle_id: clean(vehicleId),
    items,
    statuses,
    duplicates,
    warnings
  };
}

async function normalizeVehicleResearchFileCandidates(files = [], vehicleId = '') {
  const readable = files
    .filter(file => clean(file.folder_type || 'vehicles').toLowerCase() === 'vehicles')
    .filter(file => !isDriveFolder(file))
    .filter(isActiveDesignLibraryFile)
    .filter(file => ['.json', '.csv'].includes(fileExtension(file.name || file.path)))
    .sort((a, b) => clean(b.modified_time).localeCompare(clean(a.modified_time)))
    .slice(0, 40);
  const contentByFile = new Map();
  const warnings = [];
  if (readable.length) {
    let drive = null;
    try {
      drive = requireDriveClient();
    } catch (err) {
      warnings.push(`Content-based vehicle file detection skipped: ${err.message}`);
    }
    if (drive) {
      for (const file of readable) {
        try {
          const result = await readDriveTextFile(drive, file, MAX_TEXT_FILE_BYTES);
          if (result.skipped) {
            warnings.push(`${filePath(file)} skipped for content detection: ${result.reason}`);
            continue;
          }
          contentByFile.set(clean(file.drive_file_id), result.content);
          contentByFile.set(filePath(file), result.content);
        } catch (err) {
          warnings.push(`${filePath(file)} content detection failed: ${err.message}`);
        }
      }
    }
  }
  const research = findVehicleResearchFiles(files, vehicleId, contentByFile);
  research.warnings = [...warnings, ...research.warnings];
  return research;
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
    const topdownBase = group.folder_type === 'vehicles'
      ? group.files.find(file => isTopdownBaseImage(file, group.entity))
      : null;
    if (topdownBase) {
      group.topdown_base_file = filePath(topdownBase);
      group.topdown_base_drive_file_id = clean(topdownBase.drive_file_id);
    }
    const vehicleResearch = group.folder_type === 'vehicles'
      ? findVehicleResearchFiles(group.files, group.entity)
      : null;
    if (vehicleResearch) {
      group.vehicle_research_files = vehicleResearch.statuses;
      group.vehicle_research_warnings = vehicleResearch.warnings;
      group.required_present = [
        vehicleResearch.items.vehicle_record ? 'vehicle.json' : '',
        vehicleResearch.items.dimensions_csv ? 'dimensions.csv' : '',
        topdownBase ? 'topdown_base.png' : ''
      ].filter(Boolean);
      group.required_missing = [
        vehicleResearch.items.vehicle_record ? '' : 'vehicle.json',
        vehicleResearch.items.dimensions_csv ? '' : 'dimensions.csv',
        topdownBase ? '' : 'topdown_base.png'
      ].filter(Boolean);
      group.optional_present = optional.filter(name => present.has(name));
      if (vehicleResearch.items.layout_constraints && !group.optional_present.includes('layout_constraints.json')) group.optional_present.push('layout_constraints.json');
      if (vehicleResearch.items.buildability_report && !group.optional_present.includes('buildability_report.md')) group.optional_present.push('buildability_report.md');
      if (vehicleResearch.items.manifest && !group.optional_present.includes('manifest.json')) group.optional_present.push('manifest.json');
      if (vehicleResearch.items.knowledge_sheet && !group.optional_present.includes('vehicle_knowledge_sheet.pdf')) group.optional_present.push('vehicle_knowledge_sheet.pdf');
      group.optional_missing = optional.filter(name => !group.optional_present.includes(name));
    } else {
      group.required_present = required.filter(name => present.has(name));
      group.required_missing = required.filter(name => !present.has(name));
      group.optional_present = optional.filter(name => present.has(name));
      group.optional_missing = optional.filter(name => !present.has(name));
    }
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
      const currentPath = normalizeDrivePathSegments([...parentPath, file.name || 'Untitled']);
      files.push({
        drive_file_id: file.id,
        folder_type: folderType,
        name: file.name || '',
        path: normalizeDrivePath(currentPath.join('/')),
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
    id: file.id || null,
    drive_file_id: file.drive_file_id || '',
    folder_type: file.folder_type,
    entity: entityNameForFile(file),
    name: file.name,
    path: filePath(file),
    mime_type: file.mime_type,
    modified_time: file.modified_time,
    size: file.size,
    is_folder: Boolean(Number(file.is_folder)),
    file_status: clean(file.file_status || 'active'),
    extraction_role: clean(file.extraction_role || '')
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

async function readDesignLibraryTextFile(file, maxBytes = MAX_TEXT_FILE_BYTES) {
  if (!isTextReadableFile(file)) {
    const err = new Error('File is not a readable text library file.');
    err.status = 400;
    throw err;
  }
  const drive = requireDriveClient();
  return readDriveTextFile(drive, file, maxBytes);
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

function isScalarSourceValue(value) {
  return value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value);
}

function compactSourceValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return clean(value).replace(/\s+/g, ' ').slice(0, 240);
}

function extractNumberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = clean(value).replace(/,/g, '');
  if (!raw) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;
  if (/\bcm\b/i.test(raw)) return parsed * 10;
  if (/\bm\b/i.test(raw) && !/\bmm\b/i.test(raw) && Math.abs(parsed) < 100) return parsed * 1000;
  return parsed;
}

function normalizeVehicleValue(field, value) {
  if (VEHICLE_NUMERIC_FIELDS.has(field)) return extractNumberValue(value);
  const out = compactSourceValue(value);
  return out === '' ? null : out;
}

function addSourceCandidate(candidates, candidate) {
  if (!candidate || !clean(candidate.source_field) || !isScalarSourceValue(candidate.value)) return;
  const value = compactSourceValue(candidate.value);
  if (value === '') return;
  candidates.push({
    source_file: clean(candidate.source_file),
    source_field: clean(candidate.source_field),
    value,
    parser: clean(candidate.parser)
  });
}

function flattenJsonSource(value, sourceFile, path = [], candidates = []) {
  const root = clean(path[0]);
  if (['field_confidence', 'source_evidence', '_field_sources', '_unmapped_source_data', '_measurement_required', '_content_warnings'].includes(root)) {
    return candidates;
  }
  if (isScalarSourceValue(value)) {
    addSourceCandidate(candidates, {
      source_file: sourceFile,
      source_field: path.join('.'),
      value,
      parser: 'json'
    });
    return candidates;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJsonSource(item, sourceFile, [...path, `[${index}]`], candidates));
    return candidates;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => flattenJsonSource(item, sourceFile, [...path, key], candidates));
  }
  return candidates;
}

function parseCsvRows(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const raw = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(clean(cell));
      cell = '';
    } else if (char === '\n') {
      row.push(clean(cell));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(clean(cell));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function csvColumnIndex(headers, names) {
  const normalizedNames = names.map(normalizeSourceFieldName);
  return headers.findIndex(header => normalizedNames.includes(normalizeSourceFieldName(header)));
}

function csvCandidates(content, sourceFile) {
  const rows = parseCsvRows(content);
  const candidates = [];
  if (!rows.length) return candidates;
  const headers = rows[0] || [];
  const valueRows = rows.slice(1, 20);
  const labelColumn = csvColumnIndex(headers, ['field', 'key', 'dimension', 'measurement', 'spec', 'item', 'name']);
  const valueColumn = csvColumnIndex(headers, ['value', 'mm', 'dimension_mm', 'measurement_mm', 'size', 'specification']);
  const hasDimensionTable = labelColumn >= 0 && valueColumn >= 0 && labelColumn !== valueColumn;
  valueRows.forEach((row, index) => {
    if (row.length >= 2) {
      addSourceCandidate(candidates, {
        source_file: sourceFile,
        source_field: row[0],
        value: row[1],
        parser: `csv_row_${index + 2}`
      });
    }
  });
  if (!hasDimensionTable) {
    valueRows.forEach((row, rowIndex) => {
      headers.forEach((header, colIndex) => {
        if (!clean(header) || row[colIndex] === undefined || row[colIndex] === '') return;
        addSourceCandidate(candidates, {
          source_file: sourceFile,
          source_field: header,
          value: row[colIndex],
          parser: `csv_column_${rowIndex + 2}`
        });
      });
    });
  }
  if (hasDimensionTable) {
    valueRows.forEach((row, rowIndex) => {
      addSourceCandidate(candidates, {
        source_file: sourceFile,
        source_field: row[labelColumn],
        value: row[valueColumn],
        parser: `csv_dimension_table_${rowIndex + 2}`
      });
    });
  }
  return candidates;
}

function textCandidates(content, sourceFile, parser = 'text') {
  const candidates = [];
  String(content || '').split(/\n/).slice(0, 800).forEach((line, index) => {
    const trimmed = clean(line.replace(/<[^>]+>/g, ' '));
    if (!trimmed || trimmed.length > 260) return;
    let match = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9 _./()%-]{2,90})\s*[:=]\s*(.+)$/);
    if (!match) match = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9 _./()%-]{2,90})\s{2,}(.+)$/);
    if (!match) match = trimmed.match(/^([A-Za-z][A-Za-z _./()%-]{2,80})\s+(-?\d[\d,.]*(?:\s*(?:mm|cm|m|kg|l))?)$/i);
    if (!match) return;
    addSourceCandidate(candidates, {
      source_file: sourceFile,
      source_field: match[1],
      value: match[2],
      parser: `${parser}_line_${index + 1}`
    });
  });
  return candidates;
}

function sourceCandidatesFromReadableFile(file) {
  const sourceFile = clean(file.path || file.name || 'readable content');
  const extension = fileExtension(file.name || file.path);
  const content = file.content || '';
  if (extension === '.json') {
    try {
      return flattenJsonSource(JSON.parse(content), sourceFile);
    } catch (err) {
      return textCandidates(content, sourceFile, 'json_text');
    }
  }
  if (extension === '.csv') return csvCandidates(content, sourceFile);
  if (extension === '.svg') return textCandidates(content, sourceFile, 'svg_text');
  return textCandidates(content, sourceFile);
}

function dedupeSourceCandidates(candidates, limit = 160) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = `${candidate.source_file}|${candidate.source_field}|${candidate.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}

function discoveredSourceCandidates(parsed, evidence) {
  const candidates = [];
  (evidence?.readable_file_contents || []).forEach(file => {
    candidates.push(...sourceCandidatesFromReadableFile(file));
  });
  if (parsed && typeof parsed === 'object') {
    candidates.push(...flattenJsonSource(parsed, 'OpenAI response'));
  }
  return dedupeSourceCandidates(candidates);
}

function confidenceRank(confidence) {
  const value = clean(confidence).toUpperCase();
  if (value === 'HIGH') return 3;
  if (value === 'MEDIUM') return 2;
  if (value === 'LOW') return 1;
  const numeric = Number(confidence);
  return Number.isFinite(numeric) ? numeric * 3 : 0;
}

function sourceSummaryForField(candidate, match, value) {
  const unit = match.field === 'payload_kg' ? 'kg' : VEHICLE_NUMERIC_FIELDS.has(match.field) ? 'mm' : '';
  return {
    value,
    unit,
    confidence: match.confidence,
    source_file: candidate.source_file,
    original_source_field: candidate.source_field,
    match_type: match.match_type,
    method: match.match_type === 'direct' ? 'exact' : match.match_type === 'alias' ? 'inferred' : 'estimated',
    notes: candidate.parser || ''
  };
}

function sourceCandidateNames(candidate) {
  const segments = sourceFieldSegments(candidate.source_field);
  return [
    normalizeSourceFieldName(candidate.source_field),
    ...segments,
    segments.slice(-2).join('_'),
    segments.slice(-3).join('_')
  ].filter(Boolean);
}

function layoutSourcePriority(candidate) {
  const path = normalizeDrivePath(candidate.source_file).toLowerCase();
  if (path.endsWith('layout_constraints.json')) return 0;
  if (path.endsWith('vehicle_record.json') || path.endsWith('vehicle.json')) return 1;
  if (path.endsWith('dimensions.csv')) return 2;
  if (path.endsWith('manifest.json')) return 3;
  if (path.endsWith('buildability_report.md')) return 4;
  if (path === 'openai response') return 5;
  return 8;
}

function compareLayoutSourceCandidates(a, b) {
  return layoutSourcePriority(a) - layoutSourcePriority(b) ||
    normalizeDrivePath(a.source_file).localeCompare(normalizeDrivePath(b.source_file)) ||
    clean(a.source_field).localeCompare(clean(b.source_field));
}

function layoutCandidateForAliases(candidates, aliases) {
  const aliasSet = new Set(aliases.map(normalizeSourceFieldName).filter(Boolean));
  return candidates
    .filter(candidate => sourceCandidateNames(candidate).some(name => aliasSet.has(name)))
    .sort(compareLayoutSourceCandidates)[0] || null;
}

function layoutNumberFromSources(candidates, aliases) {
  const candidate = layoutCandidateForAliases(candidates, aliases);
  if (!candidate) return null;
  const value = extractNumberValue(candidate.value);
  if (value === null) return null;
  const priority = layoutSourcePriority(candidate);
  return {
    value,
    source_file: candidate.source_file,
    source_field: candidate.source_field,
    method: priority <= 2 ? 'exact' : priority <= 4 ? 'inferred' : 'estimated',
    confidence: priority <= 2 ? 'HIGH' : 'MEDIUM',
    notes: candidate.parser || ''
  };
}

function layoutTextFromSources(candidates, aliases) {
  const candidate = layoutCandidateForAliases(candidates, aliases);
  if (!candidate) return '';
  return clean(candidate.value);
}

function layoutConstraintObjects(parsed, evidence) {
  const out = [];
  const addInput = (input, file) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const target = input.layout_constraints_json || input.layout_constraints || input;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return;
    if (!isLayoutConstraintsJson(JSON.stringify(target))) return;
    out.push({ input: target, file });
  };
  addInput(parsed, { name: 'OpenAI response', path: 'OpenAI response', modified_time: '' });
  (evidence?.readable_file_contents || []).forEach(file => {
    if (fileExtension(file.name || file.path) !== '.json') return;
    try {
      addInput(JSON.parse(file.content || '{}'), file);
    } catch (err) {
      // Non-JSON text has already been handled by source candidate parsing.
    }
  });
  return out.sort((a, b) => {
    const aCandidate = { source_file: a.file?.path || a.file?.name || '' };
    const bCandidate = { source_file: b.file?.path || b.file?.name || '' };
    return layoutSourcePriority(aCandidate) - layoutSourcePriority(bCandidate);
  });
}

function normalizeLayoutZoneForExtraction(zone = {}) {
  return {
    name: clean(zone.name || zone.zone_name || zone.zone || zone.id || 'Restricted Zone'),
    type: clean(zone.type || 'restricted'),
    x_mm: extractNumberValue(zone.x_mm ?? zone.x ?? zone.left_mm ?? zone.origin_x_mm),
    y_mm: extractNumberValue(zone.y_mm ?? zone.y ?? zone.top_mm ?? zone.origin_y_mm),
    length_mm: extractNumberValue(zone.length_mm ?? zone.length ?? zone.l_mm),
    width_mm: extractNumberValue(zone.width_mm ?? zone.width ?? zone.depth_mm ?? zone.depth ?? zone.w_mm),
    notes: clean(zone.notes || zone.reason || zone.description || zone.note)
  };
}

function restrictedZonesFromLayoutInput(input = {}) {
  const zones = input.restricted_zones || input.restrictedZones || input.no_go_zones || input.keep_clear_zones || [];
  return Array.isArray(zones) ? zones.map(normalizeLayoutZoneForExtraction).filter(zone => (
    zone.name || zone.x_mm !== null || zone.y_mm !== null || zone.length_mm !== null || zone.width_mm !== null
  )) : [];
}

function mountingPointsFromLayoutInput(input = {}) {
  return Array.isArray(input.mounting_points || input.mountingPoints)
    ? (input.mounting_points || input.mountingPoints)
    : [];
}

function layoutObjectMetadata(objects) {
  const first = objects[0];
  const input = first?.input || {};
  const metadata = input.metadata || {};
  return {
    status: clean(metadata.approval_status || metadata.status || input.approval_status || input.status || 'ai_suggested'),
    confidence: clean(metadata.confidence || input.confidence || 'MEDIUM').toUpperCase() || 'MEDIUM',
    source_file: clean(metadata.source_file || metadata.derived_from || input.derived_from || first?.file?.name || ''),
    source_path: clean(metadata.source_path || first?.file?.path || ''),
    generated_at: clean(metadata.generated_at || metadata.generated_date || metadata.created_at || first?.file?.modified_time || ''),
    notes: clean(metadata.notes || metadata.layout_notes || input.layout_notes || input.notes),
    warnings: Array.isArray(metadata.warnings || input.warnings) ? (metadata.warnings || input.warnings).map(clean).filter(Boolean) : []
  };
}

function detailForLayoutValue(field, value, source, unit = 'mm') {
  if (!source || value === null || value === undefined || value === '') return null;
  return {
    value,
    unit,
    source_file: source.source_file || '',
    source_field: source.source_field || '',
    method: source.method || 'exact',
    confidence: source.confidence || 'MEDIUM',
    notes: source.notes || ''
  };
}

function setLayoutField(target, path, fieldKey, source, details) {
  if (!source || source.value === null || source.value === undefined) return false;
  target[path[0]][path[1]] = source.value;
  details[fieldKey] = detailForLayoutValue(fieldKey, source.value, source);
  return true;
}

function estimateLayoutValue(target, path, fieldKey, value, details, estimatedFields, notes, confidence = 'MEDIUM') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return false;
  if (target[path[0]][path[1]] !== null && target[path[0]][path[1]] !== undefined && target[path[0]][path[1]] !== '') return false;
  const rounded = Math.max(0, Math.round(Number(value)));
  target[path[0]][path[1]] = rounded;
  details[fieldKey] = detailForLayoutValue(fieldKey, rounded, {
    source_file: 'CRDN deterministic estimate',
    source_field: fieldKey,
    method: 'estimated',
    confidence,
    notes
  });
  estimatedFields.push(fieldKey);
  return true;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const numeric = extractNumberValue(value);
    if (numeric !== null && numeric > 0) return numeric;
  }
  return null;
}

function firstLayoutSource(details = {}) {
  return Object.values(details).find(detail => detail?.source_file)?.source_file || '';
}

function topdownBaseFileFromEvidence(evidence, vehicleId = '') {
  return (evidence?.source_files || []).find(file => isTopdownBaseImage(file, vehicleId)) || null;
}

function fileSourceMatch(files = [], matcher) {
  return files.find(file => matcher(filePath(file).toLowerCase(), clean(file.name).toLowerCase())) || null;
}

function vehicleReadinessSummary(normalized, layout, evidence, estimatedFields) {
  const files = evidence?.source_files || [];
  const layoutDetails = layout?.metadata?.field_details || {};
  const vehicleRecordFile = fileSourceMatch(files, (path, name) => path.endsWith('vehicle_record.json') || path.endsWith('vehicle.json') || name === 'vehicle_record.json' || name === 'vehicle.json');
  const dimensionsFile = fileSourceMatch(files, (path, name) => path.endsWith('dimensions.csv') || name === 'dimensions.csv');
  const floorplanFile = fileSourceMatch(files, (path, name) => path.endsWith('floorplan.svg') || name === 'floorplan.svg' || (name.endsWith('.svg') && name.includes('floorplan')));
  const buildabilityFile = fileSourceMatch(files, (path, name) => path.endsWith('buildability_report.md') || name === 'buildability_report.md');
  const topdownFile = topdownBaseFileFromEvidence(evidence, normalized.vehicle_id);
  const hasVehicleRecord = Boolean(vehicleRecordFile || normalized.make || normalized.model || normalized.brand);
  const hasDimensions = Boolean(
    (normalized.interior_length_mm && normalized.interior_width_mm) ||
    (normalized.overall_length_mm && normalized.overall_width_mm)
  );
  const buildArea = layout?.build_area || {};
  const hasBuildArea = Boolean(buildArea.length_mm && buildArea.width_mm);
  const hasRestrictedZones = Array.isArray(layout?.restricted_zones) && layout.restricted_zones.length > 0;
  const hasWheelArch = Boolean(normalized.wheel_arch_width_mm || normalized.wheel_arch_height_mm);
  const hasDoorOpenings = Boolean(normalized.side_door_width_mm || normalized.rear_door_width_mm || normalized.side_door_height_mm || normalized.rear_door_height_mm);
  const hasMountingPoints = Array.isArray(layout?.mounting_points) && layout.mounting_points.length > 0;
  const criticalMissing = [];
  if (!hasVehicleRecord) criticalMissing.push('Vehicle record');
  if (!hasDimensions) criticalMissing.push('Dimensions');
  if (!hasBuildArea) criticalMissing.push('Buildable area');
  if (!topdownFile) criticalMissing.push('Topdown base image');
  const warnings = [];
  if (!topdownFile) warnings.push('Topdown base image missing. Upload topdown_base.png to this vehicle folder.');
  const sourceForBuild = firstLayoutSource(layoutDetails) || layout?.metadata?.source_file || '';
  const required = [
    { key: 'vehicle_record', label: 'Vehicle record', status: hasVehicleRecord ? 'Found' : 'Missing', confidence: hasVehicleRecord ? 'HIGH' : 'LOW', source_file: vehicleRecordFile?.path || normalized._field_sources?.model?.source_file || normalized._field_sources?.make?.source_file || '' },
    { key: 'dimensions', label: 'Dimensions', status: hasDimensions ? 'Found' : 'Missing', confidence: hasDimensions ? 'HIGH' : 'LOW', source_file: dimensionsFile?.path || normalized._field_sources?.interior_length_mm?.source_file || normalized._field_sources?.overall_length_mm?.source_file || '' },
    { key: 'buildable_area', label: 'Buildable area', status: hasBuildArea ? (estimatedFields.some(field => field.startsWith('buildable_') || field.startsWith('build_origin_')) ? 'Estimated' : 'Found') : 'Missing', confidence: hasBuildArea ? (estimatedFields.length ? 'MEDIUM' : (layout?.metadata?.confidence || 'HIGH')) : 'LOW', source_file: sourceForBuild },
    { key: 'topdown_base', label: 'Topdown base image', status: topdownFile ? 'Found' : 'Missing', confidence: topdownFile ? 'HIGH' : 'LOW', source_file: topdownFile?.path || '' }
  ];
  const niceToHave = [
    { key: 'floorplan', label: 'Floorplan', status: floorplanFile ? 'Found' : 'Missing', confidence: floorplanFile ? 'HIGH' : 'LOW', source_file: floorplanFile?.path || '' },
    { key: 'wheel_arch', label: 'Wheel arch data', status: hasWheelArch ? 'Found' : 'Missing', confidence: hasWheelArch ? 'MEDIUM' : 'LOW', source_file: normalized._field_sources?.wheel_arch_width_mm?.source_file || normalized._field_sources?.wheel_arch_height_mm?.source_file || '' },
    { key: 'restricted_zones', label: 'Restricted zones', status: hasRestrictedZones ? 'Found' : 'Missing', confidence: hasRestrictedZones ? 'MEDIUM' : 'LOW', source_file: sourceForBuild },
    { key: 'door_openings', label: 'Door opening data', status: hasDoorOpenings ? 'Found' : 'Missing', confidence: hasDoorOpenings ? 'MEDIUM' : 'LOW', source_file: normalized._field_sources?.side_door_width_mm?.source_file || normalized._field_sources?.rear_door_width_mm?.source_file || '' },
    { key: 'mounting_points', label: 'Mounting points', status: hasMountingPoints ? 'Found' : 'Missing', confidence: hasMountingPoints ? 'MEDIUM' : 'LOW', source_file: sourceForBuild || buildabilityFile?.path || '' }
  ];
  const overallScore = Math.min(100,
    (hasVehicleRecord ? 20 : 0) +
    (hasDimensions ? 30 : 0) +
    (hasBuildArea ? 30 : 0) +
    (topdownFile ? 20 : 0)
  );
  const layoutReady = hasVehicleRecord && hasDimensions && hasBuildArea && Boolean(topdownFile);
  return {
    overall_score: overallScore,
    layout_ready: layoutReady,
    customer_proposal_ready: layoutReady,
    fabrication_ready: false,
    critical_missing: criticalMissing,
    estimated_fields: [...new Set(estimatedFields)],
    warnings,
    required,
    nice_to_have: niceToHave,
    topdown_base_image: topdownFile ? {
      drive_file_id: topdownFile.drive_file_id || '',
      name: topdownFile.name || '',
      path: topdownFile.path || ''
    } : null
  };
}

function normalizeVehicleLayoutConstraintsFromSources(parsed, normalized, candidates, evidence) {
  const objects = layoutConstraintObjects(parsed, evidence);
  const metadata = layoutObjectMetadata(objects);
  const details = {};
  const estimatedFields = [];
  const layout = {
    schema_version: 1,
    build_area: {
      x_mm: null,
      y_mm: null,
      length_mm: null,
      width_mm: null,
      height_mm: null
    },
    clearance: {
      front_mm: null,
      rear_mm: null,
      left_mm: null,
      right_mm: null,
      minimum_walkway_mm: null
    },
    restricted_zones: [],
    mounting_points: [],
    metadata: {
      ...metadata,
      coordinate_convention: 'Origin is the front-left of the usable cargo coordinate system. X increases toward the rear hatch/right side of the top-down layout, Y increases across vehicle width.',
      topdown_base_requirement: 'Upload topdown_base.png: top-down orthographic, front facing left, empty cargo floor, no labels or products.'
    }
  };

  const fieldAliases = {
    build_origin_x_mm: ['layout_constraints_json_build_area_x_mm', 'layout_constraints_build_area_x_mm', 'build_area_x_mm', 'buildable_area_x_mm', 'build_origin_x_mm', 'origin_x_mm'],
    build_origin_y_mm: ['layout_constraints_json_build_area_y_mm', 'layout_constraints_build_area_y_mm', 'build_area_y_mm', 'buildable_area_y_mm', 'build_origin_y_mm', 'origin_y_mm'],
    buildable_length_mm: ['layout_constraints_json_build_area_length_mm', 'layout_constraints_build_area_length_mm', 'build_area_length_mm', 'buildable_area_length_mm', 'buildable_length_mm', 'build_length_mm', 'cargo_floor_length_mm'],
    buildable_width_mm: ['layout_constraints_json_build_area_width_mm', 'layout_constraints_build_area_width_mm', 'build_area_width_mm', 'buildable_area_width_mm', 'buildable_width_mm', 'build_width_mm', 'cargo_floor_width_mm'],
    buildable_height_mm: ['layout_constraints_json_build_area_height_mm', 'layout_constraints_build_area_height_mm', 'build_area_height_mm', 'buildable_area_height_mm', 'buildable_height_mm', 'build_height_mm', 'cargo_floor_height_mm'],
    front_clearance_mm: ['layout_constraints_json_clearance_front_mm', 'layout_constraints_clearance_front_mm', 'clearance_front_mm', 'front_clearance_mm', 'front_seat_clearance_mm', 'front_seat_mm'],
    rear_clearance_mm: ['layout_constraints_json_clearance_rear_mm', 'layout_constraints_clearance_rear_mm', 'clearance_rear_mm', 'rear_clearance_mm', 'rear_door_clearance_mm', 'rear_door_mm'],
    left_clearance_mm: ['layout_constraints_json_clearance_left_mm', 'layout_constraints_clearance_left_mm', 'clearance_left_mm', 'left_clearance_mm', 'left_wall_clearance_mm', 'left_wall_mm'],
    right_clearance_mm: ['layout_constraints_json_clearance_right_mm', 'layout_constraints_clearance_right_mm', 'clearance_right_mm', 'right_clearance_mm', 'right_wall_clearance_mm', 'right_wall_mm'],
    minimum_walkway_mm: ['layout_constraints_json_clearance_minimum_walkway_mm', 'layout_constraints_clearance_minimum_walkway_mm', 'clearance_minimum_walkway_mm', 'minimum_walkway_mm', 'walkway_mm']
  };

  setLayoutField(layout, ['build_area', 'x_mm'], 'build_origin_x_mm', layoutNumberFromSources(candidates, fieldAliases.build_origin_x_mm), details);
  setLayoutField(layout, ['build_area', 'y_mm'], 'build_origin_y_mm', layoutNumberFromSources(candidates, fieldAliases.build_origin_y_mm), details);
  setLayoutField(layout, ['build_area', 'length_mm'], 'buildable_length_mm', layoutNumberFromSources(candidates, fieldAliases.buildable_length_mm), details);
  setLayoutField(layout, ['build_area', 'width_mm'], 'buildable_width_mm', layoutNumberFromSources(candidates, fieldAliases.buildable_width_mm), details);
  setLayoutField(layout, ['build_area', 'height_mm'], 'buildable_height_mm', layoutNumberFromSources(candidates, fieldAliases.buildable_height_mm), details);
  setLayoutField(layout, ['clearance', 'front_mm'], 'front_clearance_mm', layoutNumberFromSources(candidates, fieldAliases.front_clearance_mm), details);
  setLayoutField(layout, ['clearance', 'rear_mm'], 'rear_clearance_mm', layoutNumberFromSources(candidates, fieldAliases.rear_clearance_mm), details);
  setLayoutField(layout, ['clearance', 'left_mm'], 'left_clearance_mm', layoutNumberFromSources(candidates, fieldAliases.left_clearance_mm), details);
  setLayoutField(layout, ['clearance', 'right_mm'], 'right_clearance_mm', layoutNumberFromSources(candidates, fieldAliases.right_clearance_mm), details);
  setLayoutField(layout, ['clearance', 'minimum_walkway_mm'], 'minimum_walkway_mm', layoutNumberFromSources(candidates, fieldAliases.minimum_walkway_mm), details);

  for (const item of objects) {
    if (!layout.restricted_zones.length) layout.restricted_zones = restrictedZonesFromLayoutInput(item.input);
    if (!layout.mounting_points.length) layout.mounting_points = mountingPointsFromLayoutInput(item.input);
  }

  const interiorLength = firstPositiveNumber(normalized.interior_length_mm);
  const interiorWidth = firstPositiveNumber(normalized.interior_width_mm);
  const interiorHeight = firstPositiveNumber(normalized.interior_height_mm);
  const estimatedInteriorLength = interiorLength || (normalized.overall_length_mm ? Number(normalized.overall_length_mm) * 0.45 : null);
  const estimatedInteriorWidth = interiorWidth || (normalized.overall_width_mm ? Number(normalized.overall_width_mm) * 0.74 : null);
  const estimatedInteriorHeight = interiorHeight || (normalized.overall_height_mm ? Number(normalized.overall_height_mm) * 0.68 : null);
  const estimateConfidence = interiorLength && interiorWidth ? 'MEDIUM' : 'LOW';
  const estimateNote = interiorLength && interiorWidth
    ? 'Estimated from confirmed interior dimensions.'
    : 'Estimated from exterior proportions because interior dimensions were incomplete.';
  const front = layout.clearance.front_mm ?? 50;
  const rear = layout.clearance.rear_mm ?? 50;
  const left = layout.clearance.left_mm ?? 30;
  const right = layout.clearance.right_mm ?? 30;

  if (estimatedInteriorLength || estimatedInteriorWidth || estimatedInteriorHeight) {
    estimateLayoutValue(layout, ['clearance', 'front_mm'], 'front_clearance_mm', front, details, estimatedFields, estimateNote, estimateConfidence);
    estimateLayoutValue(layout, ['clearance', 'rear_mm'], 'rear_clearance_mm', rear, details, estimatedFields, estimateNote, estimateConfidence);
    estimateLayoutValue(layout, ['clearance', 'left_mm'], 'left_clearance_mm', left, details, estimatedFields, estimateNote, estimateConfidence);
    estimateLayoutValue(layout, ['clearance', 'right_mm'], 'right_clearance_mm', right, details, estimatedFields, estimateNote, estimateConfidence);
    estimateLayoutValue(layout, ['clearance', 'minimum_walkway_mm'], 'minimum_walkway_mm', 400, details, estimatedFields, 'Default planning walkway until designer verifies the vehicle.', 'LOW');
    estimateLayoutValue(layout, ['build_area', 'x_mm'], 'build_origin_x_mm', front, details, estimatedFields, estimateNote, estimateConfidence);
    estimateLayoutValue(layout, ['build_area', 'y_mm'], 'build_origin_y_mm', left, details, estimatedFields, estimateNote, estimateConfidence);
    if (estimatedInteriorLength) estimateLayoutValue(layout, ['build_area', 'length_mm'], 'buildable_length_mm', estimatedInteriorLength - front - rear, details, estimatedFields, estimateNote, estimateConfidence);
    if (estimatedInteriorWidth) estimateLayoutValue(layout, ['build_area', 'width_mm'], 'buildable_width_mm', estimatedInteriorWidth - left - right, details, estimatedFields, estimateNote, estimateConfidence);
    if (estimatedInteriorHeight) estimateLayoutValue(layout, ['build_area', 'height_mm'], 'buildable_height_mm', estimatedInteriorHeight - 30, details, estimatedFields, estimateNote, estimateConfidence);
  }

  const noteFromSources = layoutTextFromSources(candidates, ['layout_notes', 'metadata_notes', 'notes']);
  const derivedFrom = layoutTextFromSources(candidates, ['derived_from', 'metadata_derived_from', 'source_file']);
  if (noteFromSources && !layout.metadata.notes) layout.metadata.notes = noteFromSources;
  if (derivedFrom && !layout.metadata.source_file) layout.metadata.source_file = derivedFrom;
  if (!layout.metadata.source_file) layout.metadata.source_file = firstLayoutSource(details);
  if (!layout.metadata.confidence) layout.metadata.confidence = estimatedFields.length ? estimateConfidence : 'MEDIUM';
  layout.metadata.field_details = details;
  layout.metadata.estimated_fields = [...new Set(estimatedFields)];
  if (estimatedFields.length) {
    layout.metadata.warnings = [
      ...(layout.metadata.warnings || []),
      'Some build area values were estimated. Designer review is required before saving as approved CRDN data.'
    ];
  }

  const readiness = vehicleReadinessSummary(normalized, layout, evidence, estimatedFields);
  layout.vehicle_readiness = readiness;
  layout.metadata.vehicle_readiness = readiness;
  return { layout, readiness };
}

function applyVehicleNormalization(entityId, parsed, evidence) {
  const template = extractionTemplate('vehicle', entityId);
  const normalized = { ...template };
  Object.keys(template).forEach(key => {
    if (key.startsWith('_') || key === 'field_confidence' || key === 'source_evidence') return;
    if (parsed?.[key] !== undefined && parsed[key] !== null) normalized[key] = parsed[key];
  });
  normalized.vehicle_id = clean(normalized.vehicle_id || parsed?.vehicle_id || entityId);
  const confidence = parsed?.field_confidence && typeof parsed.field_confidence === 'object' ? { ...parsed.field_confidence } : {};
  const fieldSources = parsed?._field_sources && typeof parsed._field_sources === 'object' ? { ...parsed._field_sources } : {};
  const unmapped = [];
  const candidates = discoveredSourceCandidates(parsed, evidence);

  candidates.forEach(candidate => {
    const match = vehicleFieldMatch(candidate.source_field);
    if (!match || !Object.prototype.hasOwnProperty.call(template, match.field)) {
      unmapped.push(candidate);
      return;
    }
    const value = normalizeVehicleValue(match.field, candidate.value);
    if (value === null || value === '') return;
    const current = normalized[match.field];
    const currentRank = confidenceRank(confidence[match.field]);
    const nextRank = confidenceRank(match.confidence);
    if (current === null || current === undefined || current === '' || nextRank > currentRank) {
      normalized[match.field] = value;
      confidence[match.field] = match.confidence;
      fieldSources[match.field] = sourceSummaryForField(candidate, match, value);
    }
  });

  if (!normalized.brand && normalized.make) normalized.brand = normalized.make;
  if (!normalized.make && normalized.brand) normalized.make = normalized.brand;
  ['brand', 'make'].forEach(field => {
    if (normalized[field] && !confidence[field]) confidence[field] = field === 'brand' && parsed?.brand ? 'HIGH' : 'MEDIUM';
  });

  normalized._field_sources = fieldSources;
  const layoutResult = normalizeVehicleLayoutConstraintsFromSources(parsed, normalized, candidates, evidence);
  normalized.layout_constraints_json = layoutResult.layout;
  normalized.vehicle_readiness = layoutResult.readiness;
  confidence.layout_constraints_json = layoutResult.layout?.metadata?.confidence || (layoutResult.readiness?.layout_ready ? 'MEDIUM' : 'LOW');
  fieldSources.layout_constraints_json = {
    value: 'layout_constraints_json',
    confidence: confidence.layout_constraints_json,
    source_file: layoutResult.layout?.metadata?.source_file || firstLayoutSource(layoutResult.layout?.metadata?.field_details || {}),
    original_source_field: 'layout_constraints_json',
    match_type: layoutResult.layout?.metadata?.estimated_fields?.length ? 'estimated' : 'direct'
  };

  normalized.field_confidence = confidence;
  normalized.source_evidence = Array.isArray(parsed?.source_evidence) ? parsed.source_evidence : [];
  normalized._field_sources = fieldSources;
  normalized._field_details = layoutResult.layout?.metadata?.field_details || {};
  normalized._unmapped_source_data = dedupeSourceCandidates(unmapped, 80);
  normalized._measurement_required = VEHICLE_PHYSICAL_MEASUREMENT_FIELDS.filter(field => {
    if (field === 'mounting_point_locations') return true;
    const value = normalized[field];
    return value === null || value === undefined || value === '';
  }).map(field => ({
    field,
    label: labelFromKey(field),
    status: 'Physical measurement required'
  }));
  Object.keys(normalized).forEach(key => {
    if (Array.isArray(normalized[key]) || normalized[key] === null || typeof normalized[key] === 'object') return;
    normalized[key] = normalizeExtractionValue(normalized[key]);
  });
  return normalized;
}

function extractionTemplate(entityType, entityId) {
  if (entityType === 'vehicle') {
    return {
      entity_type: 'vehicle',
      vehicle_id: entityId,
      brand: '',
      make: '',
      model: '',
      generation: '',
      market: '',
      body_type: '',
      year_range: '',
      overall_length_mm: null,
      overall_width_mm: null,
      overall_height_mm: null,
      wheelbase_mm: null,
      interior_length_mm: null,
      interior_width_mm: null,
      interior_height_mm: null,
      side_door_width_mm: null,
      side_door_height_mm: null,
      rear_door_width_mm: null,
      rear_door_height_mm: null,
      rear_window_width_mm: null,
      rear_window_height_mm: null,
      wheel_arch_width_mm: null,
      wheel_arch_height_mm: null,
      wheel_arch_position_x_mm: null,
      wheel_arch_position_y_mm: null,
      payload_kg: null,
      layout_constraints_json: {},
      vehicle_readiness: null,
      notes: '',
      field_confidence: {},
      source_evidence: [],
      _field_sources: {},
      _field_details: {},
      _unmapped_source_data: [],
      _measurement_required: []
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
    dimension_confidence: '',
    material: '',
    color: '',
    mounting_type: '',
    compatible_vehicles: [],
    requires_drilling: null,
    install_minutes: null,
    price: null,
    layout_component_type: '',
    layout_width_mm: null,
    layout_depth_mm: null,
    layout_height_mm: null,
    layout_modes_json: [],
    shape_rule: '',
    orientation_options_json: [],
    allowed_zones_json: [],
    clearance_notes: '',
    is_configurable: null,
    configurable_dimensions_json: {},
    default_variant_json: {},
    variants_json: [],
    fitment_confidence: '',
    fitment_reason: '',
    confirmed_data_json: {},
    estimated_data_json: {},
    production_warning: '',
    production_ready: null,
    seat_mode_width_mm: null,
    seat_mode_depth_mm: null,
    bed_mode_width_mm: null,
    bed_mode_depth_mm: null,
    extended_bed_mode_width_mm: null,
    extended_bed_mode_depth_mm: null,
    seat_panel_depth_mm: null,
    back_panel_depth_mm: null,
    optional_extension_depth_mm: null,
    notes: '',
    field_confidence: {},
    source_evidence: []
  };
}

function normalizeExtractionValue(value) {
  if (value === undefined) return null;
  return value;
}

function normalizeExtractionResult(entityType, entityId, parsed, evidence = null) {
  if (entityType === 'vehicle') return applyVehicleNormalization(entityId, parsed || {}, evidence || {});
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

function orderedVehicleResearchFiles(research) {
  if (!research?.items) return [];
  return ['vehicle_record', 'layout_constraints', 'dimensions_csv', 'manifest', 'buildability_report', 'knowledge_sheet']
    .map(key => research.items[key]?.file)
    .filter(Boolean)
    .filter(isTextReadableFile);
}

function uniqueFiles(files = []) {
  const seen = new Set();
  return files.filter(file => {
    const key = clean(file.drive_file_id) || filePath(file);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildExtractionEvidenceContext(files = [], entityType = '', entityId = '') {
  const evidenceFiles = files.filter(isExtractionEvidenceFile);
  const warnings = [];
  const vehicleResearch = entityType === 'vehicle'
    ? await normalizeVehicleResearchFileCandidates(files, entityId)
    : null;
  const selectedResearchByPath = new Map((vehicleResearch?.statuses || [])
    .filter(item => item.found)
    .map(item => [item.path, item]));
  const sourceFiles = evidenceFiles.map(file => {
    const research = selectedResearchByPath.get(filePath(file));
    return {
      ...promptFileMetadata(file),
      evidence_type: BINARY_EVIDENCE_EXTENSIONS.has(fileExtension(file.name || file.path)) ? 'binary_reference' : 'readable_text',
      direct_content_available: isTextReadableFile(file),
      vehicle_research_type: research?.detected_type || '',
      vehicle_research_match_type: research?.match_type || ''
    };
  });
  const readableFileContents = [];
  const textFiles = uniqueFiles([
    ...orderedVehicleResearchFiles(vehicleResearch),
    ...evidenceFiles.filter(isTextReadableFile)
  ]).slice(0, MAX_PROMPT_CONTENT_FILES);
  if (vehicleResearch?.warnings?.length) warnings.push(...vehicleResearch.warnings);

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
  const vehicleGuidance = entityType === 'vehicle'
    ? 'For vehicle extraction, preserve manufacturer source field names in _field_sources when possible. Search all readable evidence in this priority: vehicle_record.json, layout_constraints.json, dimensions.csv, manifest.json, buildability_report.md, then scan-sheet/image/PDF metadata only as supporting evidence. Map cargo/load/luggage dimensions into interior fields, door opening measurements into side/rear door fields, and keep discovered-but-unmapped values in _unmapped_source_data. Confidence labels must be HIGH for exact field matches, MEDIUM for alias or derived values, LOW only for clearly inferred values. Do not invent wheel arch, rear window, or mounting point dimensions. Always attempt layout_constraints_json.build_area and layout_constraints_json.clearance. Accept nested build_area/clearance or flat build_origin_x_mm/buildable_length_mm/front_clearance_mm style fields. If interior dimensions exist but build area is missing, estimate the build area from interior length/width/height minus front/rear/left/right clearances, mark estimated fields MEDIUM or LOW, and explain the coordinate convention. Include vehicle_readiness with overall_score, layout_ready, customer_proposal_ready, fabrication_ready=false, critical_missing, estimated_fields, and warnings. Require a topdown_base image for layout readiness; if missing, warn exactly: "Topdown base image missing. Upload topdown_base.png to this vehicle folder."'
    : '';
  const productGuidance = entityType === 'product'
    ? 'For product extraction, map confirmed physical dimensions separately from layout footprint dimensions when both are present. Use layout_component_type, shape_rule, orientation_options_json, allowed_zones_json, and layout_modes_json when evidence supports AI placement. Put uncertain or image-based estimates in estimated_data_json and mark confidence LOW or MEDIUM. Do not mark production_ready true unless source evidence explicitly confirms production fitment.'
    : '';
  return [
    'You are CRDN internal Design AI extraction. Return concise valid JSON only.',
    'Extract structured dimensions and installation/product/vehicle facts from the provided evidence.',
    'Use millimeters for dimensions, kilograms for weight, and null when a value is unknown.',
    'Do not invent exact measurements from photos, PDFs, screenshots, scans, or 3D asset references when the content is not directly readable.',
    'For each populated field, add field_confidence[field] and list source_evidence entries naming the source file.',
    vehicleGuidance,
    productGuidance,
    `Return this shape for ${entityType}: ${JSON.stringify(shape)}`
  ].filter(Boolean).join(' ');
}

async function extractDesignEntity({ entity_type, entity_id, folder_path, files }) {
  const entityType = clean(entity_type).toLowerCase();
  if (!['product', 'vehicle'].includes(entityType)) {
    const err = new Error('entity_type must be product or vehicle.');
    err.status = 400;
    throw err;
  }
  const entityId = clean(entity_id || folder_path);
  const evidence = await buildExtractionEvidenceContext(files || [], entityType, entityId);
  const apiKey = clean(process.env.OPENAI_API_KEY);
  const model = clean(process.env.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL;
  if (!apiKey) {
    const extracted = normalizeExtractionResult(entityType, entityId, {}, evidence);
    extracted.notes = extracted.notes || 'OPENAI_API_KEY is not configured. This draft contains source evidence metadata and deterministic field normalization only.';
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
  const extracted = normalizeExtractionResult(entityType, entityId, parsed, evidence);
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

function moodboardTemplate(input = {}) {
  const vehicle = clean(input.vehicle_id) || 'Customer Vehicle';
  const project = clean(input.project_name || input.customer_name) || `${vehicle} Concept`;
  const theme = clean(input.lifestyle_theme || input.usage_scenario) || 'adventure utility';
  const products = parseJsonArray(input.must_include_json || input.must_include || '').filter(Boolean);
  return {
    title: project,
    subtitle: `${vehicle} brochure concept + image prompt generator`,
    concept_text: `A CRDN proposal board for ${vehicle}, shaped around ${theme}. This draft organizes the customer story, feature priorities, material palette, layout modes, and image prompts without generating final rendered images yet.`,
    key_features: [
      `Vehicle-led layout concept for ${vehicle}`,
      `Lifestyle theme: ${theme}`,
      products.length ? `Must include: ${products.join(', ')}` : 'Flexible product package to be confirmed'
    ],
    layout_modes: [
      {
        name: 'Travel Mode',
        purpose: 'Keep passengers and cargo secure while preserving quick access to daily-use gear.',
        top_view_description: 'Top-view placeholder showing clear aisle, secured product zones, and stowed camp equipment.',
        included_products: products,
        notes: 'Final dimensions require approved product and vehicle records.'
      },
      {
        name: 'Camp Mode',
        purpose: 'Transform the vehicle into a comfortable campsite setup with cooking, sleeping, and storage zones.',
        top_view_description: 'Top-view placeholder showing expanded living area, sleeping surface, and accessible side utility zone.',
        included_products: products,
        notes: 'Use this as a brochure concept, not a final installation drawing.'
      },
      {
        name: 'Utility Mode',
        purpose: 'Support loading, transport, service work, or product-focused use without removing core modules.',
        top_view_description: 'Top-view placeholder showing open cargo path and modular product placement.',
        included_products: products,
        notes: 'Mode name can be refined for the customer use case.'
      }
    ],
    material_palette: [
      { name: 'CRDN Warm Utility', color: '#CA741F', material: 'accent hardware / brand detail', usage: 'proposal accent and feature highlights' },
      { name: 'Soft Graphite', color: '#3D3D3B', material: 'powder-coated metal', usage: 'durable utility surfaces' },
      { name: 'Natural Birch', color: '#D6B98C', material: 'birch plywood', usage: 'warm cabinetry and panel faces' }
    ],
    mockup_image_prompts: [
      { slot: 'hero rear interior', prompt: `Customer-facing brochure image prompt for ${vehicle}: rear interior view, CRDN warm utility build, ${theme}, premium modular camper details, natural light.` },
      { slot: 'camp mode interior', prompt: `Camp mode interior prompt for ${vehicle}: organized cooking and sleeping setup, warm materials, practical CRDN craftsmanship, customer-ready proposal image.` },
      { slot: 'utility wall closeup', prompt: `Close-up prompt for ${vehicle}: utility wall, storage modules, mounting details, material palette, tidy product callouts.` },
      { slot: 'exterior vehicle', prompt: `Exterior prompt for ${vehicle}: lifestyle setting, CRDN proposal mood, customer vehicle reference to be used in a future image-generation phase.` }
    ],
    brochure_copy: `This brochure concept frames ${project} as a practical CRDN build for ${theme}. The proposal should communicate layout flexibility, material quality, and the staged path from deposit to design refinement before any final rendered mockups are generated.`,
    designer_notes: [
      'This phase creates brochure structure and image prompts only.',
      'Future version can use customer vehicle images as visual references for generated mockups.'
    ]
  };
}

function normalizePalette(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return null;
    return {
      name: clean(item.name),
      color: clean(item.color),
      material: clean(item.material),
      usage: clean(item.usage)
    };
  }).filter(item => item && (item.name || item.color || item.material || item.usage));
}

function normalizeMoodboardModes(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return null;
    return {
      name: clean(item.name),
      purpose: textBlock(item.purpose),
      top_view_description: textBlock(item.top_view_description || item.description),
      included_products: Array.isArray(item.included_products) ? item.included_products.map(clean).filter(Boolean) : [],
      notes: textBlock(item.notes)
    };
  }).filter(item => item && (item.name || item.purpose || item.top_view_description));
}

function normalizeImagePrompts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return null;
    return {
      slot: clean(item.slot || item.name),
      prompt: textBlock(item.prompt)
    };
  }).filter(item => item && (item.slot || item.prompt));
}

function normalizeMoodboardResult(input, parsed) {
  const fallback = moodboardTemplate(input);
  return {
    title: clean(parsed.title) || fallback.title,
    subtitle: clean(parsed.subtitle) || fallback.subtitle,
    concept_text: textBlock(parsed.concept_text) || fallback.concept_text,
    key_features: Array.isArray(parsed.key_features) ? parsed.key_features.map(textBlock).filter(Boolean) : fallback.key_features,
    layout_modes: normalizeMoodboardModes(parsed.layout_modes).length ? normalizeMoodboardModes(parsed.layout_modes) : fallback.layout_modes,
    material_palette: normalizePalette(parsed.material_palette).length ? normalizePalette(parsed.material_palette) : fallback.material_palette,
    mockup_image_prompts: normalizeImagePrompts(parsed.mockup_image_prompts || parsed.image_prompts).length
      ? normalizeImagePrompts(parsed.mockup_image_prompts || parsed.image_prompts)
      : fallback.mockup_image_prompts,
    brochure_copy: textBlock(parsed.brochure_copy) || fallback.brochure_copy,
    designer_notes: normalizeDesignerNotes(parsed.designer_notes).length ? normalizeDesignerNotes(parsed.designer_notes) : fallback.designer_notes
  };
}

async function generateMoodboardConcept(input = {}, files = [], recordsContext = {}) {
  const apiKey = clean(process.env.OPENAI_API_KEY);
  const model = clean(process.env.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL;
  const requestLike = {
    vehicle_id: input.vehicle_id || '',
    must_include_json: input.must_include_json || JSON.stringify(parseJsonArray(input.must_include || '')),
    style_id: input.style_direction || '',
    customer_lifestyle: input.lifestyle_theme || input.usage_scenario || '',
    notes: input.notes || ''
  };
  const libraryContext = await buildLibraryPromptContext(requestLike, files);
  if (!apiKey) {
    const fallback = moodboardTemplate(input);
    return {
      ...fallback,
      raw_openai_response: null,
      content_warnings: ['OPENAI_API_KEY is not configured. This moodboard uses backend fallback brochure content.']
    };
  }

  const prompt = {
    moodboard_input: input,
    approved_records: recordsContext.approved_records || {},
    latest_extraction_drafts: recordsContext.latest_extraction_drafts || {},
    selected_content_files: libraryContext.selected_files || [],
    readable_file_contents: libraryContext.readable_file_contents || [],
    asset_references: libraryContext.asset_references || [],
    content_warnings: libraryContext.content_warnings || [],
    required_output_shape: {
      title: '',
      subtitle: '',
      concept_text: '',
      key_features: [],
      layout_modes: [
        {
          name: 'Travel Mode',
          purpose: '',
          top_view_description: '',
          included_products: [],
          notes: ''
        }
      ],
      material_palette: [
        {
          name: '',
          color: '',
          material: '',
          usage: ''
        }
      ],
      mockup_image_prompts: [
        {
          slot: 'hero rear interior',
          prompt: ''
        }
      ],
      brochure_copy: '',
      designer_notes: []
    }
  };

  designAiLog('moodboard request sent', {
    vehicle_id: input.vehicle_id || '',
    model,
    selected_content_file_count: libraryContext.selected_files.length,
    readable_content_file_count: libraryContext.readable_file_contents.length,
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
          content: 'You are CRDN internal Design AI moodboard generator. Return concise valid JSON only. Create a customer-facing brochure concept and image prompt package, not final rendered images. Prioritize approved_records, then latest_extraction_drafts, then Drive readable evidence, then user notes and style direction. Include layout mode descriptions for Travel Mode, Camp Mode, and Utility/Product Mode. Do not claim image generation has happened.'
        },
        { role: 'user', content: JSON.stringify(prompt) }
      ],
      temperature: 0.45
    })
  });
  if (!response.ok) {
    const body = await response.text();
    designAiLog('moodboard response error', {
      vehicle_id: input.vehicle_id || '',
      status: response.status,
      body_sample: body.slice(0, 240)
    });
    const err = new Error(`OpenAI moodboard generation failed: ${body.slice(0, 240)}`);
    err.status = 502;
    throw err;
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  const normalized = normalizeMoodboardResult(input, parsed);
  designAiLog('moodboard response parsed', {
    vehicle_id: input.vehicle_id || '',
    keys: Object.keys(parsed),
    layout_mode_count: normalized.layout_modes.length,
    image_prompt_count: normalized.mockup_image_prompts.length
  });
  return {
    ...normalized,
    raw_openai_response: data,
    content_warnings: libraryContext.content_warnings || []
  };
}

module.exports = {
  driveStatus,
  requireDriveClient,
  syncDriveFolders,
  designLibraryReadiness,
  classifyDesignLibraryFile,
  findVehicleResearchFiles,
  isVehicleRecordJson,
  isLayoutConstraintsJson,
  isManifestJson,
  isDimensionsCsv,
  normalizeVehicleResearchFileCandidates,
  readDesignLibraryTextFile,
  extractDesignEntity,
  generateMoodboardConcept,
  fallbackDesignResponse,
  generateDesignResponse,
  REQUIRED_MISSING_DATA
};
