#!/usr/bin/env node
'use strict';

/**
 * Search provider abstraction with automatic fallback.
 * Priority: Brave (best quality) → DuckDuckGo HTML (always available, no API key).
 *
 * Tracks provider health in data/search-health.json.
 */

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { dirname, resolve } = require('path');

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const HEALTH_PATH = resolve(process.cwd(), 'data/search-health.json');

const BRAVE_COST_PER_QUERY = 0.005;

// DDG bot-detects obvious tool UAs and rapid-fire requests. A browser-like UA
// plus pacing keeps the anonymous endpoints usable.
const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DDG_MIN_INTERVAL_MS = 1500;

let lastBraveCall = 0;
let lastDDGCall = 0;
const apiCalls = { brave: 0, ddg: 0, total: 0 };

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  process.stderr.write(`[search] ${msg}\n`);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function safeHostname(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return ''; }
}

// --- Health tracking ---

function loadHealth() {
  if (!existsSync(HEALTH_PATH)) {
    return {
      providers: {
        brave: { status: 'unknown', failures: [], lastSuccess: null },
        ddg: { status: 'unknown', failures: [], lastSuccess: null }
      },
      lastUpdated: null
    };
  }
  try {
    return JSON.parse(readFileSync(HEALTH_PATH, 'utf8'));
  } catch {
    return { providers: { brave: { status: 'unknown', failures: [], lastSuccess: null }, ddg: { status: 'unknown', failures: [], lastSuccess: null } }, lastUpdated: null };
  }
}

function saveHealth(health) {
  ensureDir(dirname(HEALTH_PATH));
  health.lastUpdated = new Date().toISOString();
  writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2), 'utf8');
}

function recordSuccess(providerName) {
  const health = loadHealth();
  const provider = health.providers[providerName] || { status: 'unknown', failures: [], lastSuccess: null };
  provider.status = 'healthy';
  provider.lastSuccess = new Date().toISOString();
  health.providers[providerName] = provider;
  saveHealth(health);
}

function recordFailure(providerName, reason) {
  const health = loadHealth();
  const provider = health.providers[providerName] || { status: 'unknown', failures: [], lastSuccess: null };
  provider.failures.push({ reason, at: new Date().toISOString() });
  // Keep last 20 failures
  if (provider.failures.length > 20) provider.failures = provider.failures.slice(-20);
  // Count failures in last 24h
  const cutoff = Date.now() - 86400000;
  const recentFailures = provider.failures.filter(f => new Date(f.at).getTime() > cutoff).length;
  provider.status = recentFailures >= 5 ? 'blocked' : recentFailures >= 2 ? 'degraded' : 'healthy';
  health.providers[providerName] = provider;
  saveHealth(health);
}

function getProviderStatus(providerName) {
  const health = loadHealth();
  return health.providers[providerName]?.status || 'unknown';
}

// --- Brave Search ---

async function searchBrave(query, count = 5) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;

  // Rate limit: 200ms between calls
  const wait = 200 - (Date.now() - lastBraveCall);
  if (wait > 0) await sleep(wait);
  lastBraveCall = Date.now();

  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=${count}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'X-Subscription-Token': key,
        'Accept': 'application/json'
      }
    });
  } catch (err) {
    log(`Brave fetch error: ${err.message}`);
    recordFailure('brave', err.message);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log(`Brave API ${res.status}: ${body.slice(0, 200)}`);
    recordFailure('brave', `HTTP ${res.status}`);
    return null;
  }

  apiCalls.brave++;
  apiCalls.total++;
  recordSuccess('brave');

  const data = await res.json();
  return (data.web?.results || []).map(result => ({
    title: result.title || '',
    url: result.url,
    snippet: result.description || '',
    source: safeHostname(result.url),
    age: result.age || null
  }));
}

// --- DuckDuckGo HTML fallback (no API key needed) ---

function parseDDGHtml(html) {
  const results = [];
  // Match result blocks: <a class="result__a" href="...">title</a> and <a class="result__snippet" ...>snippet</a>
  const resultBlocks = html.split(/class="result\s/g).slice(1);

  for (const block of resultBlocks) {
    if (results.length >= 10) break;

    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"\s+href="([^"]+)"/);
    if (!urlMatch) continue;

    let url = urlMatch[1].replace(/&amp;/g, '&');
    // DDG wraps URLs in redirect: //duckduckgo.com/l/?uddg=ENCODED_URL
    if (url.includes('uddg=')) {
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
    }

    // Skip ads: y.js redirects and ad_domain links never unwrap to organic results.
    if (url.includes('duckduckgo.com/y.js') || url.includes('ad_domain=') || safeHostname(url).endsWith('duckduckgo.com')) {
      continue;
    }

    // Extract title
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const title = titleMatch ? titleMatch[1].replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : '';

    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let snippet = '';
    if (snippetMatch) {
      snippet = snippetMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (url && title) {
      results.push({
        title,
        url,
        snippet,
        source: safeHostname(url),
        age: null
      });
    }
  }

  return results;
}

function isDDGChallengePage(html) {
  if (!html) return false;
  if (html.includes('result__a') || html.includes('result-link')) return false;
  return /anomaly|challenge|botnet|unusual traffic|are you a robot/i.test(html) || html.length < 2000;
}

/**
 * lite.duckduckgo.com parser — simple table layout:
 * <a rel="nofollow" href="URL">Title</a> ... <td class="result-snippet">snippet</td>
 */
function parseDDGLiteHtml(html) {
  const results = [];
  const linkRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)]
    .map(match => match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

  let match;
  let index = 0;
  while ((match = linkRe.exec(html)) !== null && results.length < 10) {
    let url = match[1].replace(/&amp;/g, '&');
    if (url.includes('uddg=')) {
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
    }
    if (url.includes('duckduckgo.com/y.js') || url.includes('ad_domain=') || safeHostname(url).endsWith('duckduckgo.com')) {
      index++;
      continue;
    }
    const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (url.startsWith('http') && title) {
      results.push({
        title,
        url,
        snippet: snippets[index] || '',
        source: safeHostname(url),
        age: null
      });
    }
    index++;
  }

  return results;
}

async function ddgRateLimit() {
  const wait = DDG_MIN_INTERVAL_MS - (Date.now() - lastDDGCall);
  if (wait > 0) await sleep(wait);
  lastDDGCall = Date.now();
}

async function searchDDG(query, count = 5) {
  // Endpoint 1: html.duckduckgo.com (richer markup)
  await ddgRateLimit();
  let html = null;
  try {
    const res = await fetch(DDG_HTML_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DDG_UA
      },
      body: `q=${encodeURIComponent(query)}&b=`
    });
    if (res.ok) html = await res.text();
    else recordFailure('ddg', `HTTP ${res.status}`);
  } catch (err) {
    log(`DDG fetch error: ${err.message}`);
    recordFailure('ddg', err.message);
  }

  if (html) {
    apiCalls.ddg++;
    apiCalls.total++;
    if (isDDGChallengePage(html)) {
      log('DDG html endpoint served a challenge page — trying lite endpoint');
      recordFailure('ddg', 'challenge page (bot detection)');
    } else {
      const results = parseDDGHtml(html);
      if (results.length > 0) {
        recordSuccess('ddg');
        return results.slice(0, count);
      }
      log('DDG html endpoint returned 0 parseable results from non-empty HTML');
      recordFailure('ddg', 'parse yielded 0 results from non-empty HTML');
    }
  }

  // Endpoint 2: lite.duckduckgo.com fallback
  await ddgRateLimit();
  try {
    const res = await fetch(`${DDG_LITE_URL}?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': DDG_UA }
    });
    if (!res.ok) {
      recordFailure('ddg', `lite HTTP ${res.status}`);
      return null;
    }
    const liteHtml = await res.text();
    apiCalls.ddg++;
    apiCalls.total++;
    if (isDDGChallengePage(liteHtml)) {
      log('DDG lite endpoint also served a challenge page — backing off');
      recordFailure('ddg', 'lite challenge page (bot detection)');
      return null;
    }
    const results = parseDDGLiteHtml(liteHtml);
    if (results.length > 0) {
      recordSuccess('ddg');
      return results.slice(0, count);
    }
    recordFailure('ddg', 'lite parse yielded 0 results from non-empty HTML');
    return null;
  } catch (err) {
    log(`DDG lite fetch error: ${err.message}`);
    recordFailure('ddg', err.message);
    return null;
  }
}

// --- Unified search with fallback ---

let _fallbackWarned = false;

async function search(query, count = 5) {
  // Try Brave first (best quality)
  const braveStatus = getProviderStatus('brave');
  if (braveStatus !== 'blocked' && process.env.BRAVE_API_KEY) {
    const results = await searchBrave(query, count);
    if (results && results.length > 0) {
      return { provider: 'brave', results };
    }
  }

  // Fallback to DDG
  if (!_fallbackWarned) {
    log('Brave unavailable — falling back to DuckDuckGo');
    _fallbackWarned = true;
  }
  const ddgResults = await searchDDG(query, count);
  if (ddgResults && ddgResults.length > 0) {
    return { provider: 'ddg', results: ddgResults };
  }

  return { provider: null, results: [] };
}

function getSearchApiCalls() {
  return { ...apiCalls };
}

function resetSearchApiCalls() {
  apiCalls.brave = 0;
  apiCalls.ddg = 0;
  apiCalls.total = 0;
}

function getSearchCost() {
  return {
    braveCalls: apiCalls.brave,
    ddgCalls: apiCalls.ddg,
    totalCalls: apiCalls.total,
    estimatedUSD: Math.round(apiCalls.brave * BRAVE_COST_PER_QUERY * 1000) / 1000
  };
}

function getHealthSummary() {
  const health = loadHealth();
  const lines = [];
  for (const [name, provider] of Object.entries(health.providers)) {
    const cutoff = Date.now() - 86400000;
    const recentFailures = (provider.failures || []).filter(f => new Date(f.at).getTime() > cutoff).length;
    lines.push(`${name}: ${provider.status || 'unknown'} (${recentFailures} failures in 24h)`);
  }
  return lines.join(' | ');
}

module.exports = {
  search,
  searchBrave,
  searchDDG,
  parseDDGHtml,
  parseDDGLiteHtml,
  isDDGChallengePage,
  getSearchApiCalls,
  resetSearchApiCalls,
  getSearchCost,
  getHealthSummary,
  getProviderStatus,
  BRAVE_COST_PER_QUERY
};
