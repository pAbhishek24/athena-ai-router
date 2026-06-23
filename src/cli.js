const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { spawn } = require('child_process');
const { stdin, stdout, stderr } = require('process');
const { URL } = require('url');
const { loadConfig, saveConfig } = require('./config');
const { runWorkspaceTask } = require('./agent');
const { ensureRouterStructure, getConfigPath } = require('./paths');
const { createDaemonClient, createDaemonServer, ensureDaemonRunning, isDaemonHealthy, readDaemonMetadata, stopDaemon } = require('./daemon');
const { launchNativeStatusApp } = require('./native-app');
const { installShims, removeShims, runShimExec, summarizeShims } = require('./shims');
const { buildFeedbackIssueUrl, normalizeFeedbackType, getRepositoryWebUrl } = require('./feedback');
const { buildDiscussionsBoardUrl, buildDiscussionSuggestion } = require('./discussions');
const { renderStatusText } = require('./dashboard');
const { createRouter } = require('./router');
const { loadState } = require('./store');
const { runCommand } = require('./runner');

const APP_NAME = 'AI Model Router';
const COMMAND_NAME = 'model-router';

function printUsage() {
  const text = [
    APP_NAME,
    '',
    'Usage:',
    `  ${COMMAND_NAME} init`,
    `  ${COMMAND_NAME} status [--json]`,
    `  ${COMMAND_NAME} daemon <run|start|status|stop> [--host HOST] [--port PORT]`,
    `  ${COMMAND_NAME} serve [--open]`,
    `  ${COMMAND_NAME} app`,
    `  ${COMMAND_NAME} panel`,
    `  ${COMMAND_NAME} ask [prompt...]`,
    `  ${COMMAND_NAME} chat`,
    `  ${COMMAND_NAME} task [prompt...]`,
    `  ${COMMAND_NAME} feedback [bug|feature|general] [prompt...]`,
    `  ${COMMAND_NAME} discuss [topic...]`,
    `  ${COMMAND_NAME} switch <providerId>`,
    `  ${COMMAND_NAME} shims <install|uninstall|status|exec>`,
    '',
    'Options:',
    '  --cwd DIR       Use a different project root',
    '  --config FILE   Use a different config file',
    '  --force         Overwrite the starter config on init',
    '  --json          Emit JSON for status or ask',
    '  --open          Open the browser dashboard after ensuring the daemon is running',
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
    let settled = false;
    let timer = null;
    const onData = (chunk) => {
      buffer += chunk;
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onEnd = () => finish(buffer.trim());
    const onError = () => finish('');
    timer = setTimeout(() => finish(buffer.trim()), 25);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
  });
}

async function createRuntime(argv, options = {}) {
  const parsed = parseArgs(argv);
  const command = parsed._[0] || 'status';
  const commandArgs = parsed._.slice(1);

  const configBundle = loadConfig(process.env, { configPath: parsed.configPath || undefined });
  const daemonUrl = readDaemonMetadata(process.env)?.url || `http://${configBundle.config.dashboard.host || '127.0.0.1'}:${configBundle.config.dashboard.port || 3077}`;
  let daemonInfo = {
    started: false,
    ready: false,
    url: daemonUrl,
  };

  if (options.allowLocalFallback) {
    if (await isDaemonHealthy(daemonUrl)) {
      daemonInfo = {
        started: false,
        ready: true,
        url: daemonUrl,
      };
      const router = createDaemonClient({
        cwd: parsed.cwd,
        env: process.env,
        config: configBundle.config,
        baseUrl: daemonInfo.url,
      });
      await router.refreshProviderStatus();

      return {
        command,
        commandArgs,
        parsed,
        router,
        client: router,
        configBundle,
        daemonInfo,
        runtimeMode: 'daemon',
      };
    }

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
    try {
      await router.refreshProviderStatus();
    } catch {
      // Fall back to the local snapshot when provider probing fails.
    }

    return {
      command,
      commandArgs,
      parsed,
      router,
      client: router,
      configBundle,
      daemonInfo,
      runtimeMode: 'local',
    };
  }

  const daemonStarter = typeof options.ensureDaemonRunning === 'function' ? options.ensureDaemonRunning : ensureDaemonRunning;
  const daemonTimeoutMs = Number.isFinite(options.daemonTimeoutMs) ? options.daemonTimeoutMs : 20000;

  try {
    daemonInfo = await daemonStarter(process.env, {
      configPath: configBundle.configPath,
      timeoutMs: daemonTimeoutMs,
    });
  } catch {
    daemonInfo = {
      started: false,
      ready: false,
      url: daemonInfo.url,
    };
  }

  if (daemonInfo.ready) {
    const router = createDaemonClient({
      cwd: parsed.cwd,
      env: process.env,
      config: configBundle.config,
      baseUrl: daemonInfo.url,
    });
    await router.refreshProviderStatus();

    return {
      command,
      commandArgs,
      parsed,
      router,
      client: router,
      configBundle,
      daemonInfo,
      runtimeMode: 'daemon',
    };
  }

  throw new Error(`Daemon is not reachable at ${daemonInfo.url}`);
}

async function createStatusRuntime(argv) {
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

  try {
    await router.refreshProviderStatus();
  } catch {
    // Keep the locally persisted snapshot if provider probing is unavailable.
  }

  return {
    command,
    commandArgs,
    parsed,
    router,
    client: router,
    configBundle,
    daemonInfo: {
      started: false,
      ready: false,
      url: readDaemonMetadata(process.env)?.url || `http://${configBundle.config.dashboard.host || '127.0.0.1'}:${configBundle.config.dashboard.port || 3077}`,
    },
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

function makeDashboardUrl(baseUrl, cwd) {
  const url = new URL(String(baseUrl || '').trim());
  if (cwd) {
    url.searchParams.set('cwd', path.resolve(cwd));
  }
  return url.toString();
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

async function printStatus(router, json = false) {
  if (router && typeof router.refreshProviderStatus === 'function') {
    try {
      await router.refreshProviderStatus();
    } catch {
      // Render the last cached snapshot if the refresh fails.
    }
  }
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
  const stats = router.state.providerState[result.providerId] || {};
  const projectTotal = Number.isFinite(stats.usedTokens) ? stats.usedTokens : 0;
  const accountTotal = Number.isFinite(stats.effectiveUsedTokens)
    ? stats.effectiveUsedTokens
    : Number.isFinite(stats.accountUsedTokens)
      ? stats.accountUsedTokens
      : projectTotal;
  stdout.write(
    `[${result.providerId}] used ${usage.totalTokens || 0} tokens this turn, project ledger: ${projectTotal}, account total: ${accountTotal}\n`
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

async function runFeedback(parsed, commandArgs) {
  const kindCandidate = String(commandArgs[0] || '').trim().toLowerCase();
  const recognizedKind = ['bug', 'feature', 'general', 'issue'].includes(kindCandidate) ? kindCandidate : '';
  const kind = normalizeFeedbackType(recognizedKind);
  const promptArgs = recognizedKind ? commandArgs.slice(1) : commandArgs;
  const promptFromArgs = promptArgs.join(' ').trim();
  const stdinPrompt = promptFromArgs || (await readStdinIfAvailable());
  const context = {
    command: `${COMMAND_NAME} feedback${kind !== 'general' ? ` ${kind}` : ''}`,
    cwd: parsed.cwd || process.cwd(),
    repositoryUrl: getRepositoryWebUrl(),
  };
  const url = buildFeedbackIssueUrl(kind, stdinPrompt, context);

  stdout.write(`Opening feedback form: ${url}\n`);
  const opened = await openUrl(url);
  if (!opened) {
    stdout.write('Unable to open a browser automatically. Copy the URL above.\n');
  }
}

async function runDiscuss(parsed, commandArgs) {
  const promptFromArgs = commandArgs.join(' ').trim();
  const stdinPrompt = promptFromArgs || (await readStdinIfAvailable());
  const discussionUrl = buildDiscussionsBoardUrl();
  const suggestion = buildDiscussionSuggestion(stdinPrompt, {
    command: `${COMMAND_NAME} discuss`,
    cwd: parsed.cwd || process.cwd(),
  });

  stdout.write(`Opening GitHub Discussions: ${discussionUrl}\n`);
  stdout.write(`Suggested title: ${suggestion.title}\n`);
  if (suggestion.body.trim()) {
    stdout.write(`Suggested starter:\n${suggestion.body}\n`);
  }

  const opened = await openUrl(discussionUrl);
  if (!opened) {
    stdout.write('Unable to open a browser automatically. Copy the URL above.\n');
  }
}

async function handleChatInput(router, input, handlers = {}) {
  const runAskImpl = typeof handlers.runAsk === 'function' ? handlers.runAsk : runAsk;
  const runTaskImpl = typeof handlers.runTask === 'function' ? handlers.runTask : runTask;
  const stdoutWriter = handlers.stdout && typeof handlers.stdout.write === 'function' ? handlers.stdout : stdout;
  const stderrWriter = handlers.stderr && typeof handlers.stderr.write === 'function' ? handlers.stderr : stderr;
  const line = String(input || '').trim();

  if (!line) {
    return { exit: false };
  }

  try {
    if (line === '/exit' || line === '/quit') {
      return { exit: true };
    }

    if (line === '/status') {
      if (typeof router.refreshProviderStatus === 'function') {
        try {
          await router.refreshProviderStatus();
        } catch {
          // Fall back to the cached snapshot.
        }
      }
      stdoutWriter.write(`${renderStatusText(router.snapshot())}\n`);
      return { exit: false };
    }

    if (line.startsWith('/switch ')) {
      const providerId = line.slice('/switch '.length).trim();
      if (!providerId) {
        stdoutWriter.write('Usage: /switch <providerId>\n');
        return { exit: false };
      }
      if (!router.setActiveProvider(providerId, 'manual')) {
        stdoutWriter.write(`Unknown provider: ${providerId}\n`);
        return { exit: false };
      }
      stdoutWriter.write(`Active provider set to ${providerId}\n`);
      return { exit: false };
    }

    if (line.startsWith('/ask ')) {
      const askPrompt = line.slice('/ask '.length).trim();
      if (!askPrompt) {
        stdoutWriter.write('Usage: /ask <prompt>\n');
        return { exit: false };
      }
      await runAskImpl(router, { json: false }, [askPrompt]);
      return { exit: false };
    }

    if (line.startsWith('/task ')) {
      const taskPrompt = line.slice('/task '.length).trim();
      if (!taskPrompt) {
        stdoutWriter.write('Usage: /task <prompt>\n');
        return { exit: false };
      }
      await runTaskImpl(router, { json: false }, [taskPrompt]);
      return { exit: false };
    }

    await runTaskImpl(router, { json: false }, [line]);
    return { exit: false };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    stderrWriter.write(`${message}\n`);
    return { exit: false, error: true, message };
  }
}

async function runChat(router) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  stdout.write(`${APP_NAME} chat. Type instructions for the active model to edit the workspace. Use /ask <prompt> for a conversational answer, /status, /switch <providerId>, /exit.\n`);

  while (true) {
    const line = await rl.question('model-router> ');
    const outcome = await handleChatInput(router, line, { stdout: stdout, stderr });
    if (outcome.exit) {
      break;
    }
  }

  rl.close();
}

async function runServe(router, parsed) {
  const dashboardUrl = makeDashboardUrl(router.daemonUrl, router.cwd || parsed.cwd || process.cwd());
  stdout.write(`Dashboard ready at ${dashboardUrl}\n`);
  if (parsed.open) {
    await openUrl(dashboardUrl);
  }
}

async function runAppCommand(parsed) {
  const configBundle = loadConfig(process.env, { configPath: parsed.configPath || undefined });
  const dashboardUrl = makeDashboardUrl(
    readDaemonMetadata(process.env)?.url || `http://${configBundle.config.dashboard.host || '127.0.0.1'}:${configBundle.config.dashboard.port || 3077}`,
    parsed.cwd || process.cwd()
  );
  const appInfo = launchNativeStatusApp(process.env, {
    url: dashboardUrl,
    configPath: configBundle.configPath,
    title: APP_NAME,
  });

  stdout.write(`Native status app started (pid ${appInfo.pid})\n`);
  stdout.write(`Dashboard URL: ${dashboardUrl}\n`);
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

async function runDaemonCommand(parsed, commandArgs) {
  const subcommand = commandArgs[0] || 'status';
  const configBundle = loadConfig(process.env, { configPath: parsed.configPath || undefined });

  if (subcommand === 'run') {
    const server = await createDaemonServer(process.env, {
      configPath: configBundle.configPath,
      host: parsed.host || configBundle.config.dashboard.host,
      port: Number.isFinite(parsed.port) ? parsed.port : configBundle.config.dashboard.port,
    });

    const info = await server.listen();
    const dashboardUrl = makeDashboardUrl(info.url, parsed.cwd || process.cwd());
    stdout.write(`Daemon running at ${info.url}\n`);
    stdout.write(`Dashboard: ${dashboardUrl}\n`);
    if (parsed.open) {
      await openUrl(dashboardUrl);
    }

    const shutdown = async () => {
      try {
        await server.close();
      } finally {
        process.exit(0);
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await new Promise(() => {});
    return;
  }

  if (subcommand === 'start') {
    const info = await ensureDaemonRunning(process.env, { configPath: configBundle.configPath, timeoutMs: 20000 });
    if (!info.ready) {
      throw new Error(`Daemon is not reachable at ${info.url}`);
    }
    const dashboardUrl = makeDashboardUrl(info.url, parsed.cwd || process.cwd());
    stdout.write(`${info.started ? 'Started' : 'Already running'} daemon at ${info.url}\n`);
    stdout.write(`Dashboard: ${dashboardUrl}\n`);
    if (parsed.open) {
      await openUrl(dashboardUrl);
    }
    return;
  }

  if (subcommand === 'status') {
    const metadata = readDaemonMetadata(process.env);
    if (!metadata) {
      stdout.write('Daemon is not running\n');
      return;
    }
    const healthy = metadata.url ? await isDaemonHealthy(metadata.url) : false;
    const info = {
      pid: metadata.pid,
      url: metadata.url,
      host: metadata.host,
      port: metadata.port,
      startedAt: metadata.startedAt,
      configPath: metadata.configPath,
      pollMs: metadata.pollMs,
      health: healthy ? 'running' : 'stale',
      reachable: healthy,
    };
    stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    if (!healthy) {
      stdout.write(`Warning: daemon metadata exists but ${metadata.url} is not reachable.\n`);
    }
    return;
  }

  if (subcommand === 'stop') {
    const result = stopDaemon(process.env);
    if (!result.ok) {
      stdout.write(`${result.error}\n`);
      return;
    }
    stdout.write(`Stopped daemon pid ${result.pid}\n`);
    return;
  }

  throw new Error(`Unknown daemon subcommand: ${subcommand}`);
}

async function runShimsCommand(parsed, commandArgs) {
  const subcommand = commandArgs[0] || 'status';
  const configBundle = loadConfig(process.env, { configPath: parsed.configPath || undefined });

  if (subcommand === 'install') {
    const result = installShims(configBundle.config, process.env);
    stdout.write(`Shims installed in ${result.shimsDir}\n`);
    stdout.write(`Source ${result.envFile} or add ${result.shimsDir} to your PATH.\n`);
    const installed = result.shims.filter((shim) => shim.status === 'installed');
    const skipped = result.shims.filter((shim) => shim.status !== 'installed');
    if (installed.length) {
      stdout.write(`Installed: ${installed.map((shim) => shim.shimName).join(', ')}\n`);
    }
    if (skipped.length) {
      stdout.write(`Skipped: ${skipped.map((shim) => `${shim.shimName} (${shim.status})`).join(', ')}\n`);
    }
    return;
  }

  if (subcommand === 'uninstall') {
    const result = removeShims(process.env);
    stdout.write(`Removed ${result.removed.length} shim files\n`);
    return;
  }

  if (subcommand === 'status') {
    const result = summarizeShims(process.env);
    if (!result.exists) {
      stdout.write(`No shim manifest found in ${result.shimsDir}\n`);
      stdout.write(`Run ${COMMAND_NAME} shims install to create provider wrappers.\n`);
      return;
    }

    stdout.write(`Shims directory: ${result.shimsDir}\n`);
    stdout.write(`PATH helper: ${result.pathHint}\n`);
    for (const entry of result.entries) {
      stdout.write(
        `- ${entry.shimName}: ${entry.providerId} ${entry.installed ? '(installed)' : '(missing)'}${entry.realCommand ? ` -> ${entry.realCommand}` : ''}\n`
      );
    }
    return;
  }

  if (subcommand === 'exec') {
    await runShimExec(commandArgs.slice(1), process.env, { configPath: configBundle.configPath, cwd: parsed.cwd });
    return;
  }

  throw new Error(`Unknown shims subcommand: ${subcommand}`);
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

  const parsed = parseArgs(argv);
  const command = parsed._[0] || 'status';
  const commandArgs = parsed._.slice(1);

  if (parsed.help) {
    printUsage();
    return;
  }

  if (command === 'init') {
    await runInit(parsed);
    return;
  }

  if (command === 'daemon') {
    await runDaemonCommand(parsed, commandArgs);
    return;
  }

  if (command === 'shims') {
    await runShimsCommand(parsed, commandArgs);
    return;
  }

  if (command === 'app') {
    await runAppCommand(parsed);
    return;
  }

  if (command === 'panel') {
    await runAppCommand(parsed);
    return;
  }

  if (command === 'status') {
    const { router } = await createStatusRuntime(argv);
    await printStatus(router, parsed.json);
    return;
  }

  if (command === 'feedback') {
    await runFeedback(parsed, commandArgs);
    return;
  }

  if (command === 'discuss') {
    await runDiscuss(parsed, commandArgs);
    return;
  }

  const allowLocalFallback = command === 'ask' || command === 'run' || command === 'task' || command === 'chat' || command === 'switch';
  const runtime = await createRuntime(argv, { allowLocalFallback });
  const { router } = runtime;

  if (command === 'chat' && runtime.runtimeMode === 'local') {
    stderr.write('Daemon is not reachable. Chat is running in local router mode.\n');
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

  if (command === 'switch') {
    await runSwitch(router, commandArgs[0]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = {
  createRuntime,
  createStatusRuntime,
  handleChatInput,
  main,
  parseArgs,
  printStatus,
  printUsage,
  runAsk,
  runChat,
  runInit,
  runDiscuss,
  handleChatInput,
  runServe,
  runSwitch,
  runTask,
  runFeedback,
};
