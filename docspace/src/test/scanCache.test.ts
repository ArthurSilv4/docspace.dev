import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	clearCaches,
	getCachedMermaid,
	getCachedRelevance,
	invalidatePath,
	setCachedMermaid,
	setCachedRelevance,
} from '../sidebar/scanCache.js';

function uri(...segments: string[]): vscode.Uri {
	return vscode.Uri.file(path.join(path.sep, 'repo', ...segments));
}

suite('scanCache', () => {
	setup(() => clearCaches());

	test('stores and retrieves relevance per filter key', () => {
		const dir = uri('docs');
		setCachedRelevance('docs', dir, true);
		setCachedRelevance('diagrams', dir, false);

		assert.strictEqual(getCachedRelevance('docs', dir), true);
		assert.strictEqual(getCachedRelevance('diagrams', dir), false);
		assert.strictEqual(getCachedRelevance('canvas', dir), undefined);
	});

	test('invalidating a file clears its ancestor directories', () => {
		setCachedRelevance('docs', uri(), false);
		setCachedRelevance('docs', uri('a'), false);
		setCachedRelevance('docs', uri('a', 'b'), false);
		setCachedRelevance('docs', uri('sibling'), false);

		invalidatePath(uri('a', 'b', 'new.md'));

		assert.strictEqual(getCachedRelevance('docs', uri()), undefined);
		assert.strictEqual(getCachedRelevance('docs', uri('a')), undefined);
		assert.strictEqual(getCachedRelevance('docs', uri('a', 'b')), undefined);
		assert.strictEqual(getCachedRelevance('docs', uri('sibling')), false, 'siblings stay cached');
	});

	test('invalidating a folder clears its descendants', () => {
		setCachedRelevance('docs', uri('a'), true);
		setCachedRelevance('docs', uri('a', 'b'), true);
		setCachedMermaid(uri('a', 'b', 'doc.md'), true);
		setCachedRelevance('docs', uri('ab'), true); // prefix overlap, not a child

		invalidatePath(uri('a'));

		assert.strictEqual(getCachedRelevance('docs', uri('a')), undefined);
		assert.strictEqual(getCachedRelevance('docs', uri('a', 'b')), undefined);
		assert.strictEqual(getCachedMermaid(uri('a', 'b', 'doc.md')), undefined);
		assert.strictEqual(getCachedRelevance('docs', uri('ab')), true, 'path-prefix lookalikes stay cached');
	});

	test('invalidating a file clears its mermaid entry only', () => {
		setCachedMermaid(uri('one.md'), true);
		setCachedMermaid(uri('two.md'), false);

		invalidatePath(uri('one.md'));

		assert.strictEqual(getCachedMermaid(uri('one.md')), undefined);
		assert.strictEqual(getCachedMermaid(uri('two.md')), false);
	});

	test('clearCaches drops everything', () => {
		setCachedRelevance('docs', uri('a'), true);
		setCachedMermaid(uri('a', 'doc.md'), true);

		clearCaches();

		assert.strictEqual(getCachedRelevance('docs', uri('a')), undefined);
		assert.strictEqual(getCachedMermaid(uri('a', 'doc.md')), undefined);
	});
});
