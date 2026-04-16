<script lang="ts">
	import { onMount } from 'svelte';
	import { magicBlockClient, TRADING_PAIRS, PAIR_DECIMALS } from '$lib/magicblock';
	import { walletStore } from '$lib/wallet/stores';
	import WalletButton from '$lib/wallet/WalletButton.svelte';
	import TerminalTopChrome from '$lib/components/trading/TerminalTopChrome.svelte';
	import Toast from '$lib/toast/Toast.svelte';
	import { toastStore } from '$lib/toast/store';
	import { supabase, isSupabaseConfigured } from '$lib/supabase';

	type PriceData = {
		price: number;
		change: number;
		confidence: number;
		emaPrice: number;
		publishTime: number;
		spread: number;
	};

	let connectedWallet: any = null;
	let walletAddress = '';
	let isLoading = true;

	let tradeHistory: any[] = [];
	/** Available paper USDT (same as terminal free balance); `null` = not loaded yet */
	let usdtAvailable: number | null = null;

	async function refreshUsdtBalance() {
		if (!connectedWallet?.connected) {
			usdtAvailable = null;
			return;
		}
		try {
			const data = await magicBlockClient.getAllUserAccountData();
			const row = data[0];
			if (!row) {
				usdtAvailable = 0;
				return;
			}
			const free =
				typeof row.availableUsd === 'number'
					? row.availableUsd
					: Math.max(0, row.tokenInBalance - (row.lockedMarginUsd ?? 0));
			usdtAvailable = free;
		} catch {
			usdtAvailable = null;
		}
	}

	walletStore.subscribe(wallet => {
		connectedWallet = wallet;
		if (wallet.connected && wallet.publicKey) {
			walletAddress = wallet.publicKey.toBase58();
			magicBlockClient.setConnectedWallet(wallet.adapter);
			loadHistory();
			void refreshUsdtBalance();
		} else {
			walletAddress = '';
			tradeHistory = [];
			usdtAvailable = null;
			isLoading = false;
		}
	});

	async function loadHistory() {
		if (!connectedWallet?.connected) return;
		isLoading = true;
		try {
			const allTrades = await magicBlockClient.fetchTradeHistory();
			tradeHistory = allTrades.filter((t: any) =>
				t.status === 'CLOSED' ||
				t.status === 'COMPLETED' ||
				t.status === 'CANCELLED' ||
				t.status === 'LIQUIDATED' ||
				t.tradeType === 'BUY' ||
				t.tradeType === 'SELL'
			);
		} catch (e) {
			console.error('Failed to load history:', e);
		} finally {
			isLoading = false;
		}
	}

	function onChromePrices(e: CustomEvent<Record<string, PriceData>>) {
		// keep prices live for the chrome ticker
	}

	// Post trade modal
	let showPostModal = false;
	let selectedTrade: any = null;
	let postAnalysis = '';
	let isPosting = false;

	function openPost(trade: any) {
		selectedTrade = trade;
		postAnalysis = '';
		showPostModal = true;
	}

	function closePost() {
		showPostModal = false;
		selectedTrade = null;
		postAnalysis = '';
	}

	async function submitPost() {
		if (!supabase || !isSupabaseConfigured) {
			toastStore.error('Not configured', 'Supabase is not set up.');
			return;
		}
		if (!selectedTrade || !walletAddress) return;
		const trade = selectedTrade;
		if (trade.tradeType !== 'LONG' && trade.tradeType !== 'SHORT') {
			toastStore.error('Invalid trade', 'Only closed LONG/SHORT positions can be posted.');
			return;
		}
		isPosting = true;
		try {
			const pairIndex = trade.pairIndex ?? TRADING_PAIRS[trade.pairSymbol as keyof typeof TRADING_PAIRS];
			const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
			if (!pairDecimals) throw new Error('Unknown trading pair');

			const { error } = await supabase.from('trade_posts').insert({
				owner_pubkey: walletAddress,
				pair_index: pairIndex,
				position_id: parseInt(trade.positionId || '0', 10),
				position_type: trade.tradeType === 'LONG' ? 'Long' : 'Short',
				amount_token_out: BigInt(Math.round((trade.size || 0) * Math.pow(10, pairDecimals.tokenOut))).toString(),
				entry_price: BigInt(Math.round((trade.entryPrice || 0) * 1e6)).toString(),
				exit_price: BigInt(Math.round((trade.exitPrice || trade.entryPrice || 0) * 1e6)).toString(),
				take_profit_price: trade.takeProfitPrice ? BigInt(Math.round(trade.takeProfitPrice * 1e6)).toString() : null,
				stop_loss_price: trade.stopLossPrice ? BigInt(Math.round(trade.stopLossPrice * 1e6)).toString() : null,
				opened_at: trade.openedAt ? BigInt(Math.floor(trade.openedAt.getTime() / 1000)).toString() : '0',
				closed_at: trade.closedAt ? BigInt(Math.floor(trade.closedAt.getTime() / 1000)).toString() : BigInt(Math.floor(Date.now() / 1000)).toString(),
				position_pubkey: trade.pubkey || null,
				author_username: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
				analysis: postAnalysis.trim() || null,
			});
			if (error) {
				if (error.code === '23505') toastStore.error('Already posted', 'This trade is already in the feed.');
				else throw error;
				return;
			}
			toastStore.success('Posted', 'Trade is live on the feed.');
			closePost();
		} catch (e: any) {
			toastStore.error('Post failed', e?.message || String(e));
		} finally {
			isPosting = false;
		}
	}

	function formatDate(d: Date | null | undefined): string {
		if (!d) return '—';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
			' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function typeLabel(t: any): string {
		const mode = t.tradeMode === 'perp' ? 'Perp' : 'Spot';
		const dir = t.tradeType || t.direction || '';
		return `${dir} · ${mode}`;
	}

	function closeReason(t: any): string {
		if (t.status === 'CANCELLED') return 'Cancelled';
		if (t.status === 'LIQUIDATED') return 'Liquidated';
		if (t.closeReason === 'TakeProfit') return 'TP';
		if (t.closeReason === 'StopLoss') return 'SL';
		if (t.closeReason === 'Manual') return 'Manual';
		return '—';
	}

	/** CSS suffix for `.hist-reason--{tone}` */
	function reasonTone(t: any): 'manual' | 'tp' | 'sl' | 'liq' | 'cancel' | 'none' {
		if (t.status === 'CANCELLED') return 'cancel';
		if (t.status === 'LIQUIDATED') return 'liq';
		if (t.closeReason === 'TakeProfit') return 'tp';
		if (t.closeReason === 'StopLoss') return 'sl';
		if (t.closeReason === 'Manual') return 'manual';
		if (t.closeReason === 'Liquidation') return 'liq';
		return 'none';
	}

	onMount(() => {});
</script>

<Toast />

<div class="history-page">
	<TerminalTopChrome
		activeSection="dashboard"
		on:prices={onChromePrices}
		on:accountschanged={() => {
			void loadHistory();
			void refreshUsdtBalance();
		}}
	/>

	<div class="history-body">
		{#if !connectedWallet?.connected}
			<div class="empty-wall">
				<span class="empty-wall-icon">⬡</span>
				<p class="empty-wall-title">Connect your wallet</p>
				<p class="empty-wall-sub">Your transaction history will appear here.</p>
				<WalletButton />
			</div>
		{:else}
			<div class="history-panel">
				<div class="history-header">
					<div class="history-header-main">
						<span class="history-title">TRANSACTION HISTORY</span>
						{#if usdtAvailable !== null}
							<span class="history-usdt" title="Available paper USDT (after locked margin)">
								{usdtAvailable.toFixed(2)} USDT
							</span>
						{:else}
							<span class="history-usdt history-usdt--pending" title="Loading balance…">…</span>
						{/if}
					</div>
					<button
						class="hist-refresh"
						on:click={() => {
							void loadHistory();
							void refreshUsdtBalance();
						}}>↻ Refresh</button>
				</div>

				{#if isLoading}
					<div class="hist-loading" role="status" aria-live="polite" aria-busy="true">
						<div class="hist-spinner" aria-hidden="true"></div>
						<p class="hist-loading-text">Loading history…</p>
					</div>
				{:else if tradeHistory.length === 0}
					<div class="hist-empty">No closed trades yet. Execute and close a position to see it here.</div>
				{:else}
					<div class="hist-col-header">
						<span>Date / Time</span>
						<span>Pair</span>
						<span>Type</span>
						<span class="num">Entry</span>
						<span class="num">Close</span>
						<span class="num">Size</span>
						<span class="num">Margin</span>
						<span class="num">P&amp;L</span>
						<span>Reason</span>
						<span class="hist-col-action-head" aria-hidden="true"></span>
					</div>
					<div class="hist-list">
						{#each tradeHistory as t}
							{@const isPerp = t.tradeMode === 'perp'}
							{@const isLong = (t.tradeType || t.direction || '') === 'LONG'}
							{@const isShort = (t.tradeType || t.direction || '') === 'SHORT'}
							{@const isBuy = (t.tradeType || '') === 'BUY'}
							{@const pnl = t.pnl ?? null}
							{@const rowWhen = t.closedAt ?? t.timestamp ?? t.openedAt}
							{@const entryPx = t.entryPrice ?? t.price}
							{@const closePx = t.exitPrice ?? t.closePrice}
							<div class="hist-row" class:hist-row--perp={isPerp} class:hist-row--spot={!isPerp}>
								<span class="hist-date">{formatDate(rowWhen)}</span>
								<span class="hist-pair">{t.pairSymbol || t.pair?.split('/')[0] || '—'}/USDT</span>
								<span class="hist-type">
									<span
										class="hist-side"
										class:side-long={isLong || isBuy}
										class:side-short={isShort}
									>{t.tradeType || t.direction || '—'}</span>
									<span class="hist-mode" class:hist-mode--perp={isPerp} class:hist-mode--spot={!isPerp}
										>{isPerp ? 'Perp' : 'Spot'}{isPerp && t.leverage > 1 ? ` ${t.leverage}x` : ''}</span>
								</span>
								<span class="hist-num">{entryPx != null ? '$' + Number(entryPx).toFixed(4) : '—'}</span>
								<span class="hist-num">{closePx != null ? '$' + Number(closePx).toFixed(4) : '—'}</span>
								<span class="hist-num hist-size"
									>{#if isPerp && t.sizeUSDT != null}
										<span class="hist-size-main">{t.size != null ? t.size.toFixed(4) + ' ' + (t.pairSymbol || '') : '—'}</span>
										<span class="hist-size-sub">${Number(t.sizeUSDT).toFixed(2)} notional</span>
									{:else if t.size != null}
										{t.size.toFixed(4)} {t.pairSymbol || ''}
									{:else}
										—
									{/if}</span>
								<span class="hist-num">{isPerp && t.marginUsd != null ? '$' + Number(t.marginUsd).toFixed(2) : '—'}</span>
								<span
									class="hist-num hist-pnl"
									class:hist-pnl--dash={pnl === null || !isPerp}
									class:pnl-pos={pnl !== null && isPerp && pnl >= 0}
									class:pnl-neg={pnl !== null && isPerp && pnl < 0}
								>
									{#if pnl !== null && isPerp}
										{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USDT
									{:else}
										—
									{/if}
								</span>
								<span class="hist-reason hist-reason--{reasonTone(t)}">{closeReason(t)}</span>
								<span class="hist-action">
									{#if (isLong || isShort) && t.status === 'CLOSED'}
										<button
											class="hist-post-btn"
											disabled={!isSupabaseConfigured}
											title={isSupabaseConfigured ? 'Share to feed' : 'Supabase not configured'}
											on:click={() => openPost(t)}
										>POST</button>
									{/if}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

{#if showPostModal && selectedTrade}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
	<div class="post-overlay" role="dialog" aria-modal="true" on:click={closePost} on:keydown={(e) => e.key === 'Escape' && closePost()}>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="post-modal" on:click|stopPropagation>
			<div class="post-modal-header">
				<span class="post-modal-title">Post to Feed</span>
				<button class="post-modal-close" on:click={closePost}>✕</button>
			</div>
			<div class="post-trade-summary">
				<span class="pts-pair">{selectedTrade.pairSymbol}/USDT</span>
				<span class="pts-dir" class:side-long={selectedTrade.tradeType === 'LONG'} class:side-short={selectedTrade.tradeType === 'SHORT'}>{selectedTrade.tradeType}</span>
				<span class="pts-detail">{selectedTrade.size?.toFixed(4)} @ ${selectedTrade.entryPrice?.toFixed(4)} → ${selectedTrade.exitPrice?.toFixed(4)}</span>
				{#if selectedTrade.pnl != null}
					<span class="pts-pnl" class:pnl-pos={selectedTrade.pnl >= 0} class:pnl-neg={selectedTrade.pnl < 0}>
						{selectedTrade.pnl >= 0 ? '+' : ''}{selectedTrade.pnl.toFixed(2)} USDT
					</span>
				{/if}
			</div>
			<label class="post-label" for="post-analysis">Analysis (optional)</label>
			<textarea
				id="post-analysis"
				class="post-textarea"
				placeholder="Share your setup, thesis, or lessons learned…"
				bind:value={postAnalysis}
				rows="4"
			></textarea>
			<div class="post-modal-actions">
				<button class="post-cancel" disabled={isPosting} on:click={closePost}>Cancel</button>
				<button class="post-submit" disabled={isPosting} on:click={submitPost}>
					{isPosting ? 'Posting…' : 'Post to Feed'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #000;
		color: #e6e8ea;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
	}

	.history-page {
		min-height: 100vh;
		background: #000;
		display: flex;
		flex-direction: column;
	}

	.history-body {
		flex: 1;
		padding: 16px 20px;
		display: flex;
		flex-direction: column;
	}

	/* ── Empty wall ── */
	.empty-wall {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		color: #4b5563;
	}

	.empty-wall-icon {
		font-size: 36px;
		opacity: 0.4;
	}

	.empty-wall-title {
		margin: 0;
		font-size: 14px;
		font-weight: 700;
		color: #6b7280;
		letter-spacing: 0.5px;
	}

	.empty-wall-sub {
		margin: 0 0 12px;
		font-size: 11px;
		color: #374151;
	}

	/* ── Panel ── */
	.history-panel {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.history-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 1px solid #1a1a1a;
		flex-shrink: 0;
	}

	.history-header-main {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 10px 14px;
		min-width: 0;
	}

	.history-title {
		font-size: 10px;
		font-weight: 700;
		color: #ff9500;
		letter-spacing: 0.5px;
	}

	.history-usdt {
		font-size: 11px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: #2ebd85;
		letter-spacing: 0.03em;
	}

	.history-usdt--pending {
		color: #5c6570;
		font-weight: 600;
	}

	.hist-refresh {
		background: transparent;
		border: 1px solid #333;
		color: #ff9500;
		font-size: 9px;
		padding: 4px 10px;
		border-radius: 3px;
		cursor: pointer;
		font-family: inherit;
	}

	.hist-refresh:hover {
		border-color: #ff9500;
	}

	.hist-empty {
		padding: 40px 20px;
		text-align: center;
		font-size: 11px;
		color: #4b5563;
	}

	.hist-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 14px;
		padding: 48px 20px;
		min-height: 220px;
	}

	.hist-spinner {
		width: 36px;
		height: 36px;
		border: 3px solid #2a2a2a;
		border-top-color: #ff9500;
		border-radius: 50%;
		animation: hist-spin 0.7s linear infinite;
	}

	@keyframes hist-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.hist-loading-text {
		margin: 0;
		font-size: 11px;
		color: #6b7280;
		letter-spacing: 0.06em;
	}

	/* ── Column header ── */
	.hist-col-header {
		display: grid;
		grid-template-columns: 140px 100px 120px 110px 110px 130px 82px 100px 72px minmax(56px, 1fr);
		gap: 4px 10px;
		padding: 6px 12px;
		background: #050505;
		border-bottom: 1px solid #1a1a1a;
		position: sticky;
		top: 0;
		z-index: 1;
		flex-shrink: 0;
	}

	.hist-col-header span {
		font-size: 9px;
		font-weight: 700;
		color: #7a8494;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	.hist-col-header .num {
		text-align: right;
	}

	.hist-col-action-head {
		justify-self: end;
	}

	/* ── Scrollable list ── */
	.hist-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 6px 10px;
		overflow-y: auto;
		overflow-x: hidden;
		flex: 1;
		min-height: 0;
	}

	/* ── Row ── */
	.hist-row {
		display: grid;
		grid-template-columns: 140px 100px 120px 110px 110px 130px 82px 100px 72px minmax(56px, 1fr);
		gap: 4px 10px;
		align-items: center;
		padding: 5px 8px;
		background: #101010;
		border: 1px solid #262626;
		border-radius: 3px;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		border-left-width: 3px;
	}

	.hist-row--perp {
		border-left-color: #ff9500;
		background: linear-gradient(90deg, rgba(255, 149, 0, 0.06) 0%, #101010 48px);
	}

	.hist-row--spot {
		border-left-color: #2ebd85;
		background: linear-gradient(90deg, rgba(46, 189, 133, 0.05) 0%, #101010 48px);
	}

	.hist-row:hover {
		background: #141414;
		border-color: #333;
	}

	.hist-row--perp:hover {
		background: linear-gradient(90deg, rgba(255, 149, 0, 0.1) 0%, #141414 52px);
		border-color: #444;
	}

	.hist-row--spot:hover {
		background: linear-gradient(90deg, rgba(46, 189, 133, 0.08) 0%, #141414 52px);
		border-color: #444;
	}

	.hist-date {
		font-size: 10px;
		color: #6b7280;
		white-space: nowrap;
	}

	.hist-pair {
		font-size: 12px;
		font-weight: 700;
		color: #e6e8ea;
		letter-spacing: 0.3px;
	}

	.hist-type {
		display: flex;
		flex-direction: column;
		gap: 0;
		line-height: 1.2;
	}

	.hist-side {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.hist-mode {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
	}

	.hist-mode--perp {
		color: #ff9500;
	}

	.hist-mode--spot {
		color: #3dd4a3;
	}

	.hist-size {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 1px;
		line-height: 1.15;
	}

	.hist-size-main {
		color: #c9d1d9;
	}

	.hist-size-sub {
		font-size: 9px;
		color: #ff9500;
		font-weight: 600;
	}

	.side-long  { color: #2ebd85; }
	.side-short { color: #f14f6b; }

	.hist-num {
		text-align: right;
		color: #c9d1d9;
		font-size: 11px;
	}

	.hist-pnl {
		font-weight: 600;
	}

	.hist-pnl--dash {
		color: #5c6570;
		font-weight: 500;
	}

	.pnl-pos {
		color: #0ecb81;
	}
	.pnl-neg {
		color: #f6465d;
	}

	.hist-reason {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: #6b7280;
	}

	.hist-reason--manual {
		color: #ff9500;
	}

	.hist-reason--tp {
		color: #0ecb81;
	}

	.hist-reason--sl {
		color: #f6465d;
	}

	.hist-reason--liq {
		color: #f6465d;
	}

	.hist-reason--cancel {
		color: #7a8494;
		font-weight: 500;
	}

	.hist-reason--none {
		color: #5c6570;
		font-weight: 500;
	}

	.hist-action {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		justify-self: stretch;
		width: 100%;
		min-width: 0;
	}

	.hist-post-btn {
		background: transparent;
		border: 1px solid #3a2e00;
		color: #ff9500;
		font-size: 9px;
		font-weight: 700;
		padding: 3px 8px;
		border-radius: 3px;
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0.5px;
		transition: background 0.15s, border-color 0.15s;
	}

	.hist-post-btn:hover:not(:disabled) {
		background: rgba(255, 149, 0, 0.12);
		border-color: #ff9500;
	}

	.hist-post-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	/* ── Post modal ── */
	.post-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.82);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10000;
	}

	.post-modal {
		background: #0a0a0a;
		border: 1px solid #2a2a2a;
		border-radius: 10px;
		padding: 24px;
		width: 460px;
		max-width: 90vw;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.post-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.post-modal-title {
		font-size: 13px;
		font-weight: 700;
		color: #ff9500;
		letter-spacing: 0.5px;
	}

	.post-modal-close {
		background: none;
		border: none;
		color: #555;
		font-size: 14px;
		cursor: pointer;
		padding: 0;
	}

	.post-modal-close:hover { color: #e6e8ea; }

	.post-trade-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		background: #0d0d0d;
		border: 1px solid #1f1f1f;
		border-radius: 6px;
		font-size: 11px;
	}

	.pts-pair {
		font-weight: 700;
		color: #e6e8ea;
		font-size: 12px;
	}

	.pts-dir {
		font-weight: 700;
		font-size: 11px;
	}

	.pts-detail { color: #6b7280; }

	.pts-pnl {
		font-weight: 700;
		font-size: 12px;
	}

	.post-label {
		font-size: 10px;
		color: #6b7280;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.post-textarea {
		background: #000;
		border: 1px solid #333;
		border-radius: 6px;
		color: #e6e8ea;
		font-family: inherit;
		font-size: 11px;
		padding: 10px 12px;
		resize: vertical;
		min-height: 80px;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.post-textarea:focus { border-color: #ff9500; }
	.post-textarea::placeholder { color: #374151; }

	.post-modal-actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
	}

	.post-cancel, .post-submit {
		padding: 9px 18px;
		border-radius: 6px;
		font-size: 11px;
		font-weight: 700;
		font-family: inherit;
		cursor: pointer;
		letter-spacing: 0.04em;
		border: none;
	}

	.post-cancel {
		background: #1a1a1a;
		color: #6b7280;
		border: 1px solid #333;
	}

	.post-cancel:hover:not(:disabled) {
		background: #222;
		color: #e6e8ea;
	}

	.post-submit {
		background: #ff9500;
		color: #000;
	}

	.post-submit:hover:not(:disabled) { background: #ffaa33; }

	.post-cancel:disabled,
	.post-submit:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>
