import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// The image installs Pi globally, and its package exposes an import entry only.
const PI_ENTRY = pathToFileURL('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const SCRATCH = join(homedir(), 'pi-package-check');
const AGENT_DIRECTORY = join(SCRATCH, 'agent');
const EMPTY_PROJECT = join(SCRATCH, 'project');
const MARKDOWN_LINK = /\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
const OUTSIDE_CHECKOUT = /^(?:[a-z][a-z0-9+.-]*:|\/|~|#)/i;

const repository = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

function parseJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON.`, { cause: error });
  }
}

function brokenLinks() {
  return tracked.filter(file => file.endsWith('.md')).flatMap(file => [...readFileSync(file, 'utf8').matchAll(MARKDOWN_LINK)]
    .map(([, target]) => target)
    .filter(target => !OUTSIDE_CHECKOUT.test(target) && !existsSync(resolve(dirname(file), decodeURIComponent(target.split('#')[0]))))
    .map(target => `${file}: ${target}`));
}

function expectedSkills(manifest) {
  assert.ok(Array.isArray(manifest.pi?.skills), 'package.json must name its skill directories in pi.skills.');
  const roots = manifest.pi.skills.map(directory => `${resolve(directory)}${sep}`);
  return tracked.filter(file => file.split('/').at(-1) === 'SKILL.md').map(file => resolve(file))
    .filter(path => roots.some(root => path.startsWith(root))).sort();
}

async function discoveredSkills() {
  mkdirSync(AGENT_DIRECTORY, { recursive: true });
  mkdirSync(EMPTY_PROJECT, { recursive: true });
  writeFileSync(join(AGENT_DIRECTORY, 'settings.json'), JSON.stringify({ packages: [repository] }));
  process.env.PI_CODING_AGENT_DIR = AGENT_DIRECTORY;
  process.env.PI_OFFLINE = '1';
  const { DefaultResourceLoader } = await import(PI_ENTRY.href);
  const loader = new DefaultResourceLoader({ cwd: EMPTY_PROJECT, agentDir: AGENT_DIRECTORY, noExtensions: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  return loader.getSkills();
}

const jsonFiles = tracked.filter(file => file.endsWith('.json'));
jsonFiles.forEach(parseJson);
assert.deepEqual(brokenLinks(), [], 'every relative Markdown link must name a file of the checkout.');
const expected = expectedSkills(parseJson('package.json'));
assert.ok(expected.length > 0, 'the package must hold at least one SKILL.md under its pi.skills directories.');
const { skills, diagnostics } = await discoveredSkills();
assert.deepEqual(diagnostics, [], 'Pi must load the package with no skill diagnostics.');
assert.deepEqual(skills.map(skill => skill.filePath).sort(), expected, 'Pi must discover every SKILL.md of the package exactly once.');
assert.equal(new Set(skills.map(skill => skill.name)).size, skills.length, 'skill names must be unique.');
process.stdout.write(`${jsonFiles.length} JSON files parse, relative Markdown links resolve, and Pi discovers the package's ${skills.length} skills with no diagnostics.\n`);
