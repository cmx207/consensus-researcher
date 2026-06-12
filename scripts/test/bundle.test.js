'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBundle, validateBundle, appendSource, htmlToText, getSource } = require('../lib/bundle.js');

function fixtureRaw() {
  return {
    query: 'creatine monohydrate',
    category: 'supplement',
    depth: 'standard',
    timestamp: '2026-06-11T00:00:00.000Z',
    location: null,
    reddit: {
      threads: [
        {
          url: 'https://www.reddit.com/r/Supplements/comments/abc123/',
          postId: 'abc123',
          title: 'Best creatine brand?',
          selftext: 'Looking for one that dissolves well.',
          subreddit: 'Supplements',
          upvotes: 230,
          commentCount: 2,
          comments: [
            { id: 'k1', body: 'Nutricost dissolves instantly.', score: 412, author: 'a', depth: 0 },
            { id: 'k2', body: 'Gave me stomach cramps.', score: 88, author: 'b', depth: 1 }
          ],
          strategy: 'json'
        }
      ],
      totalComments: 2
    },
    amazon: {
      products: [
        {
          title: 'Nutricost Creatine 500g',
          url: 'https://amazon.com/dp/B00X',
          rating: 4.6,
          reviewCount: 2847,
          price: 15.99,
          snippet: 'Third party tested.'
        }
      ]
    },
    web: {
      results: [
        { title: 'Creatine review - Examine', url: 'https://examine.com/creatine', snippet: 'Evidence-based.', source: 'examine.com', age: null },
        { title: 'Labdoor ranking', url: 'https://labdoor.com/creatine', snippet: 'Lab tested.', source: 'labdoor.com', age: null },
        { title: 'ConsumerLab', url: 'https://consumerlab.com/creatine', snippet: 'Tested.', source: 'consumerlab.com', age: null },
        { title: 'Fourth expert', url: 'https://wirecutter.com/creatine', snippet: 'Reviewed.', source: 'wirecutter.com', age: null },
        { title: 'HN thread', url: 'https://news.ycombinator.com/item?id=1', snippet: 'Discussion.', source: 'news.ycombinator.com', age: null }
      ]
    },
    youtube: { results: [] },
    twitter: { results: [] },
    github: { repos: [] },
    sourceCount: { reddit: 1, amazon: 1, web: 5, youtube: 0, twitter: 0, github: 0 },
    dataSufficiency: 'MEDIUM',
    apiCost: { braveCalls: 3, ddgCalls: 0, redditCalls: 1, totalCalls: 4, estimatedUSD: 0.015, searchProvider: 'brave' }
  };
}

test('buildBundle: maps raw into ID-addressed sources with segments', () => {
  const bundle = buildBundle(fixtureRaw(), [{ platform: 'web', stage: 'search', ok: true }], ['Nutricost']);

  validateBundle(bundle);
  assert.equal(bundle.schema, 'consensus-research/collect/v1');
  assert.equal(bundle.sources.length, 7); // 1 reddit + 1 amazon + 5 web
  assert.equal(bundle.sources[0].id, 'src_001');
  assert.equal(bundle.sources[0].platform, 'reddit');
  assert.equal(bundle.sources[0].fetchLevel, 'full');
  assert.equal(bundle.sources[0].segments.length, 2);
  assert.equal(bundle.sources[0].segments[0].id, 'c0');
  assert.equal(bundle.sources[0].segments[0].score, 412);
  assert.equal(bundle.sources[0].meta.subreddit, 'Supplements');

  const amazon = bundle.sources.find(s => s.platform === 'amazon');
  assert.equal(amazon.fetchLevel, 'snippet');
  assert.equal(amazon.meta.rating, 4.6);

  assert.ok(bundle.taxonomy.dimensions.includes('side-effects'));
  assert.deepEqual(bundle.entities.seeds, ['Nutricost']);
  assert.equal(bundle.fetchLog.length, 1);
  assert.equal(bundle.raw.query, 'creatine monohydrate');
});

test('buildBundle: suggests agent fetch for top 3 expert results only, never HN', () => {
  const bundle = buildBundle(fixtureRaw(), [], []);
  const suggested = bundle.sources.filter(s => s.agentFetchSuggested);
  assert.equal(suggested.length, 3);
  assert.ok(suggested.every(s => s.platform === 'expert'));
  const hn = bundle.sources.find(s => s.platform === 'hn');
  assert.ok(hn, 'HN result must be classified as hn platform');
  assert.equal(hn.agentFetchSuggested, false);
});

test('validateBundle: rejects malformed bundles loudly', () => {
  assert.throws(() => validateBundle({ schema: 'nope' }), /Invalid bundle/);
  assert.throws(() => validateBundle(null), /Invalid bundle/);
});

test('htmlToText: strips scripts/styles/nav and decodes entities', () => {
  const html = [
    '<html><head><style>.x{color:red}</style><script>alert(1)</script></head>',
    '<body><nav>Menu Home About</nav>',
    '<p>It&#x27;s a &quot;great&quot; product &amp; works.</p>',
    '<div>Second block</div>',
    '</body></html>'
  ].join('');
  const text = htmlToText(html);
  assert.ok(!text.includes('alert(1)'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('Menu Home'));
  assert.match(text, /It's a "great" product & works\./);
  assert.match(text, /Second block/);
});

test('appendSource: adds verifiable page source and clears agentFetchSuggested twin', () => {
  const bundle = buildBundle(fixtureRaw(), [], []);
  const twin = bundle.sources.find(s => s.agentFetchSuggested);
  const longBody = '<p>' + 'Real article content about creatine quality. '.repeat(10) + '</p>';

  const source = appendSource(bundle, { url: twin.url, title: 'Examine deep dive', html: longBody });

  assert.equal(source.kind, 'page');
  assert.equal(source.fetchLevel, 'full');
  assert.ok(source.text.length > 100);
  assert.equal(getSource(bundle, source.id), source);
  assert.equal(twin.agentFetchSuggested, false, 'snippet twin no longer needs agent fetch');
});

test('appendSource: refuses pages with no usable text', () => {
  const bundle = buildBundle(fixtureRaw(), [], []);
  assert.throws(
    () => appendSource(bundle, { url: 'https://x.com/y', html: '<script>only js</script>' }),
    /no usable text/
  );
});
