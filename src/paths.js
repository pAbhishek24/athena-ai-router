const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getRouterHome(env = process.env) {
  if (env.AI_MODEL_ROUTER_HOME) {
    return path.resolve(env.AI_MODEL_ROUTER_HOME);
  }

  if (env.ATHENA_ROUTER_HOME) {
    return path.resolve(env.ATHENA_ROUTER_HOME);
  }

  if (env.XDG_STATE_HOME) {
    const newHome = path.join(path.resolve(env.XDG_STATE_HOME), 'ai-model-router');
    if (fs.existsSync(newHome)) {
      return newHome;
    }

    const legacyHome = path.join(path.resolve(env.XDG_STATE_HOME), 'athena-router');
    if (fs.existsSync(legacyHome)) {
      return legacyHome;
    }

    return newHome;
  }

  const newHome = path.join(os.homedir(), '.ai-model-router');
  if (fs.existsSync(newHome)) {
    return newHome;
  }

  const legacyHome = path.join(os.homedir(), '.athena-router');
  if (fs.existsSync(legacyHome)) {
    return legacyHome;
  }

  return newHome;
}

function getConfigPath(env = process.env) {
  if (env.AI_MODEL_ROUTER_CONFIG) {
    return path.resolve(env.AI_MODEL_ROUTER_CONFIG);
  }

  if (env.ATHENA_ROUTER_CONFIG) {
    return path.resolve(env.ATHENA_ROUTER_CONFIG);
  }

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
