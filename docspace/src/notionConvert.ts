// Pure conversion between Notion blocks and Markdown — no I/O, fully testable.

export interface RichText {
	plain_text?: string;
	text?: { content?: string };
	href?: string | null;
	annotations?: {
		bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean;
	};
}

export interface NotionBlock {
	id?: string;
	type: string;
	has_children?: boolean;
	children?: NotionBlock[];
	// Per-type payloads carry { rich_text: RichText[], ... }
	[key: string]: unknown;
}

function richToMd(rich: RichText[] | undefined): string {
	if (!rich) { return ''; }
	return rich.map((rt) => {
		// reads carry plain_text; freshly built (write) blocks carry text.content
		let text = rt.plain_text ?? rt.text?.content ?? '';
		const a = rt.annotations ?? {};
		if (a.code) { text = `\`${text}\``; }
		if (a.bold) { text = `**${text}**`; }
		if (a.italic) { text = `*${text}*`; }
		if (a.strikethrough) { text = `~~${text}~~`; }
		if (rt.href) { text = `[${text}](${rt.href})`; }
		return text;
	}).join('');
}

function payload(block: NotionBlock): { rich_text?: RichText[]; [k: string]: unknown } {
	return (block[block.type] as { rich_text?: RichText[] }) ?? {};
}

function indent(depth: number): string {
	return '  '.repeat(depth);
}

// Blocks rendered as a simple prefix + rich text, no children/indent.
const SIMPLE_MD: Record<string, (rich: string) => string> = {
	heading_1: (r) => `# ${r}\n`,
	heading_2: (r) => `## ${r}\n`,
	heading_3: (r) => `### ${r}\n`,
	quote: (r) => `> ${r}\n`,
	paragraph: (r) => (r ? `${r}\n` : '\n'),
};

/** Convert one block (and its children) to Markdown lines. */
function blockToMd(block: NotionBlock, depth: number, numbering: { n: number }): string {
	const data = payload(block);
	const rich = richToMd(data.rich_text);
	const simple = SIMPLE_MD[block.type];
	if (simple) { return simple(rich); }
	return complexBlockToMd(block, data, rich, depth, numbering);
}

function complexBlockToMd(
	block: NotionBlock,
	data: { rich_text?: RichText[]; [k: string]: unknown },
	rich: string,
	depth: number,
	numbering: { n: number },
): string {
	const pad = indent(depth);
	switch (block.type) {
		case 'bulleted_list_item':
			return `${pad}- ${rich}\n${childrenMd(block, depth + 1)}`;
		case 'numbered_list_item':
			return `${pad}${numbering.n++}. ${rich}\n${childrenMd(block, depth + 1)}`;
		case 'to_do':
			return `${pad}- [${data.checked ? 'x' : ' '}] ${rich}\n${childrenMd(block, depth + 1)}`;
		case 'code':
			return `\`\`\`${(data.language as string) ?? ''}\n${plainOf(data.rich_text)}\n\`\`\`\n`;
		case 'divider':
			return '---\n';
		case 'image':
			return `![](${imageUrl(data)})\n`;
		default:
			return rich ? `${rich}\n` : '';
	}
}

function plainOf(rich: RichText[] | undefined): string {
	return (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');
}

function imageUrl(data: { [k: string]: unknown }): string {
	const ext = data.external as { url?: string } | undefined;
	const file = data.file as { url?: string } | undefined;
	return ext?.url ?? file?.url ?? '';
}

function childrenMd(block: NotionBlock, depth: number): string {
	if (!block.children?.length) { return ''; }
	const numbering = { n: 1 };
	return block.children.map((c) => blockToMd(c, depth, numbering)).join('');
}

/** Convert a Notion block tree into Markdown. Blank lines separate top blocks. */
export function blocksToMarkdown(blocks: NotionBlock[]): string {
	const numbering = { n: 1 };
	const out: string[] = [];
	let prevList = false;
	for (const block of blocks) {
		const isList = block.type === 'bulleted_list_item'
			|| block.type === 'numbered_list_item' || block.type === 'to_do';
		if (!isList) { numbering.n = 1; }
		const md = blockToMd(block, 0, numbering);
		// keep list items tight, separate other blocks with a blank line
		if (out.length && !(isList && prevList)) { out.push('\n'); }
		out.push(md);
		prevList = isList;
	}
	return out.join('').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ── Markdown → Notion blocks (for push) ──────────────────────────────────────
function textBlock(type: string, text: string, extra: object = {}): NotionBlock {
	return { type, [type]: { rich_text: [{ type: 'text', text: { content: text } }], ...extra } } as NotionBlock;
}

/** Map a single non-code line to a Notion block. */
function lineToBlock(line: string): NotionBlock {
	const heading = line.match(/^(#{1,3})\s+(.*)$/);
	if (heading) { return textBlock(`heading_${heading[1].length}`, heading[2]); }
	const todo = line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
	if (todo) { return textBlock('to_do', todo[2], { checked: todo[1].toLowerCase() === 'x' }); }
	const bullet = line.match(/^\s*[-*]\s+(.*)$/);
	if (bullet) { return textBlock('bulleted_list_item', bullet[1]); }
	const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
	if (numbered) { return textBlock('numbered_list_item', numbered[1]); }
	if (/^\s*>\s?(.*)$/.test(line)) { return textBlock('quote', line.replace(/^\s*>\s?/, '')); }
	if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { return { type: 'divider', divider: {} } as NotionBlock; }
	return textBlock('paragraph', line);
}

/** Convert Markdown into a flat list of Notion block create objects. */
export function markdownToBlocks(md: string): NotionBlock[] {
	const blocks: NotionBlock[] = [];
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(/^```(\w*)\s*$/);
		if (fence) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i++]); }
			i++; // closing fence
			blocks.push({ type: 'code', code: {
				rich_text: [{ type: 'text', text: { content: code.join('\n') } }],
				language: fence[1] || 'plain text',
			} } as NotionBlock);
			continue;
		}
		i++;
		if (line.trim()) { blocks.push(lineToBlock(line)); }
	}
	return blocks;
}

/** Best-effort plain-text title from a page's properties. */
export function pageTitle(page: { properties?: Record<string, unknown> }): string {
	const props = page.properties ?? {};
	for (const value of Object.values(props)) {
		const v = value as { type?: string; title?: RichText[] };
		if (v.type === 'title' && v.title) { return plainOf(v.title) || 'Sem título'; }
	}
	return 'Sem título';
}
