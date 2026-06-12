#!/usr/bin/env node
'use strict';

/**
 * Dimension taxonomy — single source of truth for claim dimensions,
 * severity families, and scoring weights.
 *
 * Used by research.js (regex extraction + scoring) and bundle.js
 * (exported into collection bundles as the agent's allowed vocabulary).
 */

const GLOBAL_DIMENSION_ALIASES = {
  'third party tested': 'testing',
  'third-party tested': 'testing',
  'lab tested': 'testing',
  'coa': 'testing',
  'certificate of analysis': 'testing',
  'tested': 'testing',
  'purity': 'purity',
  'contamination': 'quality',
  'contaminated': 'quality',
  'recall': 'quality',
  'lead': 'quality',
  'heavy metal': 'quality',
  'cheap': 'value',
  'cheaper': 'value',
  'expensive': 'value',
  'overpriced': 'value',
  'price': 'value',
  'pricing': 'pricing',
  'cost': 'value',
  'value': 'value',
  'stomach': 'side-effects',
  'nausea': 'side-effects',
  'headache': 'side-effects',
  'side effect': 'side-effects',
  'side effects': 'side-effects',
  'made me sick': 'side-effects',
  'taste': 'taste',
  'flavor': 'taste',
  'dissolve': 'taste',
  'solubility': 'taste',
  'comfort': 'comfort',
  'comfortable': 'comfort',
  'battery': 'battery',
  'display': 'display',
  'screen': 'display',
  'build quality': 'build',
  'build': 'build',
  'durability': 'durability',
  'durable': 'durability',
  'lasted': 'durability',
  'broke': 'durability',
  'broken': 'durability',
  'stopped working': 'durability',
  'performance': 'performance',
  'fast': 'performance',
  'slow': 'performance',
  'lag': 'performance',
  'bug': 'bugs',
  'bugs': 'bugs',
  'crash': 'bugs',
  'crashes': 'bugs',
  'docs': 'docs',
  'documentation': 'docs',
  'ux': 'ux',
  'ui': 'ux',
  'support': 'support',
  'customer service': 'support',
  'service': 'service',
  'food': 'food',
  'ambiance': 'ambiance',
  'wait': 'wait-time',
  'wait time': 'wait-time',
  'adoption': 'adoption',
  'stars': 'adoption',
  'maintenance': 'maintenance'
};

const CATEGORY_DIMENSION_ALIASES = {
  supplement: {
    'dosage': 'dosage',
    'serving': 'dosage',
    'amino acid': 'purity'
  },
  product: {
    'design': 'design',
    'features': 'features'
  },
  tech: {
    'anc': 'noise cancellation',
    'noise cancellation': 'noise cancellation',
    'sound quality': 'sound quality',
    'sound': 'sound quality',
    'features': 'features'
  },
  software: {
    'pricing': 'pricing',
    'workflow': 'ux',
    'editor': 'ux',
    'api': 'features'
  },
  restaurant: {
    'menu': 'food',
    'staff': 'service'
  },
  service: {
    'response time': 'support',
    'billing': 'pricing'
  }
};

const DIMENSION_SEVERITY_FAMILY = {
  'side-effects': 'safety',
  'safety': 'safety',
  'purity': 'quality',
  'testing': 'quality',
  'quality': 'quality',
  'build': 'quality',
  'durability': 'effectiveness',
  'performance': 'effectiveness',
  'battery': 'effectiveness',
  'bugs': 'effectiveness',
  'noise cancellation': 'effectiveness',
  'sound quality': 'effectiveness',
  'support': 'quality',
  'service': 'quality',
  'food': 'quality',
  'value': 'value',
  'pricing': 'value',
  'price': 'value',
  'taste': 'taste',
  'comfort': 'taste',
  'ux': 'other',
  'docs': 'other',
  'ambiance': 'other',
  'wait-time': 'other',
  'adoption': 'other',
  'maintenance': 'other'
};

const NEGATIVE_SCORE_WEIGHTS = {
  safety: 1.5,
  effectiveness: 1.0,
  quality: 0.5,
  value: 0.25,
  taste: 0.25,
  other: 0.25
};

const SEVERITY_RANK = {
  safety: 5,
  quality: 4,
  effectiveness: 3,
  value: 2,
  taste: 1,
  other: 1
};

// Dimensions the regex fallback can emit that aren't alias targets.
const EXTRA_DIMENSIONS = ['general', 'other', 'dosage', 'design', 'features', 'display'];

function dimensionsForCategory(category) {
  const dims = new Set([
    ...Object.values(GLOBAL_DIMENSION_ALIASES),
    ...Object.values(CATEGORY_DIMENSION_ALIASES[category] || {}),
    ...Object.keys(DIMENSION_SEVERITY_FAMILY),
    ...EXTRA_DIMENSIONS
  ]);
  return [...dims].sort();
}

/**
 * Taxonomy block embedded in collection bundles. The agent must pick
 * claim dimensions from `dimensions`; anything else gets coerced to "other".
 */
function exportTaxonomy(category) {
  return {
    category,
    dimensions: dimensionsForCategory(category),
    severityFamilies: { ...DIMENSION_SEVERITY_FAMILY },
    negativeWeights: { ...NEGATIVE_SCORE_WEIGHTS }
  };
}

module.exports = {
  GLOBAL_DIMENSION_ALIASES,
  CATEGORY_DIMENSION_ALIASES,
  DIMENSION_SEVERITY_FAMILY,
  NEGATIVE_SCORE_WEIGHTS,
  SEVERITY_RANK,
  dimensionsForCategory,
  exportTaxonomy
};
