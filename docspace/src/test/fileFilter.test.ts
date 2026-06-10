import * as assert from 'assert';
import { isRelevantByName, needsContentCheck } from '../fileFilter.js';

suite('fileFilter', () => {
	test('matches files by name per filter key', () => {
		assert.strictEqual(isRelevantByName('readme.md', 'docs'), true);
		assert.strictEqual(isRelevantByName('flow.mmd', 'docs'), false);
		assert.strictEqual(isRelevantByName('flow.mmd', 'diagrams'), true);
		assert.strictEqual(isRelevantByName('sketch.excalidraw', 'canvas'), true);
		assert.strictEqual(isRelevantByName('sketch.excalidraw', 'docs'), false);
		assert.strictEqual(isRelevantByName('main.ts', 'all'), false);
		assert.strictEqual(isRelevantByName('readme.md', 'all'), true);
	});

	test('only .md files under the diagrams filter need a content check', () => {
		assert.strictEqual(needsContentCheck('readme.md', 'diagrams'), true);
		assert.strictEqual(needsContentCheck('readme.md', 'docs'), false);
		assert.strictEqual(needsContentCheck('flow.mmd', 'diagrams'), false);
	});
});
