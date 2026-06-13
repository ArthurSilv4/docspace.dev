#!/usr/bin/env node
// Release automation for the Docspace extension.
//
//   node scripts/release.mjs prepare <patch|minor|major> [--dry-run]
//   node scripts/release.mjs finish
//
// prepare: bump the version (no git), prepend a CHANGELOG template section.
// finish:  compile + lint + package the .vsix, then git commit + tag.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'package.json');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

function run(cmd, args, opts = {}) {
	// npm/npx are .cmd shims on Windows and need a shell; git is a real exe and
	// must NOT use a shell, otherwise multi-word args (e.g. the commit message)
	// get split and break (git would read "v0.0.7" as a pathspec).
	const useShell = process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx');
	return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', shell: useShell, ...opts });
}

function readVersion() {
	return JSON.parse(readFileSync(PKG, 'utf8')).version;
}

function fail(msg) {
	console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
	process.exit(1);
}

function nextVersion(current, type) {
	const [major, minor, patch] = current.split('.').map(Number);
	if ([major, minor, patch].some((n) => Number.isNaN(n))) { fail(`Invalid version "${current}".`); }
	if (type === 'major') { return `${major + 1}.0.0`; }
	if (type === 'minor') { return `${major}.${minor + 1}.0`; }
	if (type === 'patch') { return `${major}.${minor}.${patch + 1}`; }
	return fail(`Unknown bump type "${type}" (use patch|minor|major).`);
}

function changelogSection(version) {
	const date = new Date().toISOString().slice(0, 10);
	return `## [${version}] - ${date}\n\n### Adicionado\n- \n\n### Alterado\n- \n\n`;
}

function prependChangelog(version) {
	const body = readFileSync(CHANGELOG, 'utf8');
	// Insert the new section right after the file header, before the first "## [" entry.
	const marker = body.indexOf('\n## [');
	if (marker === -1) { fail('Could not find an existing "## [" section in CHANGELOG.md.'); }
	const head = body.slice(0, marker + 1);
	const rest = body.slice(marker + 1);
	writeFileSync(CHANGELOG, `${head}${changelogSection(version)}${rest}`);
}

function prepare(type, dryRun) {
	const current = readVersion();
	const next = nextVersion(current, type);

	if (dryRun) {
		console.log(`\x1b[36m[dry-run]\x1b[0m ${current} → ${next}`);
		console.log('\x1b[36m[dry-run]\x1b[0m CHANGELOG.md would gain:\n');
		console.log(changelogSection(next));
		console.log('No files were modified.');
		return;
	}

	const status = run('git', ['status', '--porcelain']).trim();
	if (status) { fail('Working tree is not clean. Commit or stash your changes first.'); }

	run('npm', ['version', type, '--no-git-tag-version']);
	prependChangelog(next);

	console.log(`\x1b[32m✔ Prepared v${next}\x1b[0m`);
	console.log('Next steps:');
	console.log('  1. Edit CHANGELOG.md and fill in the release notes.');
	console.log('  2. Run: npm run release:finish');
}

function finish() {
	const version = readVersion();
	console.log(`\x1b[36m▶ Building v${version}…\x1b[0m`);

	run('npm', ['run', 'compile'], { stdio: 'inherit' });
	run('npm', ['run', 'lint'], { stdio: 'inherit' });
	run('npx', ['--yes', '@vscode/vsce', 'package', '--allow-missing-repository'], { stdio: 'inherit' });

	run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
	run('git', ['commit', '-m', `release: v${version}`]);
	run('git', ['tag', `v${version}`]);

	console.log(`\x1b[32m✔ Released v${version}\x1b[0m (.vsix + commit + tag created)`);
	console.log('Push when ready: git push && git push --tags');
}

const [command, arg] = process.argv.slice(2);
const dryRun = process.argv.includes('--dry-run');

if (command === 'prepare') { prepare(arg, dryRun); }
else if (command === 'finish') { finish(); }
else { fail('Usage: release.mjs <prepare <patch|minor|major> [--dry-run] | finish>'); }
