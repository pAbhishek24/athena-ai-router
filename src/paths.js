const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getRouterHome(env = process.env) {
  if (env.ATHENA_ROUTER_HOME) {
    return path.resolve(env.ATHENA_ROUTER_HOME);
  }

  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), 'athena-router');
  }

  return path.join(os.homedir(), '.athena-router');
}

function getConfigPath(env = process.env) {
  return path.join(getRouterHome(env), 'config.json');
}

function getProjectsDir(env = process.env) {
  return path.join(getRouterHome(env), 'projects');
}

function getProjectKey(cwd) {
  return crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 12);
}

function getProjectStatePath(cwd, env = process.env) {
  return path.join(getProjectsDir(env), `${getProjectKey(cwd)}.json`);
}

function ensureRouterStructure(env = process.env) {
  const home = ensureDirSync(getRouterHome(env));
  const projects = ensureDirSync(getProjectsDir(env));
  return { home, projects };
}

module.exports = {
  ensureDirSync,
  ensureRouterStructure,
  getConfigPath,
  getProjectKey,
  getProjectStatePath,
  getProjectsDir,
  getRouterHome,
};

