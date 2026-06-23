const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const { getRepositoryWebUrl, compactText } = require('./feedback');

function buildDiscussionsBoardUrl(repositoryUrl = pkg.repository && pkg.repository.url ? pkg.repository.url : '') {
  const repository = getRepositoryWebUrl(repositoryUrl).replace(/\/$/, '');
  return `${repository}/discussions`;
}

function buildDiscussionSuggestion(prompt, context = {}) {
  const text = String(prompt || '').trim();
  return {
    title: compactText(text, 96) || 'Discussion topic',
    body: text
      ? `${text}\n\n## Context\n- AI Model Router version: ${context.packageVersion || pkg.version}\n- Command: ${context.command || 'model-router discuss'}\n- CWD: ${path.resolve(context.cwd || process.cwd())}\n- Platform: ${context.platform || process.platform} ${context.release || os.release()} (${context.arch || process.arch})\n- Node: ${context.nodeVersion || process.version}\n`
      : `\n## Context\n- AI Model Router version: ${context.packageVersion || pkg.version}\n- Command: ${context.command || 'model-router discuss'}\n- CWD: ${path.resolve(context.cwd || process.cwd())}\n- Platform: ${context.platform || process.platform} ${context.release || os.release()} (${context.arch || process.arch})\n- Node: ${context.nodeVersion || process.version}\n`,
  };
}

module.exports = {
  buildDiscussionSuggestion,
  buildDiscussionsBoardUrl,
};
