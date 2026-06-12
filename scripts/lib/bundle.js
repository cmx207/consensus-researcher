#!/usr/bin/env node
'use strict';

/**
 * Collection bundle — the contract between the CLI collector and the
 * agent that reads/extracts claims.
 *
 * A bundle wraps the legacy `raw` collection object verbatim (so caching,
 * data-sufficiency, and comparison logic keep working) and adds a flat,
 * ID-addressed `sources[]` view. The agent reads `sources[].text` /
 * `sources[].segments[]` and emits claims referencing `src_NNN` ids;
 * the verifier matches every claim quote against exactly this text.
 *
 * Schema: consensus-research/collect/v1
 */

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { dirname, resolve } = require('path');

const { exportTaxonomy } = require('./taxonomy');

const BUNDLE_SCHEMA = 'consensus-research/collect/v1';
const MAX_PAGE_TEXT = 40 * 1024; // 40KB cap per ingested page

function cleanupText(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function safeHostname(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return ''; }
}

function inferWebPlatform(url) {
  const host = safeHostname(url);
  if (host.includes('news.ycombinator.com')) return 'hn';
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
  if (host.includes('github.com')) return 'github';
  if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
  return 'expert';
}

/**
 * Minimal static HTML → readable text. No DOM, no deps — good enough for
 * article bodies; the agent does the actual reading.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(p|div|li|h[1-6]|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, MAX_PAGE_TEXT);
}

function nextSourceId(bundle) {
  const n = bundle.sources.length + 1;
  return `src_${String(n).padStart(3, '0')}`;
}

/**
 * Build the flat sources[] view from the legacy raw collection object.
 */
function buildSources(raw) {
  const sources = [];
  const push = source => {
    const id = `src_${String(sources.length + 1).padStart(3, '0')}`;
    sources.push({ id, ...source });
    return id;
  };

  for (const thread of raw.reddit?.threads || []) {
    push({
      platform: 'reddit',
      kind: 'thread',
      fetchLevel: 'full',
      url: thread.url,
      title: thread.title || '',
      text: cleanupText([thread.title, thread.selftext].filter(Boolean).join('. ')),
      segments: (thread.comments || []).map((comment, index) => ({
        id: `c${index}`,
        text: comment.body,
        score: comment.score ?? null,
        scoreKind: 'upvotes',
        author: comment.author || null,
        depth: comment.depth ?? 0
      })),
      meta: {
        subreddit: thread.subreddit || null,
        upvotes: thread.upvotes ?? null,
        commentCount: thread.commentCount ?? 0,
        strategy: thread.strategy || null
      },
      agentFetchSuggested: false
    });
  }

  for (const product of raw.amazon?.products || []) {
    push({
      platform: 'amazon',
      kind: 'snippet',
      fetchLevel: 'snippet',
      url: product.url,
      title: product.title || '',
      text: cleanupText([product.title, product.snippet].filter(Boolean).join('. ')),
      segments: [],
      meta: {
        rating: product.rating ?? null,
        reviewCount: product.reviewCount ?? null,
        price: product.price ?? null
      },
      agentFetchSuggested: false
    });
  }

  let expertSuggested = 0;
  for (const result of raw.web?.results || []) {
    const platform = inferWebPlatform(result.url);
    const suggested = platform === 'expert' && expertSuggested < 3;
    if (suggested) expertSuggested++;
    push({
      platform,
      kind: 'snippet',
      fetchLevel: 'snippet',
      url: result.url,
      title: result.title || '',
      text: cleanupText([result.title, result.snippet].filter(Boolean).join('. ')),
      segments: [],
      meta: { age: result.age || null },
      agentFetchSuggested: suggested
    });
  }

  for (const result of raw.youtube?.results || []) {
    push({
      platform: 'youtube',
      kind: 'snippet',
      fetchLevel: 'snippet',
      url: result.url,
      title: result.title || '',
      text: cleanupText([result.title, result.snippet].filter(Boolean).join('. ')),
      segments: [],
      meta: {},
      agentFetchSuggested: false
    });
  }

  for (const result of raw.twitter?.results || []) {
    push({
      platform: 'twitter',
      kind: 'snippet',
      fetchLevel: 'snippet',
      url: result.url,
      title: result.title || '',
      text: cleanupText([result.title, result.snippet].filter(Boolean).join('. ')),
      segments: [],
      meta: {},
      agentFetchSuggested: false
    });
  }

  for (const repo of raw.github?.repos || []) {
    const statsText = [
      repo.stars != null ? `${repo.stars} stars` : null,
      repo.openIssues != null ? `${repo.openIssues} open issues` : null,
      repo.lastCommitDate ? `last commit ${repo.lastCommitDate}` : null
    ].filter(Boolean).join(', ');
    push({
      platform: 'github',
      kind: 'repo',
      fetchLevel: 'metadata',
      url: repo.url,
      title: repo.name || repo.repo || '',
      text: cleanupText([repo.name, repo.description, statsText].filter(Boolean).join('. ')),
      segments: [],
      meta: {
        owner: repo.owner || null,
        repo: repo.repo || null,
        stars: repo.stars ?? null,
        openIssues: repo.openIssues ?? null,
        lastCommitDate: repo.lastCommitDate || null
      },
      agentFetchSuggested: false
    });
  }

  return sources;
}

function buildBundle(raw, fetchLogEntries = [], entitySeeds = []) {
  return {
    schema: BUNDLE_SCHEMA,
    query: raw.query,
    category: raw.category,
    depth: raw.depth,
    location: raw.location || null,
    timestamp: raw.timestamp,
    taxonomy: exportTaxonomy(raw.category),
    entities: { seeds: entitySeeds },
    sources: buildSources(raw),
    fetchLog: fetchLogEntries,
    dataSufficiency: raw.dataSufficiency,
    sourceCount: raw.sourceCount,
    apiCost: raw.apiCost,
    raw
  };
}

function validateBundle(bundle, path = 'bundle') {
  const problems = [];
  if (!bundle || typeof bundle !== 'object') problems.push('not an object');
  else {
    if (bundle.schema !== BUNDLE_SCHEMA) problems.push(`schema is "${bundle.schema}", expected "${BUNDLE_SCHEMA}"`);
    if (!bundle.query) problems.push('missing query');
    if (!Array.isArray(bundle.sources)) problems.push('missing sources[]');
    if (!bundle.raw || typeof bundle.raw !== 'object') problems.push('missing raw collection object');
    if (!bundle.taxonomy?.dimensions?.length) problems.push('missing taxonomy.dimensions');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid bundle (${path}): ${problems.join('; ')}`);
  }
  return bundle;
}

function loadBundle(path) {
  const fullPath = resolve(path);
  if (!existsSync(fullPath)) throw new Error(`Bundle not found: ${fullPath}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch (err) {
    throw new Error(`Bundle is not valid JSON (${fullPath}): ${err.message}`);
  }
  return validateBundle(parsed, fullPath);
}

function saveBundle(bundle, path) {
  validateBundle(bundle);
  const fullPath = resolve(path);
  if (!existsSync(dirname(fullPath))) mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(bundle, null, 2), 'utf8');
  return fullPath;
}

/**
 * Append a CLI-fetched page as a fully verifiable source (used by `ingest`).
 */
function appendSource(bundle, { url, title = '', html = null, text = null, platform = null }) {
  const body = text != null ? String(text).slice(0, MAX_PAGE_TEXT) : htmlToText(html);
  if (!body || body.length < 50) {
    throw new Error(`Page yielded no usable text (${url}) — got ${body.length} chars`);
  }

  const source = {
    id: nextSourceId(bundle),
    platform: platform || inferWebPlatform(url),
    kind: 'page',
    fetchLevel: 'full',
    url,
    title: cleanupText(title),
    text: body,
    segments: [],
    meta: { ingested: true, ingestedAt: new Date().toISOString() },
    agentFetchSuggested: false
  };

  bundle.sources.push(source);
  // The snippet-level twin (if any) no longer needs an agent fetch.
  for (const existing of bundle.sources) {
    if (existing.url === url && existing.id !== source.id) existing.agentFetchSuggested = false;
  }
  return source;
}

function getSource(bundle, sourceId) {
  return bundle.sources.find(source => source.id === sourceId) || null;
}

module.exports = {
  BUNDLE_SCHEMA,
  buildBundle,
  validateBundle,
  loadBundle,
  saveBundle,
  appendSource,
  getSource,
  htmlToText
};
