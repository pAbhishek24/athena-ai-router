const os = require('os');
const path = require('path');
const { URL } = require('url');
const pkg = require('../package.json');

const FEEDBACK_TYPES = new Set(['bug', 'feature', 'general', 'issue']);

function getRepositoryWebUrl(repositoryUrl = pkg.repository && pkg.repository.url ? pkg.repository.url : '') {
  let value = String(repositoryUrl || '').trim();
  if (!value) {
    return 'https://github.com/pAbhishek24/athena-ai-router';
  }

  if (value.startsWith('git+')) {
    value = value.slice(4);
  }

  if (value.endsWith('.git')) {
    value = value.slice(0, -4);
  }

  const scpMatch = value.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    return `https://${scpMatch[1]}/${scpMatch[2]}`;
  }

  return value;
}

function normalizeFeedbackType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || !FEEDBACK_TYPES.has(normalized)) {
    return 'general';
  }
  return normalized === 'issue' ? 'general' : normalized;
}

function compactText(value, maxLength = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildFeedbackTitle(kind, prompt) {
  const type = normalizeFeedbackType(kind);
  const summary = compactText(prompt);
  const prefix =
    type === 'bug' ? 'Bug report' : type === 'feature' ? 'Feature request' : 'Feedback';
  return summary ? `${prefix}: ${summary}` : prefix;
}

function buildFeedbackBody(kind, prompt, context = {}) {
  const type = normalizeFeedbackType(kind);
  const promptText = String(prompt || '').trim();
  const packageVersion = context.packageVersion || pkg.version;
  const command = context.command || 'model-router feedback';
  const cwd = context.cwd || process.cwd();
  const platform = context.platform || process.platform;
  const release = context.release || os.release();
  const arch = context.arch || process.arch;
  const nodeVersion = context.nodeVersion || process.version;
  const repository = getRepositoryWebUrl(context.repositoryUrl);
  const lines = [];

  if (type === 'bug') {
    lines.push('## What happened');
    lines.push(promptText || '_Describe the problem here._');
    lines.push('');
    lines.push('## What did you expect');
    lines.push('_Describe the expected behavior here._');
    lines.push('');
    lines.push('## Steps to reproduce');
    lines.push('1. ');
    lines.push('');
  } else if (type === 'feature') {
    lines.push('## Problem or workflow gap');
    lines.push(promptText || '_Describe the workflow you want to improve._');
    lines.push('');
    lines.push('## Desired behavior');
    lines.push('_Describe the change you want to see._');
    lines.push('');
    lines.push('## Why it matters');
    lines.push('_Describe the outcome you need._');
    lines.push('');
  } else {
    lines.push('## Feedback');
    lines.push(promptText || '_Share what worked, what did not, or what should change._');
    lines.push('');
  }

  lines.push('## Environment');
  lines.push(`- AI Model Router version: ${packageVersion}`);
  lines.push(`- Command: ${command}`);
  lines.push(`- CWD: ${path.resolve(cwd)}`);
  lines.push(`- Repository: ${repository}`);
  lines.push(`- Platform: ${platform} ${release} (${arch})`);
  lines.push(`- Node: ${nodeVersion}`);

  return `${lines.join('\n')}\n`;
}

function buildFeedbackIssueUrl(kind, prompt, context = {}) {
  const type = normalizeFeedbackType(kind);
  const repositoryUrl = getRepositoryWebUrl(context.repositoryUrl);
  const template =
    type === 'bug'
      ? 'bug_report.md'
      : type === 'feature'
        ? 'feature_request.md'
        : 'feedback.md';
  const url = new URL('issues/new', `${repositoryUrl.replace(/\/$/, '')}/`);
  url.searchParams.set('template', template);
  url.searchParams.set('title', buildFeedbackTitle(type, prompt));
  url.searchParams.set('body', buildFeedbackBody(type, prompt, context));
  return url.toString();
}

module.exports = {
  buildFeedbackBody,
  buildFeedbackIssueUrl,
  buildFeedbackTitle,
  getRepositoryWebUrl,
  normalizeFeedbackType,
};
