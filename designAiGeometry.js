'use strict';

/*
 * CRDN Vehicle Geometry AI
 */

function normalizeGeometrySuggestion(result = {}) {
  return {
    schema_version: 1,

    build_area: result.build_area || {},

    clearance: result.clearance || {},

    restricted_zones: Array.isArray(result.restricted_zones)
      ? result.restricted_zones
      : [],

    mounting_points: Array.isArray(result.mounting_points)
      ? result.mounting_points
      : [],

    metadata: {
      status: 'ai_suggested',
      confidence: result.metadata?.confidence || 'LOW',
      notes: result.metadata?.notes || '',
      reasoning: result.reasoning || [],
      warnings: result.warnings || [],
      updated_at: new Date().toISOString()
    }
  };
}


async function analyzeVehicleGeometry({
  vehicle = {},
  files = [],
  apiKey = '',
  model = 'gpt-4o-mini'
}) {
  const suggestion = normalizeGeometrySuggestion({
  build_area: {
    x_mm: 0,
    y_mm: 0,
    length_mm: vehicle.interior_length_mm || null,
    width_mm: vehicle.interior_width_mm || null,
    height_mm: vehicle.interior_height_mm || null
  },
  clearance: {
    front_mm: 50,
    rear_mm: 50,
    left_mm: 30,
    right_mm: 30,
    minimum_walkway_mm: 450
  },
  restricted_zones: [],
  metadata: {
    confidence: 'LOW',
    notes: 'Placeholder geometry. OpenAI analysis will replace this.'
  }
});

return {
  suggestion,
  raw_openai_response: null,
  source_files: files,
  content_warnings: []
};
}

module.exports = {
  analyzeVehicleGeometry,
  normalizeGeometrySuggestion
};

