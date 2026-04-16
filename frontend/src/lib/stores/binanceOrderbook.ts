import { writable } from 'svelte/store';

export type OrderBookRow = { price: number; size: number; total: number };
export type TradeRow = { side: 'buy' | 'sell'; price: number; size: number; t: string };

export type OrderBookData = {
	asks: OrderBookRow[];
	bids: OrderBookRow[];
	spreadAbs: number;
	spreadPct: number;
};

const SYMBOL_MAP: Record<string, string> = {
	SOL: 'solusdt',
	BTC: 'btcusdt',
	ETH: 'ethusdt',
	AVAX: 'avaxusdt',
	LINK: 'linkusdt',
};

const DEPTH_LEVELS = 14;
const MAX_TRADES = 50;

const emptyBook = (): OrderBookData => ({ asks: [], bids: [], spreadAbs: 0, spreadPct: 0 });

export const binanceOrderBook = writable<OrderBookData>(emptyBook());
export const binanceTrades = writable<TradeRow[]>([]);
export const binanceStatus = writable('Disconnected');

let ws: WebSocket | null = null;
let currentSymbol = '';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSymbol = '';

function processDepth(data: { bids: [string, string][]; asks: [string, string][] }): OrderBookData {
	const asks: OrderBookRow[] = data.asks.slice(0, DEPTH_LEVELS).map(([p, q]) => ({
		price: parseFloat(p),
		size: parseFloat(q),
		total: 0,
	}));

	const bids: OrderBookRow[] = data.bids.slice(0, DEPTH_LEVELS).map(([p, q]) => ({
		price: parseFloat(p),
		size: parseFloat(q),
		total: 0,
	}));

	// Cumulative depth totals
	let cum = 0;
	for (const row of asks) { cum += row.size; row.total = cum; }
	cum = 0;
	for (const row of bids) { cum += row.size; row.total = cum; }

	const bestAsk = asks[0]?.price ?? 0;
	const bestBid = bids[0]?.price ?? 0;
	const spreadAbs = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
	const mid = (bestAsk + bestBid) / 2;
	const spreadPct = mid > 0 ? (spreadAbs / mid) * 100 : 0;

	return { asks, bids, spreadAbs, spreadPct };
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = d.getHours().toString().padStart(2, '0');
	const m = d.getMinutes().toString().padStart(2, '0');
	const s = d.getSeconds().toString().padStart(2, '0');
	return `${h}:${m}:${s}`;
}

export function connectBinance(tabSymbol: string): void {
	const binanceSym = SYMBOL_MAP[tabSymbol];
	if (!binanceSym) return;

	// Already connected to this symbol
	if (currentSymbol === binanceSym && ws && ws.readyState === WebSocket.OPEN) return;

	// Cancel any pending reconnect
	if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

	// Close existing connection without triggering auto-reconnect
	if (ws) {
		ws.onclose = null;
		ws.close();
		ws = null;
	}

	currentSymbol = binanceSym;
	pendingSymbol = tabSymbol;

	// Reset data for the new symbol
	binanceOrderBook.set(emptyBook());
	binanceTrades.set([]);
	binanceStatus.set('Connecting...');

	const streams = `${binanceSym}@depth20@100ms/${binanceSym}@trade`;
	ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

	ws.onopen = () => {
		binanceStatus.set('Live');
	};

	ws.onmessage = (event: MessageEvent) => {
		try {
			const msg = JSON.parse(event.data as string) as { stream: string; data: any };
			const stream = msg.stream ?? '';
			const data = msg.data;

			if (stream.includes('@depth')) {
				binanceOrderBook.set(processDepth(data));
			} else if (stream.includes('@trade')) {
				// m = true  →  buyer is market maker  →  the aggressor sold (sell trade)
				const side: 'buy' | 'sell' = data.m ? 'sell' : 'buy';
				const trade: TradeRow = {
					side,
					price: parseFloat(data.p),
					size: parseFloat(data.q),
					t: formatTime(data.T),
				};
				binanceTrades.update((trades) => [trade, ...trades].slice(0, MAX_TRADES));
			}
		} catch {
			// ignore malformed frames
		}
	};

	ws.onerror = () => {
		binanceStatus.set('Error');
	};

	ws.onclose = () => {
		if (currentSymbol === binanceSym) {
			binanceStatus.set('Reconnecting...');
			reconnectTimer = setTimeout(() => connectBinance(pendingSymbol), 3000);
		}
	};
}

export function disconnectBinance(): void {
	if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
	if (ws) {
		ws.onclose = null;
		ws.close();
		ws = null;
	}
	currentSymbol = '';
	binanceStatus.set('Disconnected');
}
