import * as assert from 'assert';
import { blocksToMarkdown, markdownToBlocks, pageTitle, NotionBlock } from '../notionConvert.js';

function rt(content: string, annotations = {}, href: string | null = null) {
	return { plain_text: content, href, annotations };
}

function block(type: string, rich: ReturnType<typeof rt>[], extra = {}): NotionBlock {
	return { type, [type]: { rich_text: rich, ...extra } } as NotionBlock;
}

suite('notionConvert', () => {
	test('renders rich text annotations and links', () => {
		const blocks = [block('paragraph', [
			rt('plain '), rt('bold', { bold: true }), rt(' '), rt('code', { code: true }),
			rt(' '), rt('link', {}, 'https://x.dev'),
		])];
		assert.strictEqual(
			blocksToMarkdown(blocks).trim(),
			'plain **bold** `code` [link](https://x.dev)'
		);
	});

	test('renders headings, bullets and code blocks', () => {
		const blocks = [
			block('heading_1', [rt('Título')]),
			block('bulleted_list_item', [rt('um')]),
			block('bulleted_list_item', [rt('dois')]),
			block('code', [rt('const x = 1;')], { language: 'javascript' }),
		];
		const md = blocksToMarkdown(blocks);
		assert.ok(md.includes('# Título'));
		assert.ok(md.includes('- um\n- dois'));
		assert.ok(md.includes('```javascript\nconst x = 1;\n```'));
	});

	test('numbers ordered list items', () => {
		const blocks = [
			block('numbered_list_item', [rt('primeiro')]),
			block('numbered_list_item', [rt('segundo')]),
		];
		const md = blocksToMarkdown(blocks);
		assert.ok(md.includes('1. primeiro'));
		assert.ok(md.includes('2. segundo'));
	});

	test('renders to_do checked state', () => {
		const blocks = [
			block('to_do', [rt('feito')], { checked: true }),
			block('to_do', [rt('pendente')], { checked: false }),
		];
		const md = blocksToMarkdown(blocks);
		assert.ok(md.includes('- [x] feito'));
		assert.ok(md.includes('- [ ] pendente'));
	});

	test('markdownToBlocks maps the common line forms', () => {
		const md = [
			'# Heading',
			'',
			'- bullet',
			'1. numbered',
			'- [x] done',
			'> quote',
			'---',
			'parágrafo',
		].join('\n');
		const types = markdownToBlocks(md).map((b) => b.type);
		assert.deepStrictEqual(types, [
			'heading_1', 'bulleted_list_item', 'numbered_list_item',
			'to_do', 'quote', 'divider', 'paragraph',
		]);
	});

	test('markdownToBlocks keeps fenced code intact', () => {
		const md = '```python\nprint(1)\nprint(2)\n```';
		const blocks = markdownToBlocks(md);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].type, 'code');
		const payload = blocks[0].code as { rich_text: { text: { content: string } }[]; language: string };
		assert.strictEqual(payload.rich_text[0].text.content, 'print(1)\nprint(2)');
		assert.strictEqual(payload.language, 'python');
	});

	test('pageTitle reads the title property', () => {
		const page = { properties: { Name: { type: 'title', title: [rt('Minha Página')] } } };
		assert.strictEqual(pageTitle(page), 'Minha Página');
	});

	test('round-trips a heading and paragraph through both directions', () => {
		const md = blocksToMarkdown(markdownToBlocks('# T\n\ncorpo')).trim();
		assert.ok(md.startsWith('# T'));
		assert.ok(md.includes('corpo'));
	});
});
