#!/usr/bin/env node
'use strict';

/**
 * Niche forums per category. Strategy:
 *   1. Site-scoped search to find threads on mapped forums
 *   2. Discourse detection — if the forum runs Discourse, /t/<id>.json
 *      gives full structured posts (the reliable win)
 *   3. Otherwise fall back to a generic page fetch (best-effort text)
 *
 * Tier 2 signal (MEDIUM-HIGH): enthusiast communities with real long-term
 * owners, but smaller samples than Reddit/HN.
 */

const { search } = require('./search');
const { fetchPage } = require('./fetchpage');
const { createFileCache } = require('./cache');

const MAX_POST_LENGTH = 1000;
const MAX_POSTS = 50;

const CATEGORY_FORUMS = {
  supplement: ['longecity.org', 'forum.examine.com'],
  tech: ['head-fi.org', 'audiosciencereview.com', 'forums.tomshardware.com'],
  product: ['garagejournal.com', 'budgetlightforum.com'],
  software: [] // HN covers software discussion better than any single forum
};

const forumCache = createFileCache({
  dir: 'data/forum-cache',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  label: 'forums'
});

function log(msg) {
  process.stderr.write(`[forums] ${msg}\n`);
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
 * Map a Discourse /t/<id>.json topic to the shared thread shape.
 */
function discourseTopicToThread(topicJson, url) {
  const posts = (topicJson.post_stream?.posts || [])
    .filter(post => post.cooked)
    .slice(0, MAX_POSTS);

  // Post #1 is the topic body; the rest are replies.
  const [first, ...rest] = posts;
  const comments = rest.map(post => ({
    id: String(post.id),
    body: truncate(cleanupText(post.cooked), MAX_POST_LENGTH),
    score: post.like_count ?? 0,
    author: post.username || '[unknown]',
    depth: post.reply_to_post_number ? 1 : 0
  }));

  return {
    url,
    postId: String(topicJson.id),
    title: cleanupText(topicJson.title || ''),
    selftext: first ? truncate(cleanupText(first.cooked), 2000) : '',
    upvotes: topicJson.like_count ?? first?.like_count ?? 0,
    commentCount: comments.length,
    comments,
    strategy: 'discourse'
  };
}

/**
 * Discourse topic URLs look like /t/<slug>/<id> — convert to /t/<id>.json.
 */
function discourseJsonUrl(threadUrl) {
  try {
    const url = new URL(threadUrl);
    const match = url.pathname.match(/\/t\/[^/]+\/(\d+)/) || url.pathname.match(/\/t\/(\d+)/);
    if (!match) return null;
    return `${url.origin}/t/${match[1]}.json`;
  } catch {
    return null;
  }
}

async function tryDiscourse(threadUrl) {
  const jsonUrl = discourseJsonUrl(threadUrl);
  if (!jsonUrl) return null;

  try {
    const res = await fetch(jsonUrl, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;
    const topic = await res.json();
    if (!topic.post_stream) return null;
    return discourseTopicToThread(topic, threadUrl);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{threads: [], pages: []}>} threads = Discourse full posts,
 * pages = best-effort plain-text fallbacks.
 */
async function searchForums(query, category, maxResults = 2, fetchLog = null) {
  const forums = CATEGORY_FORUMS[category] || [];
  if (forums.length === 0) return { threads: [], pages: [] };

  const siteScope = forums.map(site => `site:${site}`).join(' OR ');
  const { results } = await search(`${query} (${siteScope})`, 5);

  const threads = [];
  const pages = [];

  for (const result of (results || []).slice(0, maxResults)) {
    const cached = forumCache.get(result.url);
    if (cached) {
      if (cached.kind === 'thread') threads.push(cached.data);
      else pages.push(cached.data);
      continue;
    }

    log(`Forum: ${truncate(result.title, 70)}`);

    const thread = await tryDiscourse(result.url);
    if (thread && thread.commentCount > 0) {
      forumCache.set(result.url, { kind: 'thread', data: thread });
      threads.push(thread);
      continue;
    }

    const page = await fetchPage(result.url);
    if (page.ok) {
      const pageData = { url: result.url, title: page.title || result.title, text: page.text };
      forumCache.set(result.url, { kind: 'page', data: pageData });
      pages.push(pageData);
    } else {
      log(`Forum page failed: ${result.url} — ${page.error}`);
      fetchLog?.record({ platform: 'forum', stage: 'fetch', url: result.url, ok: false, error: page.error });
    }
  }

  return { threads, pages };
}

module.exports = { searchForums, discourseTopicToThread, discourseJsonUrl, CATEGORY_FORUMS };
