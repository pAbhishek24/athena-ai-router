const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawn } = require('child_process');
const { stdin, stdout, stderr } = require('process');
const { loadConfig, saveConfig } = require('./config');
const { createDashboardServer, renderStatusText } = require('./dashboard');
const { runWorkspaceTask } = require('./agent');
const { createRouter } = require('./router');
const { ensureRouterStructure, getConfigPath } = require('./paths');
const { runCommand } = require('./runner');
const { loadState } = require('./store');

const APP_NAME = 'AI Model Router';
const COMMAND_NAME = 'model-router';

function printUsage() {
  const text = [
    APP_NAME,
    '',
    'Usage:',
    `  ${COMMAND_NAME} init`,
    `  ${COMMAND_NAME} status [--json]`,
    `  ${COMMAND_NAME} serve [--host HOST] [--port PORT] [--open]`,
    `  ${COMMAND_NAME} panel`,
    `  ${COMMAND_NAME} ask [prompt...]`,
    `  ${COMMAND_NAME} chat`,
    `  ${COMMAND_NAME} task [prompt...]`,
    `  ${COMMAND_NAME} switch <providerId>`,
    '',
    'Options:',
    '  --cwd DIR       Use a different project root',
    '  --config FILE   Use a different config file',
    '  --force         Overwrite the starter config on init',
    '  --json          Emit JSON for status or ask',
    '  --open          Open the dashboard in a browser after serve starts',
    '',
  ].join('\n');
  stdout.write(`${text}\n`);
}

function parseArgs(argv) {
  const parsed = {
    _: [],
    cwd: process.cwd(),
    configPath: null,
    force: false,
    json: false,
    open: false,
    host: null,
    port: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--cwd') {
      parsed.cwd = path.resolve(argv[++index]);
      continue;
    }
    if (value === '--config') {
      parsed.configPath = path.resolve(argv[++index]);
      continue;
    }
    if (value === '--host') {
      parsed.host = argv[++index];
      continue;
    }
    if (value === '--port') {
      parsed.port = Number(argv[++index]);
      continue;
    }
    if (value === '--force') {
      parsed.force = true;
      continue;
    }
    if (value === '--json') {
      parsed.json = true;
      continue;
    }
    if (value === '--open') {
      parsed.open = true;
      continue;
    }
    if (value === '--help' || value === '-h') {
      parsed.help = true;
      continue;
    }
    parsed._.push(value);
  }

  return parsed;
}

function readStdinIfAvailable() {
  return new Promise((resolve) => {
    if (stdin.isTTY) {
      resolve('');
      return;
    }

    let buffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      buffer += chunk;
    });
    stdin.on('end', () => resolve(buffer.trim()));
  });
}

async function createRuntime(argv) {
  const parsed = parseArgs(argv);
  const command = parsed._[0] || 'status';
  const commandArgs = parsed._.slice(1);

  const configBundle = loadConfig(process.env, { configPath: parsed.configPath || undefined });
  const { state, statePath } = loadState(configBundle.config, parsed.cwd, process.env);
  const router = createRouter({
    config: configBundle.config,
    state,
    cwd: parsed.cwd,
    env: process.env,
    runner: runCommand,
    statePath,
    persist: true,
  });
  await router.refreshProviderStatus();

  return {
    command,
    commandArgs,
    parsed,
    router,
    configBundle,
    statePath,
  };
}

function openUrl(url) {
  const target = String(url || '').trim();
  if (!target) {
    return Promise.resolve(false);
  }

  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];

  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

async function runInit(parsed) {
  ensureRouterStructure(process.env);
  const configPath = parsed.configPath || getConfigPath(process.env);
  if (!fs.existsSync(configPath) || parsed.force) {
    const { config } = loadConfig(process.env, { configPath });
    saveConfig(config, process.env, { configPath });
    stdout.write(`Starter config written to ${configPath}\n`);
  } else {
    stdout.write(`Config already exists at ${configPath}\n`);
  }
}

function printStatus(router, json = false) {
  const snapshot = router.snapshot();
  if (json) {
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  stdout.write(`${renderStatusText(snapshot)}\n`);
}

async function runAsk(router, parsed, commandArgs) {
  const promptFromArgs = commandArgs.join(' ').trim();
  const stdinPrompt = promptFromArgs || (await readStdinIfAvailable());
  if (!stdinPrompt) {
    throw new Error('ask requires a prompt argument or piped stdin');
  }

  const result = await router.send(stdinPrompt);
  if (parsed.json) {
    stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          providerId: result.providerId,
          switchedFrom: result.switchedFrom,
          switchedTo: result.switchedTo,
          handoffReason: result.handoffReason,
          usage: result.usage,
          text: result.text,
          errorMessage: result.errorMessage || null,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (result.switchedFrom && result.switchedTo) {
    stdout.write(`Switched ${result.switchedFrom} -> ${result.switchedTo}\n`);
  } else if (result.switchedFrom) {
    stdout.write(`Handoff from ${result.switchedFrom} to ${result.providerId}\n`);
  }

  if (!result.ok) {
    stderr.write(`${result.errorMessage || 'Provider failed'}\n`);
    return;
  }

  stdout.write(`${result.text}\n`);
  const usage = result.usage || {};
  stdout.write(
    `[${result.providerId}] used ${usage.totalTokens || 0} tokens this turn, total ledger: ${router.state.providerState[result.providerId].usedTokens || 0}\n`
  );
}

async function runTask(router, parsed, commandArgs) {
  const promptFromArgs = commandArgs.join(' ').trim();
  const stdinPrompt = promptFromArgs || (await readStdinIfAvailable());
  if (!stdinPrompt) {
    throw new Error('task requires a prompt argument or piped stdin');
  }

  const result = await runWorkspaceTask(router, stdinPrompt, {
    onTurn: ({ type, result: turnResult, plan }) => {
      if (turnResult.switchedFrom && turnResult.switchedTo) {
        stdout.write(`Switched ${turnResult.switchedFrom} -> ${turnResult.switchedTo}\n`);
      } else if (turnResult.switchedFrom) {
        stdout.write(`Handoff from ${turnResult.switchedFrom} to ${turnResult.providerId}\n`);
      }

      if (type === 'freeform') {
        stdout.write(`${turnResult.text}\n`);
        return;
      }

      const summary = plan.summary || 'planning';
      stdout.write(`[${turnResult.providerId}] ${summary}\n`);
      if (plan.reply) {
        stdout.write(`${plan.reply}\n`);
      }
    },
    onAction: ({ action, output }) => {
      stdout.write(`[tool:${action.type}] ${output.summary}\n`);
      if (action.type === 'read_file' && output.content) {
        stdout.write(`${output.content}\n`);
      }
      if (action.type === 'list_files' && Array.isArray(output.files) && output.files.length) {
        stdout.write(`${output.files.join('\n')}\n`);
      }
      if (action.type === 'shell') {
        if (output.stdout) {
          stdout.write(`${output.stdout}\n`);
        }
        if (output.stderr) {
          stderr.write(`${output.stderr}\n`);
        }
      }
    },
  });

  if (!result.ok) {
    stderr.write(`${result.errorMessage || 'Task failed'}\n`);
    return;
  }
}

async function runChat(router) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  stdout.write(`${APP_NAME} chat. Type instructions for the active model. Use /task <prompt> for workspace actions, /status, /switch <providerId>, /exit.\n`);

  while (true) {
    const line = await rl.question('model-router> ');
    const input = line.trim();
    if (!input) {
      continue;
    }

    if (input === '/exit' || input === '/quit') {
      break;
    }

    if (input === '/status') {
      stdout.write(`${renderStatusText(router.snapshot())}\n`);
      continue;
    }

    if (input.startsWith('/switch ')) {
      const providerId = input.slice('/switch '.length).trim();
      if (!providerId) {
        stdout.write('Usage: /switch <providerId>\n');
        continue;
      }
      if (!router.setActiveProvider(providerId, 'manual')) {
        stdout.write(`Unknown provider: ${providerId}\n`);
        continue;
      }
      stdout.write(`Active provider set to ${providerId}\n`);
      continue;
    }

    if (input.startsWith('/task ')) {
      const taskPrompt = input.slice('/task '.length).trim();
      if (!taskPrompt) {
        stdout.write('Usage: /task <prompt>\n');
        continue;
      }
      await runTask(router, { json: false }, [taskPrompt]);
      continue;
    }

    const result = await router.send(input);
    if (result.switchedFrom && result.switchedTo) {
      stdout.write(`Switched ${result.switchedFrom} -> ${result.switchedTo}\n`);
    }
    if (!result.ok) {
      stderr.write(`${result.errorMessage || 'Provider failed'}\n`);
      continue;
    }
    stdout.write(`${result.text}\n`);
  }

  rl.close();
}

async function runServe(router, parsed) {
  const server = createDashboardServer(router, {
    host: parsed.host || router.config.dashboard.host,
    port: Number.isFinite(parsed.port) ? parsed.port : router.config.dashboard.port,
  });

  const info = await server.listen();
  stdout.write(`Dashboard ready at ${info.url}\n`);
  stdout.write('Press Ctrl+C to stop.\n');
  if (parsed.open) {
    await openUrl(info.url);
  }

  await new Promise(() => {});
}

async function runSwitch(router, providerId) {
  if (!providerId) {
    throw new Error('switch requires a provider id');
  }

  if (!router.setActiveProvider(providerId, 'manual')) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  stdout.write(`Active provider set to ${providerId}\n`);
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length) {
    printUsage();
    return;
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    return;
  }

  const { command, commandArgs, parsed, router } = await createRuntime(argv);

  if (parsed.help) {
    printUsage();
    return;
  }

  if (command === 'init') {
    await runInit(parsed);
    return;
  }

  if (command === 'status') {
    printStatus(router, parsed.json);
    return;
  }

  if (command === 'ask' || command === 'run') {
    await runAsk(router, parsed, commandArgs);
    return;
  }

  if (command === 'task') {
    await runTask(router, parsed, commandArgs);
    return;
  }

  if (command === 'chat') {
    await runChat(router);
    return;
  }

  if (command === 'serve') {
    await runServe(router, parsed);
    return;
  }

  if (command === 'panel') {
    parsed.open = true;
    await runServe(router, parsed);
    return;
  }

  if (command === 'switch') {
    await runSwitch(router, commandArgs[0]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = {
  createRuntime,
  main,
  parseArgs,
  printStatus,
  printUsage,
  runAsk,
  runChat,
  runInit,
  runServe,
  runSwitch,
  runTask,
};
