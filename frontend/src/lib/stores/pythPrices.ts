import { writable } from 'svelte/store';
import { HermesClient } from '@pythnetwork/hermes-client';
import { HERMES_URL, PYTH_API_KEY, PYTH_FEEDS } from '$lib/env';

export type PriceData = {
	price: number;
	change: number;
	confidence: number;
	emaPrice: number;
	publishTime: number;
	spread: number;
};

// Map hex feed ID (without 0x prefix) → symbol
const FEED_ID_TO_SYMBOL: Record<string, string> = {};
for (const [symbol, id] of Object.entries(PYTH_FEEDS)) {
	FEED_ID_TO_SYMBOL[id.replace(/^0x/, '')] = symbol;
}

const ALL_FEED_IDS = Object.values(PYTH_FEEDS);

const emptyPrice = (): PriceData => ({
	price: 0,
	change: 0,
	confidence: 0,
	emaPrice: 0,
	publishTime: 0,
	spread: 0,
});

export const pythPrices = writable<Record<string, PriceData>>(
	Object.fromEntries(Object.keys(PYTH_FEEDS).map((s) => [s, emptyPrice()]))
);

export const pythConnectionStatus = writable('Initializing...');
export const pythLastUpdate = writable(0);

let eventSource: EventSource | null = null;
let previousPrices: Record<string, number> = {};
let connecting = false;

function buildClient(): HermesClient {
	const config = PYTH_API_KEY
		? { headers: { Authorization: `Bearer ${PYTH_API_KEY}` } }
		: {};
	return new HermesClient(HERMES_URL, config);
}

function parseFeedUpdate(priceData: {
	id: string;
	price: { price: string; expo: number; conf: string; publish_time: number };
	ema_price: { price: string; expo: number };
}) {
	const symbol = FEED_ID_TO_SYMBOL[priceData.id];
	if (!symbol) return null;

	const price = parseFloat(priceData.price.price) * Math.pow(10, priceData.price.expo);
	const confidence = parseFloat(priceData.price.conf) * Math.pow(10, priceData.price.expo);
	const emaPrice = parseFloat(priceData.ema_price.price) * Math.pow(10, priceData.ema_price.expo);
	const publishTime = priceData.price.publish_time;
	const spread = price > 0 ? (confidence / price) * 100 : 0;

	const prevPrice = previousPrices[symbol] || price;
	const change = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
	previousPrices[symbol] = price;

	return { symbol, price, confidence, emaPrice, publishTime, spread, change };
}

export async function startPythStream(): Promise<void> {
	if (eventSource || connecting) return;

	connecting = true;
	pythConnectionStatus.set('Connecting...');

	try {
		const client = buildClient();
		eventSource = await client.getPriceUpdatesStream(ALL_FEED_IDS, {
			parsed: true,
			allowUnordered: false,
		});

		eventSource.onopen = () => {
			pythConnectionStatus.set(`Live · ${ALL_FEED_IDS.length} feeds`);
		};

		eventSource.onmessage = (event: MessageEvent) => {
			try {
				const update = JSON.parse(event.data as string);
				const feeds: any[] = update.parsed ?? [];
				if (feeds.length === 0) return;

				pythPrices.update((prices) => {
					for (const priceData of feeds) {
						const parsed = parseFeedUpdate(priceData);
						if (!parsed) continue;
						prices[parsed.symbol] = {
							price: parsed.price,
							change: parsed.change,
							confidence: parsed.confidence,
							emaPrice: parsed.emaPrice,
							publishTime: parsed.publishTime,
							spread: parsed.spread,
						};
					}
					return prices;
				});

				pythLastUpdate.set(Date.now());
			} catch {
				// ignore malformed SSE frames
			}
		};

		eventSource.onerror = () => {
			pythConnectionStatus.set('Reconnecting...');
			// EventSource reconnects automatically; clear so a manual restart can re-init
			eventSource = null;
			connecting = false;
		};
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		pythConnectionStatus.set(`Error: ${msg}`);
		eventSource = null;
	} finally {
		connecting = false;
	}
}

export function stopPythStream(): void {
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
	connecting = false;
}
