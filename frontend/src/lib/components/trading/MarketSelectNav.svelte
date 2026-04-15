<script lang="ts">
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { TRADING_PAIRS } from '$lib/magicblock';

	const dispatch = createEventDispatcher<{ select: { symbol: string } }>();

	/** Current pair symbol shown on the trigger (e.g. selected tab on terminal). */
	export let selectedSymbol: string;

	const markets = Object.keys(TRADING_PAIRS) as string[];

	let open = false;
	let rootEl: HTMLDivElement;
	let triggerEl: HTMLButtonElement;

	let popTop = 0;
	let popLeft = 0;
	let popMinW = 0;

	function updatePopoverPosition() {
		if (!triggerEl || typeof window === 'undefined') return;
		const r = triggerEl.getBoundingClientRect();
		const gap = 4;
		popTop = r.bottom + gap;
		popLeft = r.left;
		popMinW = Math.max(r.width, 112);
		const pad = 8;
		const vw = window.innerWidth;
		if (popLeft + popMinW > vw - pad) {
			popLeft = Math.max(pad, vw - pad - popMinW);
		}
		if (popLeft < pad) popLeft = pad;
	}

	function onScrollResize() {
		if (open) updatePopoverPosition();
	}

	function removeWindowListeners() {
		if (typeof window === 'undefined') return;
		window.removeEventListener('scroll', onScrollResize, true);
		window.removeEventListener('resize', onScrollResize);
	}

	function closePopover() {
		if (!open) return;
		open = false;
		removeWindowListeners();
	}

	async function openPopover() {
		open = true;
		await tick();
		updatePopoverPosition();
		window.addEventListener('scroll', onScrollResize, true);
		window.addEventListener('resize', onScrollResize);
	}

	async function toggle(e: MouseEvent) {
		e.stopPropagation();
		if (open) {
			closePopover();
		} else {
			await openPopover();
		}
	}

	function pick(sym: string) {
		dispatch('select', { symbol: sym });
		closePopover();
	}

	function onDocClick(e: MouseEvent) {
		if (!open || !rootEl) return;
		const t = e.target as Node;
		if (!rootEl.contains(t)) closePopover();
	}

	function onDocKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') closePopover();
	}

	function syncDocListeners(openVal: boolean) {
		if (typeof document === 'undefined') return;
		document.removeEventListener('click', onDocClick, true);
		document.removeEventListener('keydown', onDocKeydown, true);
		if (openVal) {
			document.addEventListener('click', onDocClick, true);
			document.addEventListener('keydown', onDocKeydown, true);
		}
	}

	$: syncDocListeners(open);

	onDestroy(() => {
		closePopover();
		syncDocListeners(false);
	});
</script>

<div class="market-select" bind:this={rootEl}>
	<button
		type="button"
		class="market-select-trigger"
		class:market-select-trigger--open={open}
		bind:this={triggerEl}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label="Select market"
		on:click={toggle}
	>
		<span class="market-select-label">Selected market</span>
		<span class="market-select-value">{selectedSymbol}</span>
		<span class="market-select-chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<div
			class="market-select-popover"
			role="listbox"
			aria-label="Markets"
			style="top:{popTop}px;left:{popLeft}px;min-width:{popMinW}px"
		>
			<div class="market-select-scroll">
				{#each markets as sym}
					<button
						type="button"
						class="market-select-option"
						class:market-select-option--active={sym === selectedSymbol}
						role="option"
						aria-selected={sym === selectedSymbol}
						on:click|stopPropagation={() => pick(sym)}
					>
						{sym}
						<span class="market-select-suffix">/ USD</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	/* Match `.pyth-status` / `.magicblock-status` in terminal chrome */
	.market-select {
		position: relative;
		flex: 0 0 auto;
		min-width: max-content;
		display: flex;
		align-items: center;
	}

	.market-select-trigger {
		display: inline-flex;
		flex-flow: row nowrap;
		align-items: center;
		gap: var(--nav-pill-gap, 6px);
		padding: var(--nav-pad-y, 5px) var(--nav-pad-x, 10px);
		background: #000;
		border: 1px solid #333;
		color: #ff9500;
		font-family: 'Courier New', 'Lucida Console', monospace;
		font-size: var(--nav-fs, 12px);
		font-weight: bold;
		letter-spacing: 0.04em;
		cursor: pointer;
		white-space: nowrap;
		line-height: 1.25;
		max-width: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.market-select-trigger:hover,
	.market-select-trigger--open {
		border-color: #555;
		background: #0d0d0d;
	}

	.market-select-trigger--open {
		border-color: #ff9500;
	}

	.market-select-label {
		color: #666;
		font-size: var(--nav-label-fs, 11px);
		font-weight: bold;
		letter-spacing: 0.04em;
	}

	.market-select-value {
		color: #00ff00;
		font-size: var(--nav-fs, 12px);
		font-weight: bold;
		min-width: 1.75em;
		text-align: left;
	}

	.market-select-chev {
		color: #999;
		font-size: var(--nav-meta-fs, 10px);
		margin-left: 1px;
	}

	.market-select-popover {
		position: fixed;
		z-index: 12000;
		background: #0a0a0a;
		border: 1px solid #333;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.75);
	}

	.market-select-scroll {
		max-height: min(180px, 42vh);
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: thin;
		scrollbar-color: #ff9500 #111;
		padding: 2px 0;
	}

	.market-select-scroll::-webkit-scrollbar {
		width: 5px;
	}

	.market-select-scroll::-webkit-scrollbar-track {
		background: #111;
	}

	.market-select-scroll::-webkit-scrollbar-thumb {
		background: #ff9500;
		border-radius: 2px;
	}

	.market-select-option {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		padding: var(--nav-pad-y, 5px) var(--nav-pad-x, 10px);
		border: none;
		background: transparent;
		color: #ccc;
		font-family: inherit;
		font-size: var(--nav-fs, 12px);
		font-weight: bold;
		text-align: left;
		cursor: pointer;
		letter-spacing: 0.03em;
	}

	.market-select-option:hover {
		background: rgba(255, 149, 0, 0.1);
		color: #fff;
	}

	.market-select-option--active {
		color: #ff9500;
		background: rgba(255, 149, 0, 0.06);
	}

	.market-select-suffix {
		font-size: var(--nav-label-fs, 11px);
		font-weight: normal;
		color: #666;
	}

	.market-select-option:hover .market-select-suffix,
	.market-select-option--active .market-select-suffix {
		color: #888;
	}
</style>
