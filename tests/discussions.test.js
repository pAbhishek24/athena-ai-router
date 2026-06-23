const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiscussionSuggestion, buildDiscussionsBoardUrl } = require('../src/discussions');

test('buildDiscussionsBoardUrl normalizes the repository url', () => {
  assert.equal(
    buildDiscussionsBoardUrl('git@github.com:pAbhishek24/athena-ai-router.git'),
    'https://github.com/pAbhishek24/athena-ai-router/discussions'
  );
});

test('buildDiscussionSuggestion creates a compact starter', () => {
  const suggestion = buildDiscussionSuggestion('How should we scope account-wide usage cards?', {
    command: 'model-router discuss',
    cwd: '/Users/ritikapandey/workspace/athena-ai-router',
    packageVersion: '1.0.1',
    platform: 'darwin',
    release: '25.5.0',
    arch: 'arm64',
    nodeVersion: 'v22.16.0',
  });

  assert.equal(suggestion.title, 'How should we scope account-wide usage cards?');
  assert.match(suggestion.body, /## Context/);
  assert.match(suggestion.body, /AI Model Router version: 1.0.1/);
});
