#!/usr/bin/env node
'use strict';

/**
 * Generic static-page fetcher — turns an article URL into verifiable text.
 * Powers `ingest`, the expert-page full-text upgrade, and best-effort
 * sources like Labdoor/BBB (no bespoke parsers — the agent does the reading).
 */

const { htmlToText } = require('./bundle');
const { createFileCache } = require('./cache');

const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MIN_USABLE_CHARS = 200;

const pageCache = createFileCache({
  dir: 'data/page-cache',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  label: 'pages'
});

function log(msg) {
  process.stderr.write(`[fetchpage] ${msg}\n`);
}

/**
 * @returns {Promise<{ok: boolean, url: string, title: string, text: string, error: string|null}>}
 */
async function fetchPage(url, { useCache = true, timeoutMs = 20000 } = {}) {
  if (useCache) {
    const cached = pageCache.get(url);
    if (cached) return cached;
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': PAGE_UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    });
  } catch (err) {
    return { ok: false, url, title: '', text: '', error: err.message };
  }

  if (!res.ok) {
    return { ok: false, url, title: '', text: '', error: `HTTP ${res.status}` };
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType && !contentType.includes('html') && !contentType.includes('text')) {
    return { ok: false, url, title: '', text: '', error: `non-HTML content-type: ${contentType}` };
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { ok: false, url, title: '', text: '', error: `body read failed: ${err.message}` };
  }

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const text = htmlToText(html);

  if (text.length < MIN_USABLE_CHARS) {
    return {
      ok: false,
      url,
      title: titleMatch ? titleMatch[1].trim() : '',
      text: '',
      error: `page yielded only ${text.length} chars of text (JS-rendered or blocked?)`
    };
  }

  const result = {
    ok: true,
    url,
    title: titleMatch ? titleMatch[1].trim() : '',
    text,
    error: null
  };
  pageCache.set(url, result);
  return result;
}

module.exports = { fetchPage, pageCache };
