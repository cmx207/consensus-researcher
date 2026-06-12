'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { itemToThread, flattenComments } = require('../lib/hn.js');
const { toThread: lemmyToThread } = require('../lib/lemmy.js');
const { discourseTopicToThread, discourseJsonUrl, CATEGORY_FORUMS } = require('../lib/forums.js');
const { buildBundle } = require('../lib/bundle.js');

// --- HackerNews (Algolia) ---

const ALGOLIA_ITEM = {
  id: 38000000,
  type: 'story',
  title: 'Show HN: Cursor IDE',
  text: 'An AI-first code editor.',
  points: 512,
  children: [
    {
      id: 1, type: 'comment', author: 'dev1', points: null,
      text: '<p>Switched from VS Code and the refactoring is <i>much</i> faster.</p>',
      children: [
        { id: 2, type: 'comment', author: 'dev2', points: null, text: '<p>Agreed, but it crashes on large monorepos.</p>', children: [] }
      ]
    },
    { id: 3, type: 'comment', author: 'dev3', points: null, text: '', children: [] },
    { id: 4, type: 'poll', author: 'x', text: 'not a comment', children: [] }
  ]
};

test('hn itemToThread: maps Algolia item to thread shape, strips HTML, keeps depth', () => {
  const thread = itemToThread(ALGOLIA_ITEM);
  assert.equal(thread.postId, '38000000');
  assert.equal(thread.url, 'https://news.ycombinator.com/item?id=38000000');
  assert.equal(thread.upvotes, 512);
  assert.equal(thread.commentCount, 2, 'empty-text and non-comment children skipped');
  assert.equal(thread.comments[0].body, 'Switched from VS Code and the refactoring is much faster.');
  assert.equal(thread.comments[0].depth, 0);
  assert.equal(thread.comments[1].depth, 1);
  assert.equal(thread.strategy, 'algolia');
});

test('hn flattenComments: non-array input yields empty array', () => {
  assert.deepEqual(flattenComments(null), []);
});

// --- Lemmy ---

test('lemmy toThread: maps post + comment views, sorts by score, computes depth', () => {
  const postView = {
    post: { id: 99, name: 'Best creatine?', body: 'Looking for recs.', ap_id: 'https://lemmy.world/post/99' },
    counts: { score: 40, comments: 2 }
  };
  const commentViews = [
    { comment: { id: 1, content: 'Nutricost is solid.', path: '0.1', deleted: false, removed: false }, counts: { score: 5 }, creator: { name: 'u1' } },
    { comment: { id: 2, content: 'Disagree, clumps badly.', path: '0.1.2', deleted: false, removed: false }, counts: { score: 12 }, creator: { name: 'u2' } },
    { comment: { id: 3, content: 'removed', path: '0.3', deleted: true, removed: false }, counts: { score: 99 }, creator: { name: 'u3' } }
  ];

  const thread = lemmyToThread(postView, commentViews);
  assert.equal(thread.postId, '99');
  assert.equal(thread.commentCount, 2, 'deleted comments skipped');
  assert.equal(thread.comments[0].body, 'Disagree, clumps badly.', 'sorted by score desc');
  assert.equal(thread.comments[0].depth, 1);
  assert.equal(thread.comments[1].depth, 0);
  assert.equal(thread.strategy, 'lemmy-api');
});

// --- Forums (Discourse) ---

test('discourseJsonUrl: converts topic URLs, rejects non-topic URLs', () => {
  assert.equal(
    discourseJsonUrl('https://forum.examine.com/t/creatine-brands/12345'),
    'https://forum.examine.com/t/12345.json'
  );
  assert.equal(
    discourseJsonUrl('https://forum.examine.com/t/12345'),
    'https://forum.examine.com/t/12345.json'
  );
  assert.equal(discourseJsonUrl('https://forum.examine.com/c/supplements'), null);
  assert.equal(discourseJsonUrl('not a url'), null);
});

test('discourseTopicToThread: first post becomes selftext, replies become comments', () => {
  const topic = {
    id: 12345,
    title: 'Creatine brand recommendations',
    like_count: 9,
    post_stream: {
      posts: [
        { id: 1, username: 'op', cooked: '<p>Which brand do you trust?</p>', like_count: 2 },
        { id: 2, username: 'vet', cooked: '<p>Been using <b>Nutricost</b> for 3 years, third party tested.</p>', like_count: 14, reply_to_post_number: null },
        { id: 3, username: 'skeptic', cooked: '<p>Their COA links are dead though.</p>', like_count: 6, reply_to_post_number: 2 }
      ]
    }
  };

  const thread = discourseTopicToThread(topic, 'https://forum.examine.com/t/creatine-brands/12345');
  assert.equal(thread.postId, '12345');
  assert.match(thread.selftext, /Which brand do you trust/);
  assert.equal(thread.commentCount, 2);
  assert.equal(thread.comments[0].body, 'Been using Nutricost for 3 years, third party tested.');
  assert.equal(thread.comments[0].score, 14);
  assert.equal(thread.comments[1].depth, 1);
  assert.equal(thread.strategy, 'discourse');
});

test('CATEGORY_FORUMS: every mapped category has at least one forum or is deliberately empty', () => {
  assert.ok(CATEGORY_FORUMS.supplement.length > 0);
  assert.ok(CATEGORY_FORUMS.tech.length > 0);
  assert.deepEqual(CATEGORY_FORUMS.software, [], 'software is HN territory by design');
});

// --- Bundle integration ---

test('buildBundle: hn/forum/lemmy threads and full pages become first-class sources', () => {
  const raw = {
    query: 'cursor ide',
    category: 'software',
    depth: 'standard',
    timestamp: '2026-06-11T00:00:00.000Z',
    reddit: { threads: [] },
    amazon: { products: [] },
    web: {
      results: [
        { title: 'Review', url: 'https://thereg.com/cursor', snippet: 's', source: 'thereg.com', age: null }
      ]
    },
    youtube: { results: [] },
    twitter: { results: [] },
    github: { repos: [] },
    hn: { threads: [itemToThread(ALGOLIA_ITEM)] },
    forums: { threads: [], pages: [{ url: 'https://forum.x.com/t/1', title: 'Forum page', text: 'long text '.repeat(20) }] },
    lemmy: { threads: [] },
    pages: [{ url: 'https://thereg.com/cursor', title: 'Full review', text: 'article body '.repeat(30) }],
    sourceCount: { reddit: 0, amazon: 0, web: 1, youtube: 0, twitter: 0, github: 0, hn: 1, forum: 1, lemmy: 0, pages: 1 },
    dataSufficiency: 'MEDIUM',
    apiCost: { braveCalls: 0, ddgCalls: 2, redditCalls: 0, totalCalls: 2, estimatedUSD: 0, searchProvider: 'ddg' }
  };

  const bundle = buildBundle(raw, [], []);
  const platforms = bundle.sources.map(s => `${s.platform}:${s.kind}`);
  assert.ok(platforms.includes('hn:thread'));
  assert.ok(platforms.includes('forum:page'));
  assert.ok(platforms.includes('expert:page'));

  const hnSource = bundle.sources.find(s => s.platform === 'hn');
  assert.equal(hnSource.fetchLevel, 'full');
  assert.equal(hnSource.segments.length, 2);

  // The web snippet for thereg.com must NOT suggest an agent fetch — we hold the full page.
  const snippet = bundle.sources.find(s => s.url === 'https://thereg.com/cursor' && s.kind === 'snippet');
  assert.equal(snippet.agentFetchSuggested, false);
});
