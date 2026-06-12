'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

const { parseDDGHtml } = require('../lib/search.js');
const { parseCommentTree, parseOldRedditHtml, extractRedditIds } = require('../lib/reddit.js');

const FIXTURES = join(__dirname, 'fixtures');

// --- parseDDGHtml ---

test('parseDDGHtml: parses result blocks, unwraps uddg redirects, decodes entities', () => {
  const html = readFileSync(join(FIXTURES, 'ddg-results.html'), 'utf8');
  const results = parseDDGHtml(html);

  assert.equal(results.length, 2, 'block without result__a anchor must be skipped');

  assert.equal(
    results[0].url,
    'https://www.reddit.com/r/Supplements/comments/abc123/best_creatine/',
    'uddg redirect must be unwrapped'
  );
  assert.equal(results[0].title, 'Best creatine brand? : r/Supplements');
  assert.equal(results[0].source, 'www.reddit.com');
  assert.match(results[0].snippet, /I've been using/, 'entities must be decoded');
  assert.match(results[0].snippet, /Nutricost creatine for 6 months & it dissolves well/);

  assert.equal(results[1].url, 'https://labdoor.com/review/nutricost-creatine');
  assert.match(results[1].title, /Review & Ranking/);
  assert.match(results[1].snippet, /"Grade A" rating/);
});

test('parseDDGHtml: empty or junk HTML yields empty array', () => {
  assert.deepEqual(parseDDGHtml(''), []);
  assert.deepEqual(parseDDGHtml('<html><body>nothing here</body></html>'), []);
});

// --- parseCommentTree ---

test('parseCommentTree: parses nested comments, skips AutoModerator/empty/more', () => {
  const listing = JSON.parse(readFileSync(join(FIXTURES, 'reddit-thread.json'), 'utf8'));
  const comments = parseCommentTree(listing[1].data.children);

  assert.equal(comments.length, 2, 'AutoModerator, empty-body, and "more" entries skipped');

  assert.equal(comments[0].id, 'c1');
  assert.equal(comments[0].score, 412);
  assert.equal(comments[0].depth, 0);
  assert.match(comments[0].body, /dissolves instantly/);

  assert.equal(comments[1].id, 'c2');
  assert.equal(comments[1].depth, 1, 'reply must carry incremented depth');
  assert.match(comments[1].body, /switched from BulkSupplements/);
});

test('parseCommentTree: non-array input yields empty array', () => {
  assert.deepEqual(parseCommentTree(null), []);
  assert.deepEqual(parseCommentTree(undefined), []);
});

// --- parseOldRedditHtml ---

test('parseOldRedditHtml: extracts title, selftext, and scored comments', () => {
  const html = [
    '<html><body>',
    '<a class="title may-blank" href="/r/Supplements/comments/abc123/">Best creatine brand?</a>',
    '<div class="md"><p>Looking for one that dissolves well.</p></div>',
    '<div class="thing comment">',
    '  <div class="md"><p>Nutricost dissolves instantly, zero grit in my shaker.</p></div>',
    '  <span class="score unvoted" title="42 points">42 points</span>',
    '</div>',
    '</body></html>'
  ].join('\n');

  const result = parseOldRedditHtml(html, { subreddit: 'Supplements', postId: 'abc123' });

  assert.equal(result.title, 'Best creatine brand?');
  assert.match(result.selftext, /dissolves well/);
  assert.equal(result.strategy, 'old-reddit');
  assert.equal(result.commentCount, 1);
  assert.equal(result.comments[0].score, 42);
  assert.match(result.comments[0].body, /zero grit/);
});

// --- extractRedditIds ---

test('extractRedditIds: parses thread URLs and rejects non-thread URLs', () => {
  assert.deepEqual(
    extractRedditIds('https://www.reddit.com/r/Supplements/comments/abc123/best_creatine/'),
    { subreddit: 'Supplements', postId: 'abc123' }
  );
  assert.equal(extractRedditIds('https://www.reddit.com/r/Supplements/'), null);
  assert.equal(extractRedditIds('https://example.com/'), null);
});
