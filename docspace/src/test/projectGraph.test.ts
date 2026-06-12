import * as assert from 'assert';
import { extractImports, packageName, resolveImport } from '../projectGraph.js';

suite('projectGraph', () => {
	test('extracts the common import forms', () => {
		const source = [
			`import * as vscode from 'vscode';`,
			`import path from "path";`,
			`import { a, b } from './utils.js';`,
			`import './side-effect.css';`,
			`export { x } from '../shared/x';`,
			`const m = require('lodash/fp');`,
			`const lazy = await import('./lazy.js');`,
		].join('\n');

		const specs = extractImports(source);
		assert.deepStrictEqual(
			specs.sort(),
			['../shared/x', './lazy.js', './side-effect.css', './utils.js', 'lodash/fp', 'path', 'vscode'].sort()
		);
	});

	test('deduplicates repeated specifiers', () => {
		const source = `import { a } from './x';\nimport { b } from './x';`;
		assert.deepStrictEqual(extractImports(source), ['./x']);
	});

	test('resolves relative imports against project files', () => {
		const files = new Set(['src/a.ts', 'src/utils/b.ts', 'src/utils/index.ts', 'lib/c.js']);

		// Node16 style: './b.js' written in source, '.ts' on disk
		assert.strictEqual(resolveImport('src/a.ts', './utils/b.js', files), 'src/utils/b.ts');
		// extensionless
		assert.strictEqual(resolveImport('src/a.ts', './utils/b', files), 'src/utils/b.ts');
		// index resolution
		assert.strictEqual(resolveImport('src/a.ts', './utils', files), 'src/utils/index.ts');
		// parent traversal
		assert.strictEqual(resolveImport('src/utils/b.ts', '../../lib/c.js', files), 'lib/c.js');
		// unknown target
		assert.strictEqual(resolveImport('src/a.ts', './missing', files), undefined);
	});

	test('extracts C# usings and project references', () => {
		const source = [
			`using System.IO;`,
			`using Microsoft.Extensions.Logging;`,
			`<ProjectReference Include="../Lib/Lib.csproj" />`,
		].join('\n');
		assert.deepStrictEqual(
			extractImports(source, 'csharp').sort(),
			['../Lib/Lib.csproj', 'Microsoft.Extensions.Logging', 'System.IO'].sort()
		);
	});

	test('extracts Python imports including relative ones', () => {
		const source = [
			`import os.path`,
			`from collections import OrderedDict`,
			`from .utils import helper`,
		].join('\n');
		assert.deepStrictEqual(
			extractImports(source, 'python').sort(),
			['.utils', 'collections', 'os.path'].sort()
		);
	});

	test('extracts Go single and grouped imports', () => {
		const source = [
			`import "fmt"`,
			`import (`,
			`\t"strings"`,
			`\t"github.com/user/pkg"`,
			`)`,
		].join('\n');
		assert.deepStrictEqual(
			extractImports(source, 'go').sort(),
			['fmt', 'github.com/user/pkg', 'strings'].sort()
		);
	});

	test('unknown language falls back to JS/TS patterns', () => {
		const source = `import { x } from './x';`;
		assert.deepStrictEqual(extractImports(source, 'rust'), ['./x']);
	});

	test('derives package names from bare specifiers', () => {
		assert.strictEqual(packageName('lodash'), 'lodash');
		assert.strictEqual(packageName('lodash/fp'), 'lodash');
		assert.strictEqual(packageName('@scope/pkg'), '@scope/pkg');
		assert.strictEqual(packageName('@scope/pkg/deep/path'), '@scope/pkg');
	});
});
