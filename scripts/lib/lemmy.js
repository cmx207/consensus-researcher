#!/usr/bin/env node
'use strict';

/**
 * Lemmy (lemmy.world) — open JSON API, no auth. Reddit-style discussion
 * redundancy. Low volume, so deep mode only.
 *
 * Search:   /api/v3/search?q=...&type_=Posts&sort=TopAll
 * Comments: /api/v3/comment/list?post_id=...&sort=Top
 */

const { createFileCache } = require('./cache');

const LEMMY_BASE = 'https://lemmy.world';
const MAX_COMMENT_LENGTH = 1000;

const lemmyCache = createFileCache({
  dir: 'data/lemmy-cache',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  label: 'lemmy'
});

function log(msg) {
  process.stderr.write(`[lemmy] ${msg}\n`);
}

function cleanupText(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : `${str.slice(0, max)}...`;
}

function toThread(postView, commentViews) {
  const comments = (commentViews || [])
    .filter(view => view?.comment?.content && !view.comment.deleted && !view.comment.removed)
    .map(view => ({
      id: String(view.comment.id),
      body: truncate(cleanupText(view.comment.content), MAX_COMMENT_LENGTH),
      score: view.counts?.score ?? 0,
      author: view.creator?.name || '[unknown]',
      depth: Math.max((view.comment.path || '0').split('.').length - 2, 0)
    }))
    .sort((a, b) => b.score - a.score);

  return {
    url: postView.post.ap_id || `${LEMMY_BASE}/post/${postView.post.id}`,
    postId: String(postView.post.id),
    title: cleanupText(postView.post.name || ''),
    selftext: truncate(cleanupText(postView.post.body || ''), 2000),
    upvotes: postView.counts?.score ?? 0,
    commentCount: comments.length,
    comments,
    strategy: 'lemmy-api'
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function searchLemmy(query, maxThreads = 3) {
  const searchUrl = `${LEMMY_BASE}/api/v3/search?q=${encodeURIComponent(query)}&type_=Posts&sort=TopAll&limit=10`;
  const data = await fetchJson(searchUrl);

  const candidates = (data.posts || [])
    .filter(view => (view.counts?.comments || 0) > 0)
    .sort((a, b) => (b.counts?.score || 0) - (a.counts?.score || 0))
    .slice(0, maxThreads);

  const threads = [];
  for (const postView of candidates) {
    const id = postView.post.id;
    const cached = lemmyCache.get(`post-${id}`);
    if (cached) {
      threads.push(cached);
      continue;
    }
    log(`Lemmy thread: ${cleanupText(postView.post.name).slice(0, 70)}`);
    try {
      const commentData = await fetchJson(`${LEMMY_BASE}/api/v3/comment/list?post_id=${id}&sort=Top&limit=50`);
      const thread = toThread(postView, commentData.comments || []);
      if (thread.commentCount > 0) {
        lemmyCache.set(`post-${id}`, thread);
        threads.push(thread);
      }
    } catch (err) {
      log(`Lemmy post ${id} failed: ${err.message}`);
    }
  }

  return { threads };
}

module.exports = { searchLemmy, toThread };
