import * as https from 'https';
import { NotionBlock } from './notionConvert.js';

const NOTION_HOST = 'api.notion.com';
const NOTION_VERSION = '2022-06-28';
const MAX_DEPTH = 3; // how deep to fetch nested block children

export interface NotionPage {
	id: string;
	last_edited_time: string;
	properties?: Record<string, unknown>;
	url?: string;
}

/** Thin Notion REST client over Node https — no external dependencies. */
export class NotionClient {
	constructor(private readonly token: string) {}

	private request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const payload = body ? JSON.stringify(body) : undefined;
		const options: https.RequestOptions = {
			host: NOTION_HOST,
			path,
			method,
			headers: {
				'Authorization': `Bearer ${this.token}`,
				'Notion-Version': NOTION_VERSION,
				'Content-Type': 'application/json',
				...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
			},
		};
		return new Promise<T>((resolve, reject) => {
			const req = https.request(options, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					const status = res.statusCode ?? 0;
					if (status >= 200 && status < 300) {
						resolve(text ? JSON.parse(text) : ({} as T));
					} else {
						let message = `HTTP ${status}`;
						try { message = JSON.parse(text).message ?? message; } catch { /* keep status */ }
						reject(new Error(message));
					}
				});
			});
			req.on('error', reject);
			if (payload) { req.write(payload); }
			req.end();
		});
	}

	/** Validate the token; returns the integration/bot name. */
	async whoAmI(): Promise<string> {
		const me = await this.request<{ name?: string; bot?: { owner?: unknown } }>('GET', '/v1/users/me');
		return me.name ?? 'Integração Notion';
	}

	/** Search pages the integration can access. */
	async searchPages(query: string): Promise<NotionPage[]> {
		const res = await this.request<{ results: NotionPage[] }>('POST', '/v1/search', {
			query,
			filter: { property: 'object', value: 'page' },
			page_size: 50,
		});
		return res.results ?? [];
	}

	retrievePage(pageId: string): Promise<NotionPage> {
		return this.request<NotionPage>('GET', `/v1/pages/${pageId}`);
	}

	/** Fetch a block's direct children (one page of up to 100). */
	private async childrenOf(blockId: string): Promise<NotionBlock[]> {
		const out: NotionBlock[] = [];
		let cursor: string | undefined;
		do {
			const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
			const res = await this.request<{ results: NotionBlock[]; next_cursor?: string; has_more?: boolean }>(
				'GET', `/v1/blocks/${blockId}/children${qs}`
			);
			out.push(...(res.results ?? []));
			cursor = res.has_more ? res.next_cursor : undefined;
		} while (cursor);
		return out;
	}

	/** Fetch a block tree, recursing into children up to MAX_DEPTH. */
	async blockTree(blockId: string, depth = 0): Promise<NotionBlock[]> {
		const blocks = await this.childrenOf(blockId);
		if (depth >= MAX_DEPTH) { return blocks; }
		for (const block of blocks) {
			if (block.has_children && block.id) {
				block.children = await this.blockTree(block.id, depth + 1);
			}
		}
		return blocks;
	}

	appendChildren(blockId: string, children: NotionBlock[]): Promise<unknown> {
		return this.request('PATCH', `/v1/blocks/${blockId}/children`, { children });
	}

	deleteBlock(blockId: string): Promise<unknown> {
		return this.request('DELETE', `/v1/blocks/${blockId}`);
	}

	/** Replace a page's body: delete existing top-level blocks, append new ones. */
	async replaceContent(pageId: string, children: NotionBlock[]): Promise<void> {
		const existing = await this.childrenOf(pageId);
		for (const block of existing) {
			if (block.id) { await this.deleteBlock(block.id); }
		}
		// Notion caps children appends at 100 per request
		for (let i = 0; i < children.length; i += 100) {
			await this.appendChildren(pageId, children.slice(i, i + 100));
		}
	}
}
