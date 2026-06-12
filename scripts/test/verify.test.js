'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeForMatch,
  exactMatch,
  fuzzyMatch,
  fuzzyMatchRatio,
  verifyClaims
} = require('../lib/verify.js');
const { exportTaxonomy } = require('../lib/taxonomy.js');

function fixtureBundle() {
  return {
    schema: 'consensus-research/collect/v1',
    query: 'creatine monohydrate',
    category: 'supplement',
    taxonomy: exportTaxonomy('supplement'),
    sources: [
      {
        id: 'src_001',
        platform: 'reddit',
        kind: 'thread',
        fetchLevel: 'full',
        url: 'https://www.reddit.com/r/Supplements/comments/abc123/',
        title: 'Best creatine brand?',
        text: 'Best creatine brand? Looking for one that dissolves well.',
        segments: [
          {
            id: 'c0',
            text: 'Nutricost dissolves instantly in water, no gritty texture at all.',
            score: 412,
            scoreKind: 'upvotes'
          },
          {
            id: 'c1',
            text: 'Nutricost gave me stomach cramps every morning until I stopped taking it.',
            score: 88,
            scoreKind: 'upvotes'
          }
        ],
        meta: { subreddit: 'Supplements', upvotes: 230 }
      },
      {
        id: 'src_002',
        platform: 'amazon',
        kind: 'snippet',
        fetchLevel: 'snippet',
        url: 'https://amazon.com/dp/B00X',
        title: 'Nutricost Creatine Monohydrate 500g',
        text: 'Nutricost Creatine Monohydrate 500g. 4.6 out of 5 stars. Dissolves easily, third party tested.',
        segments: [],
        meta: { rating: 4.6 }
      }
    ]
  };
}

function mkDoc(claims, externalSources = []) {
  return {
    schema: 'consensus-research/claims/v1',
    query: 'creatine monohydrate',
    category: 'supplement',
    extractor: 'agent',
    claims,
    externalSources
  };
}

// --- normalization / matching primitives ---

test('normalizeForMatch folds smart quotes, dashes, and markdown markers', () => {
  assert.equal(
    normalizeForMatch('It’s **great** — honestly'),
    "it's great - honestly"
  );
});

test('exactMatch is whitespace- and case-insensitive', () => {
  assert.ok(exactMatch('Dissolves   INSTANTLY in water', 'Nutricost dissolves instantly in water, no gritty texture.'));
  assert.ok(!exactMatch('dissolves slowly in water', 'Nutricost dissolves instantly in water.'));
});

test('fuzzyMatch tolerates a dropped filler word but blocks fabrication', () => {
  const source = 'Nutricost dissolves instantly in water, no gritty texture at all.';
  assert.ok(fuzzyMatch('Nutricost dissolves instantly water, no gritty texture', source));
  assert.ok(!fuzzyMatch('pharmaceutical grade purity verified by independent laboratory', source));
});

test('fuzzyMatchRatio requires in-order tokens within a bounded window', () => {
  // Same words, scrambled order — must NOT pass.
  const source = 'texture gritty no water in instantly dissolves Nutricost';
  const ratio = fuzzyMatchRatio('Nutricost dissolves instantly in water no gritty texture', source);
  assert.ok(ratio < 0.85, `scrambled order should fail, got ratio ${ratio}`);
});

// --- verifyClaims ---

test('verifyClaims: exact quote against pinned segment is accepted and rehydrated', () => {
  const { accepted, stats } = verifyClaims(mkDoc([
    {
      brand: 'Nutricost',
      dimension: 'taste',
      polarity: 'positive',
      sourceId: 'src_001',
      segmentId: 'c0',
      quote: 'dissolves instantly in water, no gritty texture'
    }
  ]), fixtureBundle());

  assert.equal(stats.exact, 1);
  assert.equal(accepted.length, 1);
  const claim = accepted[0];
  assert.equal(claim.sourceType, 'reddit');
  assert.equal(claim.sourceId, 'src_001#c0');
  assert.equal(claim.independentSourceId, 'src_001');
  assert.equal(claim.subreddit, 'r/Supplements');
  assert.equal(claim.score, 412);
  assert.equal(claim.scoreKind, 'upvotes');
  assert.equal(claim.verification, 'exact');
  assert.equal(claim.url, 'https://www.reddit.com/r/Supplements/comments/abc123/');
});

test('verifyClaims: wrong segmentId recovers via scan of all segments', () => {
  const { accepted, stats } = verifyClaims(mkDoc([
    {
      brand: 'Nutricost',
      dimension: 'side-effects',
      polarity: 'negative',
      sourceId: 'src_001',
      segmentId: 'c0', // wrong — quote lives in c1
      quote: 'gave me stomach cramps every morning'
    }
  ]), fixtureBundle());

  assert.equal(stats.exact, 1);
  assert.equal(accepted[0].sourceId, 'src_001#c1');
  assert.equal(accepted[0].score, 88);
});

test('verifyClaims: fabricated quote is rejected with reason and excluded', () => {
  const { accepted, rejected, stats } = verifyClaims(mkDoc([
    {
      brand: 'Nutricost',
      dimension: 'purity',
      polarity: 'positive',
      sourceId: 'src_002',
      quote: 'pharmaceutical grade purity verified by independent Swiss laboratory'
    }
  ]), fixtureBundle());

  assert.equal(accepted.length, 0);
  assert.equal(stats.rejected, 1);
  assert.match(rejected[0].reason, /quote not found/);
});

test('verifyClaims: unknown sourceId and short quote are rejected', () => {
  const { rejected, stats } = verifyClaims(mkDoc([
    { brand: 'X', dimension: 'value', polarity: 'positive', sourceId: 'src_999', quote: 'this is a long enough quote to check' },
    { brand: 'X', dimension: 'value', polarity: 'positive', sourceId: 'src_001', quote: 'great stuff' }
  ]), fixtureBundle());

  assert.equal(stats.rejected, 2);
  assert.match(rejected[0].reason, /unknown sourceId/);
  assert.match(rejected[1].reason, /quote too short/);
});

test('verifyClaims: invalid dimension coerced to "other", invalid polarity to "mixed"', () => {
  const { accepted, warnings } = verifyClaims(mkDoc([
    {
      brand: 'Nutricost',
      dimension: 'smoothness',
      polarity: 'glowing',
      sourceId: 'src_002',
      quote: 'Dissolves easily, third party tested'
    }
  ]), fixtureBundle());

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].dimension, 'other');
  assert.equal(accepted[0].polarity, 'mixed');
  assert.equal(warnings.length, 2);
});

test('verifyClaims: external source quotes are attested, never exact', () => {
  const { accepted, stats } = verifyClaims(mkDoc(
    [{
      brand: 'Nutricost',
      dimension: 'testing',
      polarity: 'positive',
      sourceId: 'ext_001',
      quote: 'passed all heavy metal screening with top marks'
    }],
    [{
      id: 'ext_001',
      url: 'https://labdoor.com/review/nutricost',
      platform: 'expert',
      fetchedText: 'In our lab analysis, Nutricost passed all heavy metal screening with top marks.'
    }]
  ), fixtureBundle());

  assert.equal(stats.attested, 1);
  assert.equal(stats.exact, 0);
  assert.equal(accepted[0].verification, 'attested');
  assert.equal(accepted[0].sourceType, 'expert');
});

test('verifyClaims: rejects malformed claims doc loudly', () => {
  assert.throws(() => verifyClaims({ schema: 'wrong/v0', claims: [] }, fixtureBundle()), /Invalid claims doc/);
  assert.throws(() => verifyClaims({ schema: 'consensus-research/claims/v1' }, fixtureBundle()), /claims\[\]/);
});
