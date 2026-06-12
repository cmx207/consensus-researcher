#!/usr/bin/env node
'use strict';

/**
 * HackerNews via the Algolia API — free, keyless, pure JSON, full comment
 * trees. Tier 1 signal (same as Reddit) for software/tech.
 *
 * Search:  https://hn.algolia.com/api/v1/search?query=...&tags=story
 * Thread:  https://hn.algolia.com/api/v1/items/<id>
 */

const { createFileCache } = require('./cache');

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HN_ITEM_URL = 'https://hn.algolia.com/api/v1/items';
const MAX_COMMENT_LENGTH = 1000;
const MAX_COMMENTS = 80;

const hnCache = createFileCache({
  dir: 'data/hn-cache',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  label: 'hn'
});

let apiCalls = 0;

function log(msg) {
  process.stderr.write(`[hn] ${msg}\n`);
}

function cleanupText(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : `${str.slice(0, max)}...`;
}

/**
 * Flatten an Algolia item's nested children into the comments[] shape the
 * rest of the pipeline expects (same as reddit.js).
 */
function flattenComments(children, depth = 0, out = []) {
  if (!Array.isArray(children)) return out;
  for (const child of children) {
    if (out.length >= MAX_COMMENTS) break;
    if (!child || child.type !== 'comment' || !child.text) continue;
    out.push({
      id: child.id != null ? String(child.id) : null,
      body: truncate(cleanupText(child.text), MAX_COMMENT_LENGTH),
      score: child.points ?? 0,
      author: child.author || '[deleted]',
      depth
    });
    if (child.children?.length) flattenComments(child.children, depth + 1, out);
  }
  return out;
}

function itemToThread(item) {
  const comments = flattenComments(item.children || []);
  return {
    url: `https://news.ycombinator.com/item?id=${item.id}`,
    postId: String(item.id),
    title: cleanupText(item.title || ''),
    selftext: truncate(cleanupText(item.text || ''), 2000),
    upvotes: item.points ?? 0,
    commentCount: comments.length,
    comments,
    strategy: 'algolia'
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  apiCalls++;
  return res.json();
}

async function searchHN(query, maxThreads = 3) {
  const searchUrl = `${HN_SEARCH_URL}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;
  const data = await fetchJson(searchUrl);

  const candidates = (data.hits || [])
    .filter(hit => (hit.num_comments || 0) > 0)
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, maxThreads);

  const threads = [];
  for (const hit of candidates) {
    const id = hit.objectID;
    const cached = hnCache.get(id);
    if (cached) {
      threads.push(cached);
      continue;
    }
    log(`HN thread: ${truncate(hit.title || id, 70)}`);
    try {
      const item = await fetchJson(`${HN_ITEM_URL}/${id}`);
      const thread = itemToThread(item);
      if (thread.commentCount > 0) {
        hnCache.set(id, thread);
        threads.push(thread);
      }
    } catch (err) {
      log(`HN item ${id} failed: ${err.message}`);
    }
  }

  return { threads };
}

function getHNApiCalls() {
  return apiCalls;
}

function resetHNApiCalls() {
  apiCalls = 0;
}

module.exports = { searchHN, itemToThread, flattenComments, getHNApiCalls, resetHNApiCalls };
