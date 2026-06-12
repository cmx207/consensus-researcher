'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { mkdtempSync, writeFileSync, readFileSync } = require('fs');
const { join, resolve } = require('path');
const { tmpdir } = require('os');

const { buildBundle, saveBundle } = require('../lib/bundle.js');

const REPO_ROOT = resolve(__dirname, '..', '..');
const RESEARCH_JS = join(REPO_ROOT, 'scripts', 'research.js');

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
            { id: 'k1', body: 'Nutricost dissolves instantly in water, no gritty texture at all.', score: 412, author: 'a', depth: 0 },
            { id: 'k2', body: 'Nutricost gave me stomach cramps every morning until I stopped taking it.', score: 88, author: 'b', depth: 0 }
          ],
          strategy: 'json'
        }
      ],
      totalComments: 2
    },
    amazon: {
      products: [
        {
          title: 'Nutricost Creatine Monohydrate 500g',
          url: 'https://amazon.com/dp/B00X',
          rating: 4.6,
          reviewCount: 2847,
          price: 15.99,
          snippet: 'Dissolves easily, third party tested.'
        }
      ]
    },
    web: {
      results: [
        {
          title: 'Nutricost creatine review',
          url: 'https://examine.com/creatine',
          snippet: 'Nutricost creatine is excellent value at $0.13 per serving.',
          source: 'examine.com',
          age: null
        }
      ]
    },
    youtube: { results: [] },
    twitter: { results: [] },
    github: { repos: [] },
    sourceCount: { reddit: 1, amazon: 1, web: 1, youtube: 0, twitter: 0, github: 0 },
    dataSufficiency: 'MEDIUM',
    apiCost: { braveCalls: 3, ddgCalls: 0, redditCalls: 1, totalCalls: 4, estimatedUSD: 0.015, searchProvider: 'brave' }
  };
}

function runCli(args) {
  return execFileSync(process.execPath, [RESEARCH_JS, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-test-'));
  const bundlePath = join(dir, 'bundle.json');
  saveBundle(buildBundle(fixtureRaw(), [], ['Nutricost']), bundlePath);
  return { dir, bundlePath };
}

test('score: verified agent claims produce v6 structured output with stamp', () => {
  const { dir, bundlePath } = setup();
  const claimsPath = join(dir, 'claims-good.json');
  writeFileSync(claimsPath, JSON.stringify({
    schema: 'consensus-research/claims/v1',
    query: 'creatine monohydrate',
    category: 'supplement',
    extractor: 'agent',
    extractorModel: 'test-model',
    claims: [
      { brand: 'Nutricost', dimension: 'taste', polarity: 'positive', sourceId: 'src_001', segmentId: 'c0', quote: 'dissolves instantly in water, no gritty texture' },
      { brand: 'Nutricost', dimension: 'side-effects', polarity: 'negative', sourceId: 'src_001', segmentId: 'c1', quote: 'gave me stomach cramps every morning' },
      { brand: 'Nutricost', dimension: 'value', polarity: 'positive', sourceId: 'src_003', quote: 'excellent value at $0.13 per serving' },
      { brand: 'Nutricost', dimension: 'testing', polarity: 'positive', sourceId: 'src_002', quote: 'Dissolves easily, third party tested' }
    ]
  }), 'utf8');

  const stdout = runCli(['score', claimsPath, '--bundle', bundlePath]);
  const structured = JSON.parse(stdout);

  assert.equal(structured.schemaVersion, 6);
  assert.equal(structured.extractor, 'agent');
  assert.equal(structured.extractorModel, 'test-model');
  assert.equal(structured.verification.stats.total, 4);
  assert.equal(structured.verification.stats.rejected, 0);
  assert.ok(structured.verification.stats.exact >= 3);
  assert.ok(structured.draftScore.brandScores['Nutricost'] != null);
  assert.match(structured.stamp, /^\[OK\] Verified/);
  assert.match(structured.stamp, /extractor: agent/);
});

test('score: fabricated claims are rejected and stamp degrades', () => {
  const { dir, bundlePath } = setup();
  const claimsPath = join(dir, 'claims-fabricated.json');
  writeFileSync(claimsPath, JSON.stringify({
    schema: 'consensus-research/claims/v1',
    query: 'creatine monohydrate',
    category: 'supplement',
    extractor: 'agent',
    claims: [
      { brand: 'Nutricost', dimension: 'purity', polarity: 'positive', sourceId: 'src_002', quote: 'pharmaceutical grade purity verified by independent Swiss laboratory' },
      { brand: 'Nutricost', dimension: 'value', polarity: 'positive', sourceId: 'src_999', quote: 'this is a long enough quote referencing nothing' }
    ]
  }), 'utf8');

  const stdout = runCli(['score', claimsPath, '--bundle', bundlePath]);
  const structured = JSON.parse(stdout);

  assert.equal(structured.verification.stats.rejected, 2);
  assert.equal(structured.verification.rejected.length, 2);
  assert.match(structured.stamp, /^\[FAIL\] Incomplete/);
  assert.equal(Object.keys(structured.draftScore.brandScores).length, 0, 'no claims survive, no scores');
});

test('score --format json: v6 JSON keeps all v5 fields and adds verification', () => {
  const { dir, bundlePath } = setup();
  const claimsPath = join(dir, 'claims-min.json');
  writeFileSync(claimsPath, JSON.stringify({
    schema: 'consensus-research/claims/v1',
    extractor: 'agent',
    claims: [
      { brand: 'Nutricost', dimension: 'taste', polarity: 'positive', sourceId: 'src_001', segmentId: 'c0', quote: 'dissolves instantly in water, no gritty texture' }
    ]
  }), 'utf8');

  const stdout = runCli(['score', claimsPath, '--bundle', bundlePath, '--format', 'json']);
  const v6 = JSON.parse(stdout);

  // v5 compatibility surface
  for (const key of ['schema', 'meta', 'verdict', 'claims', 'brands', 'alternatives', 'sourceBreakdown', 'comparison', 'location']) {
    assert.ok(key in v6, `v5 field "${key}" must remain in v6 output`);
  }
  assert.equal(v6.meta.query, 'creatine monohydrate');
  // v6 additions
  assert.equal(v6.extractor, 'agent');
  assert.ok(v6.verification.stats);
  assert.ok(v6.stamp);
});

test('extract → score: regex fallback path verifies cleanly end-to-end', () => {
  const { dir, bundlePath } = setup();
  const claimsPath = join(dir, 'claims-regex.json');

  const extractOut = runCli(['extract', bundlePath, '--out', claimsPath]);
  const summary = JSON.parse(extractOut);
  assert.ok(summary.claims > 0, 'regex extractor must find claims in fixture bundle');

  const doc = JSON.parse(readFileSync(claimsPath, 'utf8'));
  assert.equal(doc.extractor, 'regex');

  const stdout = runCli(['score', claimsPath, '--bundle', bundlePath]);
  const structured = JSON.parse(stdout);
  assert.equal(structured.extractor, 'regex');
  assert.equal(structured.verification.stats.rejected, 0, 'regex quotes are copied from source text — must all verify');
});
