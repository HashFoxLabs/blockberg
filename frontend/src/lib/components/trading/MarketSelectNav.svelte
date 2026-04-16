<script lang="ts">
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { ALL_MARKETS } from '$lib/magicblock';

	const dispatch = createEventDispatcher<{ select: { symbol: string } }>();

	export let selectedSymbol: string;

	const markets = ALL_MARKETS as readonly string[];

	let query = '';
	let open = false;
	let inputEl: HTMLInputElement;
	let wrapEl: HTMLDivElement;
	let activeIdx = -1;

	// Fixed-position coordinates for the dropdown so it escapes overflow:hidden parents
	let dropTop = 0;
	let dropLeft = 0;
	let dropWidth = 0;

	$: filtered = query.trim() === ''
		? markets
		: markets.filter((s) => s.toLowerCase().includes(query.trim().toLowerCase()));

	$: if (open) activeIdx = -1;

	function calcDropdownPos() {
		if (!wrapEl || typeof window === 'undefined') return;
		const r = wrapEl.getBoundingClientRect();
		dropTop = r.bottom + 4;
		dropLeft = r.left;
		dropWidth = r.width;
	}

	async function openDropdown() {
		open = true;
		await tick();
		calcDropdownPos();
		window.addEventListener('scroll', calcDropdownPos, true);
		window.addEventListener('resize', calcDropdownPos);
	}

	function closeDropdown() {
		open = false;
		query = '';
		activeIdx = -1;
		window.removeEventListener('scroll', calcDropdownPos, true);
		window.removeEventListener('resize', calcDropdownPos);
	}

	function pick(sym: string) {
		dispatch('select', { symbol: sym });
		closeDropdown();
	}

	function onFocus() {
		openDropdown();
	}

	function onInput() {
		open = true;
		calcDropdownPos();
		activeIdx = -1;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIdx = Math.min(activeIdx + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIdx = Math.max(activeIdx - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (activeIdx >= 0 && filtered[activeIdx]) pick(filtered[activeIdx]);
		} else if (e.key === 'Escape') {
			closeDropdown();
			inputEl?.blur();
		}
	}

	function onDocClick(e: MouseEvent) {
		if (!open || !wrapEl) return;
		const target = e.target as Node;
		// Check both the input wrap and the portal dropdown
		const portalEl = document.getElementById('market-search-portal');
		if (!wrapEl.contains(target) && !portalEl?.contains(target)) closeDropdown();
	}

	$: if (typeof document !== 'undefined') {
		if (open) {
			document.addEventListener('mousedown', onDocClick, true);
		} else {
			document.removeEventListener('mousedown', onDocClick, true);
		}
	}

	onDestroy(() => {
		if (typeof document !== 'undefined') {
			document.removeEventListener('mousedown', onDocClick, true);
		}
		window.removeEventListener('scroll', calcDropdownPos, true);
		window.removeEventListener('resize', calcDropdownPos);
	});
</script>

<div class="market-search" bind:this={wrapEl}>
	<div class="market-search-input-wrap" class:open>
		<span class="market-search-icon">⌕</span>
		<input
			bind:this={inputEl}
			type="text"
			class="market-search-input"
			placeholder="Search market…"
			autocomplete="off"
			spellcheck="false"
			bind:value={query}
			on:focus={onFocus}
			on:input={onInput}
			on:keydown={onKeydown}
		/>
		<span class="market-search-active">{selectedSymbol}</span>
	</div>
</div>

{#if open && filtered.length > 0}
	<div
		id="market-search-portal"
		class="market-search-dropdown"
		style="top:{dropTop}px; left:{dropLeft}px; min-width:{dropWidth}px;"
	>
		{#each filtered as sym, i}
			<button
				type="button"
				class="market-search-option"
				class:active={sym === selectedSymbol}
				class:highlighted={i === activeIdx}
				on:mousedown|preventDefault={() => pick(sym)}
			>
				<span class="opt-sym">{sym}</span>
				<span class="opt-pair">/ USDT</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.market-search {
		position: relative;
		flex: 0 0 auto;
		display: flex;
		align-items: center;
	}

	.market-search-input-wrap {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 5px 10px;
		background: #000;
		border: 1px solid #333;
		transition: border-color 0.15s ease;
		min-width: 180px;
	}

	.market-search-input-wrap.open {
		border-color: #ff9500;
	}

	.market-search-icon {
		color: #555;
		font-size: 13px;
		flex-shrink: 0;
		user-select: none;
	}

	.market-search-input {
		background: transparent;
		border: none;
		outline: none;
		color: #ccc;
		font-family: 'Courier New', 'Lucida Console', monospace;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 0.04em;
		width: 80px;
	}

	.market-search-input::placeholder {
		color: #444;
		font-weight: normal;
	}

	.market-search-active {
		color: #00ff00;
		font-family: 'Courier New', 'Lucida Console', monospace;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 0.04em;
		flex-shrink: 0;
		margin-left: 2px;
	}

	/* Dropdown rendered outside the component via Svelte teleport-style markup */
	:global(.market-search-dropdown) {
		position: fixed;
		z-index: 12000;
		background: #0a0a0a;
		border: 1px solid #333;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.8);
		max-height: 260px;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: thin;
		scrollbar-color: #ff9500 #111;
		padding: 2px 0;
	}

	:global(.market-search-dropdown::-webkit-scrollbar) { width: 5px; }
	:global(.market-search-dropdown::-webkit-scrollbar-track) { background: #111; }
	:global(.market-search-dropdown::-webkit-scrollbar-thumb) { background: #ff9500; border-radius: 2px; }

	:global(.market-search-option) {
		display: flex;
		align-items: baseline;
		gap: 6px;
		width: 100%;
		padding: 5px 12px;
		border: none;
		background: transparent;
		color: #ccc;
		font-family: 'Courier New', 'Lucida Console', monospace;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 0.03em;
		text-align: left;
		cursor: pointer;
	}

	:global(.market-search-option:hover),
	:global(.market-search-option.highlighted) {
		background: rgba(255, 149, 0, 0.1);
		color: #fff;
	}

	:global(.market-search-option.active) {
		color: #ff9500;
		background: rgba(255, 149, 0, 0.06);
	}

	:global(.opt-sym) { font-size: 12px; }

	:global(.opt-pair) {
		font-size: 10px;
		font-weight: normal;
		color: #555;
	}

	:global(.market-search-option:hover .opt-pair),
	:global(.market-search-option.highlighted .opt-pair),
	:global(.market-search-option.active .opt-pair) {
		color: #888;
	}
</style>
