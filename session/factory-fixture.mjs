import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';

const root = process.env.FACTORY_FIXTURE;
const repository = 'walid-mos/agent-sandbox';
const file = name => join(root, name);
const read = name => JSON.parse(readFileSync(file(name), 'utf8'));
function write(name, value) {
  const staging = file(`${name}.${process.pid}`);
  writeFileSync(staging, JSON.stringify(value));
  renameSync(staging, file(name));
}
const json = value => process.stdout.write(JSON.stringify(value));
const containerId = 'c'.repeat(64);

function github(args) {
  appendFileSync(file('calls'), `${args[0]} ${args[1]}\n`);
  const facts = read('facts');
  if (args[0] === 'repo') {
    const names = existsSync(file('failing-repository')) ? ['walid-mos/failing', repository] : [repository];
    return json(names.map(nameWithOwner => ({ nameWithOwner, repositoryTopics: [{ name: 'factory' }] })));
  }
  if (args.includes('walid-mos/failing')) process.exit(1);
  if (existsSync(file('signed-fixture'))) {
    const result = signedGithub(args, facts);
    if (result.isHandled) return;
  }
  if (args[0] === 'pr') return githubPull(args[1], facts);
  if (args[1] !== 'graphql') return json(['factory']);
  return githubGraphql(args, facts);
}

function signedGithub(args, facts) {
  if (args[0] === 'api' && args[1] === 'user') json(123);
  else if (args[0] === 'api' && args[1].includes('/pulls/')) {
    const isMerged = existsSync(file('merged'));
    json({ number: facts.number, state: isMerged ? 'closed' : 'open', merged: isMerged, merge_commit_sha: facts.headRefOid,
      base: { repo: { full_name: repository }, ref: facts.baseRefName }, head: { sha: facts.headRefOid } });
  } else if (args[0] === 'pr' && args[1] === 'comment') {
    if (facts.baseRefName !== 'main') {
      const lock = file(`.config/agent-sandbox/factory/heads/${repository.replace('/', '-')}-${facts.number}-${facts.headRefOid}.json.lock`);
      const attempt = spawnSync('flock', ['--nonblock', lock, 'true']);
      if (attempt.status !== 1) throw new Error('ordinary verdict comment ran outside the shared record lock');
      write('verdict-comment', readFileSync(args.at(-1), 'utf8'));
    } else {
      write('verdict-comment', readFileSync(args.at(-1), 'utf8'));
      process.exit(1);
    }
  } else if (args[0] === 'api' && args[1].includes('/comments?')) json([[{ user: { id: 123 }, body: read('verdict-comment') }]]);
  else if (args[0] === 'pr' && args[1] === 'merge') write('merged', true);
  else return { isHandled: false };
  return { isHandled: true };
}

function githubGraphql(args, facts) {
  if (args.includes('--paginate')) {
    appendFileSync(file('calls'), 'draft pagination\n');
    return json([{ data: { repository: { pullRequests: { nodes: [] } } } }]);
  }
  const pullRequest = existsSync(file('merged')) ? { ...facts, state: 'MERGED' } : facts;
  return json({ data: { repository: { nameWithOwner: repository, isArchived: false, pullRequest } } });
}

function githubPull(operation, facts) {
  if (operation === 'list') return json([facts]);
  if (operation === 'view') return json(facts);
  throw new Error('unexpected pull request operation');
}

function waitForRelease(container) {
  return new Promise(resolve => {
    const watcher = watch(root, (_, name) => {
      if (name === 'release' || (name === 'container' && !existsSync(file('container')))) {
        watcher.close();
        resolve();
      }
    });
    write('blocked', { pid: process.pid, job: container.job });
  });
}

const isCheck = container => container.name.endsWith('-check');

function fixtureContainer() {
  return existsSync(file('container')) ? read('container') : undefined;
}

async function simulateCheck(container) {
  if (existsSync(file('gate'))) await waitForRelease(container);
  if (existsSync(file('late'))) write('elapsed', 61 * 60_000);
  if (existsSync(file('release'))) write('elapsed', 35 * 60_000);
}

const dockerOperations = {
  image(flags) {
    if (flags.includes('--format')) process.stdout.write(`sha256:${existsSync(file('image-id')) ? read('image-id') : containerId}`);
  },
  run(flags) {
    appendFileSync(file('legacy-checks'), `${flags[2]}\n`);
  },
  create(flags) {
    write('container', { name: flags[1], job: flags[3].split('=')[1], state: 'created' });
    process.stdout.write(containerId);
  },
  ps() {
    process.stdout.write(fixtureContainer() ? containerId : '');
  },
  inspect(flags, container) {
    const detail = flags.at(-2).includes('State') ? `${container.state} 0` : `/${container.name} ${container.job}`;
    process.stdout.write(detail);
  },
  rm(_flags, container) {
    if (isCheck(container) && existsSync(file('refuse-cleanup'))) process.exit(1);
    appendFileSync(file('removed'), `${container.name} ${containerId}\n`);
    rmSync(file('container'));
  },
  async start(_flags, container) {
    write('container', { ...container, state: 'running' });
    if (isCheck(container)) await simulateCheck(container);
    if (fixtureContainer()?.name === container.name) write('container', { ...container, state: 'exited' });
  },
};

async function docker([operation, ...flags]) {
  const execute = dockerOperations[operation];
  if (!execute) throw new Error('unexpected Docker operation');
  const container = fixtureContainer();
  if (['inspect', 'rm', 'start'].includes(operation)) assertFixtureIdentity(container, flags.at(-1));
  await execute(flags, container);
}

function assertFixtureIdentity(container, id) {
  if (!container || id !== containerId) throw new Error('unexpected container identity');
}

export function launchController(directory, program, env, wakeSocket) {
  const stdio = ['ignore', 'ignore', 'inherit'];
  if (!process.env.FACTORY_TEST_S6) {
    const child = spawn(process.execPath, wakeSocket ? [program, wakeSocket] : [program], { env, stdio });
    return { child, stop: () => child.kill('SIGKILL') };
  }
  const service = join(directory, 'service');
  mkdirSync(service, { recursive: true });
  writeFileSync(join(service, 'run'), '#!/bin/sh\nexec "$FACTORY_NODE" "$FACTORY_PROGRAM" ${FACTORY_WAKE:+"$FACTORY_WAKE"}\n', { mode: 0o700 });
  const child = spawn('s6-supervise', [service], { env: { ...env, FACTORY_NODE: process.execPath, FACTORY_PROGRAM: program, FACTORY_WAKE: wakeSocket ?? '' }, stdio });
  return { child, stop: () => execFileSync('s6-svc', ['-dx', service]) };
}

function preload() {
  registerHooks({ load(url, context, next) {
    if (existsSync(file('signed-fixture'))) {
      const replacement = signedModule(url);
      if (replacement) return { format: 'module', shortCircuit: true, source: replacement };
    }
    if (url.endsWith('/factory-authority.mjs') && !existsSync(file('signed-fixture'))) {
      return { format: 'module', shortCircuit: true, source: `export const isIsolatedFactory = false, isRetiredSessionFactory = false,
        landingRepository = 'example/landing', LANDING_BRANCH = 'main', REPORT_SOURCE = 'pr-factory', isLandingPull = () => false;
        export function requireFactoryRuntime() {} export function requireLandingAuthority() {}` };
    }
    if (url.endsWith('/factory-repositories.mjs') && existsSync(file('check-steps'))) {
      return { format: 'module', shortCircuit: true, source: `import { readFileSync } from 'node:fs';
        export const hasChecks = () => true;
        export const checkSteps = () => JSON.parse(readFileSync(${JSON.stringify(file('check-steps'))}, 'utf8'));` };
    }
    if (url.endsWith('/factory-checks.mjs') && existsSync(file('check-helpers'))) {
      const loaded = next(url, context);
      return { ...loaded, source: String(loaded.source).replace("join(dirname(fileURLToPath(import.meta.url)), 'factory-image')", JSON.stringify(file('check-helpers'))) };
    }
    if (url.endsWith('/sandbox.mjs')) {
      if (existsSync(file('sandbox.json'))) {
        const loaded = next(url, context);
        return { ...loaded, source: String(loaded.source).replace("'/etc/agent-sandbox/sandbox.json'", JSON.stringify(file('sandbox.json'))) };
      }
      return { format: 'module', shortCircuit: true, source: `export const owners = ['walid-mos'], sandbox = { factoryDurable: true }, botId = 'principal';` };
    }
    if (url.endsWith('/vault.mjs')) {
      return { format: 'module', shortCircuit: true, source: `process.execve('/bin/sh', ['sh', '-c', 'exec "$@"', 'fixture', ...process.argv.slice(2)], process.env);` };
    }
    return next(url, context);
  } });
  if (process.argv[2] === 'run-job') {
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { value: () => now() + (existsSync(file('elapsed')) ? read('elapsed') : 0) });
  }
  if (basename(process.argv[1] ?? '') !== 'factory-controller.mjs') return;
  const interval = globalThis.setInterval;
  globalThis.setInterval = (handler, milliseconds, ...args) => {
    appendFileSync(file('intervals'), `${milliseconds}\n`);
    return interval(handler, milliseconds, ...args);
  };
}

function signedModule(url) {
  if (url.endsWith('/factory-authority.mjs')) return `export const isIsolatedFactory = true, isRetiredSessionFactory = false,
    landingRepository = ${JSON.stringify(repository)}, LANDING_BRANCH = 'main', isLandingPull = pull => pull.repository === landingRepository && pull.base === LANDING_BRANCH; export function requireFactoryRuntime() {} export function requireLandingAuthority() {}`;
  const preamble = `import { readFileSync, writeFileSync } from 'node:fs'; const root = ${JSON.stringify(root)};`;
  if (url.endsWith('/factory-release-git.mjs')) return `${preamble}
    export function releaseGit() {
      const facts = JSON.parse(readFileSync(root + '/facts'));
      return { tip: () => facts.baseRefOid, tree: () => 'a'.repeat(40),
        inspectSquash: head => ({ head, base: facts.baseRefOid, tree: 'a'.repeat(40) }),
        storeSquashEvidence: (release, request) => { if (JSON.stringify(release.request) !== JSON.stringify(request)) throw new Error('receipt mismatch'); return release.tag; },
        publishSquashEvidence: tag => writeFileSync(root + '/published', tag) };
    }`;
  if (url.endsWith('/factory-channel.mjs')) return `${preamble}
    export function askFactory(kind, request) {
      const path = root + '/' + kind;
      writeFileSync(root + '/channel-calls', kind + '\\n', { flag: 'a' });
      if (kind !== 'landing') return writeFileSync(path, JSON.stringify(request));
      try { writeFileSync(path, JSON.stringify(request), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; return { request: request.squashEvidence, tag: 'fixture-tag' }; }
      throw new Error('fixture lost signer response');
    }`;
}

function pots(args) {
  if (args[0] === 'routine') return write('routine', args);
  if (args.includes('--list')) return json([{ source: 'factory-install' }]);
  const prior = existsSync(file('wakes')) ? readFileSync(file('wakes'), 'utf8') : '';
  writeFileSync(file('wakes.staging'), `${prior}${args.at(-1)}\n`);
  renameSync(file('wakes.staging'), file('wakes'));
}

if (root && !import.meta.main) preload();
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'gh') github(args);
  if (command === 'docker') await docker(args);
  if (command === 'pots') pots(args);
}
