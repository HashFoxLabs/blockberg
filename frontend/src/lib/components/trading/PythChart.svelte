<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { pythPrices } from '$lib/stores/pythPrices';
	import {
		createChart,
		CandlestickSeries,
		type IChartApi,
		type ISeriesApi,
		type CandlestickData,
		type CandlestickSeriesOptions,
		type Time,
		CrosshairMode,
		LineStyle,
	} from 'lightweight-charts';

	export let symbol: string = 'SOL';
	export let interval: string = '1m';

	const INTERVALS: Record<string, number> = {
		'1m': 60,
		'5m': 300,
		'15m': 900,
		'1h': 3600,
		'4h': 14400,
		'1d': 86400,
	};

	// How many bars to show in the default visible window
	const DEFAULT_BARS: Record<string, number> = {
		'1m':  480,   // ~8h
		'5m':  288,   // 1 day
		'15m': 192,   // 2 days
		'1h':  168,   // 1 week
		'4h':  180,   // 1 month
		'1d':  365,   // 1 year
	};
	const INTERVAL_LABELS = Object.keys(INTERVALS);

	let container: HTMLDivElement;
	let chart: IChartApi | null = null;
	let candleSeries: ISeriesApi<'Candlestick', Time> | null = null;
	let currentBar: CandlestickData<Time> | null = null;
	let unsubPrices: (() => void) | undefined;

	// Track which symbol+interval is currently rendered to avoid double-init
	let activeKey = '';

	// ── Helpers ───────────────────────────────────────────────────────────────

	function barTime(ts: number, bucketSec: number): Time {
		return (Math.floor(ts / 1000 / bucketSec) * bucketSec) as Time;
	}

	// ── Historical candles from Binance ───────────────────────────────────────

	async function fetchCandles(sym: string, iv: string): Promise<CandlestickData<Time>[]> {
		const url = `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${iv}&limit=1000`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Binance ${res.status}`);
		const raw: any[][] = await res.json();
		return raw.map((k) => ({
			time: Math.floor(Number(k[0]) / 1000) as Time,
			open:  parseFloat(k[1]),
			high:  parseFloat(k[2]),
			low:   parseFloat(k[3]),
			close: parseFloat(k[4]),
		}));
	}

	// ── Init / reinit ─────────────────────────────────────────────────────────

	async function initChart(sym: string, iv: string) {
		const key = `${sym}:${iv}`;
		if (!container) return;

		// Destroy old instance if pair/interval changed
		if (chart) {
			chart.remove();
			chart = null;
			candleSeries = null;
			currentBar = null;
		}

		activeKey = key;

		chart = createChart(container, {
			autoSize: true,
			layout: {
				background: { color: '#0d0d0d' },
				textColor: '#8a8f9a',
				fontFamily: 'Inter, ui-monospace, monospace',
				fontSize: 11,
			},
			grid: {
				vertLines: { color: '#1a1a1a' },
				horzLines: { color: '#1a1a1a' },
			},
			crosshair: {
				mode: CrosshairMode.Normal,
				vertLine: { color: '#444', style: LineStyle.Dashed },
				horzLine: { color: '#444', style: LineStyle.Dashed },
			},
			rightPriceScale: { borderColor: '#1e1e1e' },
			timeScale: {
				borderColor: '#1e1e1e',
				timeVisible: true,
				secondsVisible: iv === '1m',
			},
		});

		candleSeries = chart.addSeries(CandlestickSeries, {
			upColor:        '#00c076',
			downColor:      '#ff4560',
			borderUpColor:  '#00c076',
			borderDownColor:'#ff4560',
			wickUpColor:    '#00c076',
			wickDownColor:  '#ff4560',
			priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
		} satisfies Partial<CandlestickSeriesOptions>);

		// Load history — guard against a stale call if the user already switched pair
		try {
			const candles = await fetchCandles(sym, iv);
			if (activeKey !== key) return; // switched while fetching — discard
			if (candleSeries && candles.length) {
				candleSeries.setData(candles);
				const bars = DEFAULT_BARS[iv] ?? 96;
				const to = candles.length - 1;
				const from = Math.max(0, to - bars);
				chart.timeScale().setVisibleLogicalRange({ from, to: to + 3 }); // +3 gives a small right margin
				currentBar = { ...candles[candles.length - 1] };
			}
		} catch (e) {
			console.warn('[PythChart] history fetch failed:', e);
		}
	}

	// ── Pyth tick → live candle update ────────────────────────────────────────

	function onPriceUpdate(price: number) {
		if (!candleSeries || price <= 0) return;
		const bucket = INTERVALS[interval] ?? 60;
		const t = barTime(Date.now(), bucket);

		if (!currentBar || currentBar.time !== t) {
			if (currentBar) candleSeries.update(currentBar);
			currentBar = { time: t, open: price, high: price, low: price, close: price };
		} else {
			currentBar = {
				...currentBar,
				high:  Math.max(currentBar.high, price),
				low:   Math.min(currentBar.low, price),
				close: price,
			};
		}
		candleSeries.update(currentBar);
	}

	// ── Subscribe to Pyth ─────────────────────────────────────────────────────

	function subscribePrices() {
		unsubPrices?.();
		unsubPrices = pythPrices.subscribe((prices) => {
			onPriceUpdate(prices[symbol]?.price ?? 0);
		});
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	onMount(async () => {
		await initChart(symbol, interval);
		subscribePrices();
	});

	onDestroy(() => {
		unsubPrices?.();
		chart?.remove();
	});

	// ── React to symbol / interval changes after mount ────────────────────────
	// Use a prev-value guard so this never fires on the initial mount render.

	let prevSymbol = symbol;
	let prevInterval = interval;

	$: if (symbol !== prevSymbol || interval !== prevInterval) {
		prevSymbol = symbol;
		prevInterval = interval;
		if (chart !== null || activeKey !== '') {
			initChart(symbol, interval).then(subscribePrices);
		}
	}
</script>

<div class="pyth-chart-wrap">
	<div class="pyth-chart-toolbar">
		{#each INTERVAL_LABELS as iv}
			<button
				type="button"
				class="iv-btn"
				class:iv-active={interval === iv}
				on:click={() => { interval = iv; }}
			>{iv}</button>
		{/each}
	</div>
	<div class="pyth-chart-canvas" bind:this={container}></div>
</div>

<style>
	.pyth-chart-wrap {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		background: #0d0d0d;
	}

	.pyth-chart-toolbar {
		display: flex;
		gap: 2px;
		padding: 5px 8px;
		border-bottom: 1px solid #1e1e1e;
		flex-shrink: 0;
	}

	.iv-btn {
		padding: 3px 8px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 3px;
		color: #5e6673;
		font-size: 10px;
		font-weight: 600;
		cursor: pointer;
		letter-spacing: 0.04em;
		transition: color 0.1s, border-color 0.1s;
	}

	.iv-btn:hover {
		color: #ccc;
		border-color: #333;
	}

	.iv-btn.iv-active {
		color: #ff9500;
		border-color: #ff9500;
	}

	.pyth-chart-canvas {
		flex: 1;
		min-height: 0;
	}
</style>
