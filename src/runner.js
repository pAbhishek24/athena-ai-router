const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommand(command, env = process.env) {
  if (Array.isArray(command)) {
    for (const candidate of command) {
      const resolved = resolveCommand(candidate, env);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  if (!command || typeof command !== 'string') {
    return null;
  }

  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return isExecutable(command) ? command : null;
  }

  const searchPaths = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];

  for (const searchPath of searchPaths) {
    for (const extension of extensions) {
      const candidate = path.join(searchPath, process.platform === 'win32' ? `${command}${extension}` : command);
      if (isExecutable(candidate)) {
        return candidate;
      }
      if (process.platform !== 'win32' && extension && isExecutable(`${candidate}${extension}`)) {
        return `${candidate}${extension}`;
      }
    }
  }

  return null;
}

function commandExists(command, env = process.env) {
  return !!resolveCommand(command, env);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
      });
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

module.exports = {
  commandExists,
  resolveCommand,
  runCommand,
};
