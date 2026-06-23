const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFeedbackBody, buildFeedbackIssueUrl, getRepositoryWebUrl, normalizeFeedbackType } = require('../src/feedback');

test('normalizeFeedbackType maps aliases to supported templates', () => {
  assert.equal(normalizeFeedbackType('bug'), 'bug');
  assert.equal(normalizeFeedbackType('feature'), 'feature');
  assert.equal(normalizeFeedbackType('issue'), 'general');
  assert.equal(normalizeFeedbackType('unknown'), 'general');
});

test('getRepositoryWebUrl converts git urls into a browser url', () => {
  assert.equal(
    getRepositoryWebUrl('git@github.com:pAbhishek24/athena-ai-router.git'),
    'https://github.com/pAbhishek24/athena-ai-router'
  );
});

test('buildFeedbackIssueUrl pre-fills the bug template and context', () => {
  const url = buildFeedbackIssueUrl('bug', 'model-router panel crashed on launch', {
    repositoryUrl: 'https://github.com/pAbhishek24/athena-ai-router.git',
    command: 'model-router feedback bug',
    cwd: '/Users/ritikapandey/workspace/athena-ai-router',
    packageVersion: '1.0.1',
    platform: 'darwin',
    release: '25.5.0',
    arch: 'arm64',
    nodeVersion: 'v22.16.0',
  });
  const parsed = new URL(url);

  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/pAbhishek24/athena-ai-router/issues/new');
  assert.equal(parsed.searchParams.get('template'), 'bug_report.md');
  assert.match(parsed.searchParams.get('title'), /^Bug report:/);
  assert.match(parsed.searchParams.get('body'), /## What happened/);
  assert.match(parsed.searchParams.get('body'), /model-router panel crashed on launch/);
  assert.match(parsed.searchParams.get('body'), /AI Model Router version: 1.0.1/);
});

test('buildFeedbackBody includes feature request scaffolding', () => {
  const body = buildFeedbackBody('feature', 'Add workspace-scoped views', {
    command: 'model-router feedback feature',
    cwd: '/tmp/project',
    packageVersion: '1.0.1',
    repositoryUrl: 'https://github.com/pAbhishek24/athena-ai-router',
    platform: 'darwin',
    release: '25.5.0',
    arch: 'arm64',
    nodeVersion: 'v22.16.0',
  });

  assert.match(body, /## Problem or workflow gap/);
  assert.match(body, /Add workspace-scoped views/);
  assert.match(body, /## Environment/);
});
