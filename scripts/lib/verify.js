#!/usr/bin/env node
'use strict';

/**
 * Claim verification — every claim quote must literally trace back to
 * fetched source text before it is allowed to influence scoring.
 *
 * Match tiers:
 *   exact    — normalized quote is a substring of the source text
 *   fuzzy    — >=85% of quote tokens appear IN ORDER within a window of
 *              1.5x the quote length (tolerates dropped filler words and
 *              typo fixes; the in-order constraint blocks fabrication)
 *   attested — quote matches agent-supplied externalSources text the CLI
 *              never fetched itself; scored, but never raises the stamp
 *   rejected — no match / unknown source / quote too short. Excluded from
 *              scoring, kept in output with the reason.
 *
 * Input:  claims doc (consensus-research/claims/v1) + collection bundle
 * Output: { accepted, rejected, warnings, stats } where accepted claims
 *         are rehydrated to the full internal claim shape the scoring
 *         pipeline consumes.
 */

const { getSource } = require('./bundle');

const CLAIMS_SCHEMA = 'consensus-research/claims/v1';
const MIN_QUOTE_LENGTH = 15;
const MAX_QUOTE_LENGTH = 300;
const FUZZY_TOKEN_RATIO = 0.85;
const FUZZY_WINDOW_FACTOR = 1.5;
const POLARITIES = new Set(['positive', 'negative', 'mixed']);

function cleanupText(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : `${str.slice(0, max)}...`;
}

function normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")   // smart single quotes
    .replace(/[“”]/g, '"')          // smart double quotes
    .replace(/[–—]/g, '-')          // en/em dashes
    .replace(/[​‌‍﻿]/g, '') // zero-width chars
    .replace(/[*_`~>#]/g, ' ')                // markdown markers
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return normalizeForMatch(str).split(/[^a-z0-9']+/).filter(Boolean);
}

function exactMatch(quote, text) {
  const normalizedQuote = normalizeForMatch(quote);
  if (!normalizedQuote) return false;
  return normalizeForMatch(text).includes(normalizedQuote);
}

/**
 * In-order token-subsequence match within a bounded window.
 * Returns the best ratio of quote tokens matched in order.
 */
function fuzzyMatchRatio(quote, text) {
  const quoteTokens = tokenize(quote);
  const textTokens = tokenize(text);
  if (quoteTokens.length === 0 || textTokens.length === 0) return 0;

  const windowLimit = Math.ceil(quoteTokens.length * FUZZY_WINDOW_FACTOR);
  let best = 0;

  for (let start = 0; start < textTokens.length; start++) {
    let quoteIdx = 0;
    let matched = 0;
    const end = Math.min(start + windowLimit, textTokens.length);
    for (let k = start; k < end && quoteIdx < quoteTokens.length; k++) {
      if (textTokens[k] === quoteTokens[quoteIdx]) {
        matched++;
        quoteIdx++;
      } else if (quoteIdx < quoteTokens.length - 1 && textTokens[k] === quoteTokens[quoteIdx + 1]) {
        // Tolerate one dropped quote token at a time.
        quoteIdx += 2;
        matched++;
      }
    }
    if (matched > best) best = matched;
    if (best === quoteTokens.length) break;
  }

  return best / quoteTokens.length;
}

function fuzzyMatch(quote, text) {
  return fuzzyMatchRatio(quote, text) >= FUZZY_TOKEN_RATIO;
}

/**
 * Find where in a bundle source the quote matches.
 * Returns { method: 'exact'|'fuzzy', segment } or null.
 */
function matchAgainstSource(quote, source, segmentId = null) {
  const pinned = segmentId
    ? (source.segments || []).find(segment => segment.id === segmentId) || null
    : null;

  // Exact pass: pinned segment → main text → all segments (agents get
  // segment ids wrong more often than they get quotes wrong).
  if (pinned && exactMatch(quote, pinned.text)) return { method: 'exact', segment: pinned };
  if (exactMatch(quote, source.text)) return { method: 'exact', segment: null };
  for (const segment of source.segments || []) {
    if (exactMatch(quote, segment.text)) return { method: 'exact', segment };
  }

  // Fuzzy pass, same order.
  if (pinned && fuzzyMatch(quote, pinned.text)) return { method: 'fuzzy', segment: pinned };
  if (fuzzyMatch(quote, source.text)) return { method: 'fuzzy', segment: null };
  let bestSegment = null;
  let bestRatio = 0;
  for (const segment of source.segments || []) {
    const ratio = fuzzyMatchRatio(quote, segment.text);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestSegment = segment;
    }
  }
  if (bestRatio >= FUZZY_TOKEN_RATIO) return { method: 'fuzzy', segment: bestSegment };

  return null;
}

function scoreKindForSource(source, segment) {
  if (segment?.scoreKind) return segment.scoreKind;
  if (source.meta?.upvotes != null) return 'upvotes';
  if (source.meta?.rating != null) return 'stars';
  if (source.meta?.stars != null) return 'stars';
  return null;
}

function rehydrateClaim(claim, source, segment, method) {
  return {
    brand: claim.brand ? cleanupText(claim.brand) : null,
    dimension: claim.dimension,
    polarity: claim.polarity,
    sourceType: source.platform,
    sourceId: segment ? `${source.id}#${segment.id}` : source.id,
    independentSourceId: source.id,
    subreddit: source.meta?.subreddit ? `r/${source.meta.subreddit}` : null,
    score: segment?.score ?? source.meta?.upvotes ?? source.meta?.rating ?? source.meta?.stars ?? null,
    scoreKind: scoreKindForSource(source, segment),
    quote: truncate(cleanupText(claim.quote), MAX_QUOTE_LENGTH),
    url: source.url || null,
    verification: method
  };
}

function validateClaimsDoc(doc, path = 'claims') {
  const problems = [];
  if (!doc || typeof doc !== 'object') problems.push('not an object');
  else {
    if (doc.schema !== CLAIMS_SCHEMA) problems.push(`schema is "${doc.schema}", expected "${CLAIMS_SCHEMA}"`);
    if (!Array.isArray(doc.claims)) problems.push('missing claims[]');
    if (doc.externalSources != null && !Array.isArray(doc.externalSources)) {
      problems.push('externalSources must be an array');
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid claims doc (${path}): ${problems.join('; ')}`);
  }
  return doc;
}

function verifyClaims(claimsDoc, bundle) {
  validateClaimsDoc(claimsDoc);

  const allowedDimensions = new Set(bundle.taxonomy?.dimensions || []);
  const externalById = new Map(
    (claimsDoc.externalSources || []).map(ext => [ext.id, ext])
  );

  const accepted = [];
  const rejected = [];
  const warnings = [];
  const stats = { total: 0, exact: 0, fuzzy: 0, attested: 0, rejected: 0 };

  for (const rawClaim of claimsDoc.claims || []) {
    stats.total++;
    const claim = {
      brand: rawClaim.brand ?? null,
      dimension: cleanupText(rawClaim.dimension || ''),
      polarity: cleanupText(rawClaim.polarity || '').toLowerCase(),
      sourceId: cleanupText(rawClaim.sourceId || ''),
      segmentId: rawClaim.segmentId ? cleanupText(rawClaim.segmentId).replace(/^.*#/, '') : null,
      quote: cleanupText(rawClaim.quote || ''),
      note: rawClaim.note || null
    };

    const reject = reason => {
      stats.rejected++;
      rejected.push({ ...claim, reason });
    };

    if (!claim.quote || claim.quote.length < MIN_QUOTE_LENGTH) {
      reject(`quote too short to verify (<${MIN_QUOTE_LENGTH} chars)`);
      continue;
    }
    if (!claim.sourceId) {
      reject('missing sourceId');
      continue;
    }

    if (!POLARITIES.has(claim.polarity)) {
      warnings.push(`claim on "${claim.brand || 'category'}": polarity "${claim.polarity}" coerced to "mixed"`);
      claim.polarity = 'mixed';
    }
    if (!allowedDimensions.has(claim.dimension)) {
      warnings.push(`claim on "${claim.brand || 'category'}": dimension "${claim.dimension}" not in taxonomy, coerced to "other"`);
      claim.dimension = 'other';
    }

    // External (agent-fetched) source → attested tier at best.
    const external = externalById.get(claim.sourceId);
    if (external) {
      if (exactMatch(claim.quote, external.fetchedText) || fuzzyMatch(claim.quote, external.fetchedText)) {
        stats.attested++;
        accepted.push(rehydrateClaim(
          claim,
          {
            id: external.id,
            platform: external.platform || 'expert',
            url: external.url || null,
            meta: {},
            segments: []
          },
          null,
          'attested'
        ));
      } else {
        reject('quote not found in external source text');
      }
      continue;
    }

    const source = getSource(bundle, claim.sourceId);
    if (!source) {
      reject(`unknown sourceId "${claim.sourceId}"`);
      continue;
    }

    const match = matchAgainstSource(claim.quote, source, claim.segmentId);
    if (!match) {
      reject('quote not found in source text (checked main text and all segments)');
      continue;
    }

    stats[match.method]++;
    accepted.push(rehydrateClaim(claim, source, match.segment, match.method));
  }

  return { accepted, rejected, warnings, stats };
}

module.exports = {
  CLAIMS_SCHEMA,
  MIN_QUOTE_LENGTH,
  normalizeForMatch,
  tokenize,
  exactMatch,
  fuzzyMatch,
  fuzzyMatchRatio,
  matchAgainstSource,
  validateClaimsDoc,
  verifyClaims
};
