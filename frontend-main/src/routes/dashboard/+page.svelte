<script lang="ts">
	import { onMount } from 'svelte';
	import { HermesClient } from '@pythnetwork/hermes-client';
	import { magicBlockClient, TRADING_PAIRS, PAIR_DECIMALS } from '$lib/magicblock';
	import { walletStore } from '$lib/wallet/stores';
	import WalletButton from '$lib/wallet/WalletButton.svelte';
	import Toast from '$lib/toast/Toast.svelte';
	import { toastStore } from '$lib/toast/store';
	import { supabase, isSupabaseConfigured } from '$lib/supabase';
	import * as ENV from '$lib/env';

	const hermesClient = new HermesClient(ENV.HERMES_URL, {});

	const PYTH_FEEDS = {
		SOL: { id: ENV.PYTH_FEEDS.SOL, name: 'SOL/USD' },
		BTC: { id: ENV.PYTH_FEEDS.BTC, name: 'BTC/USD' },
		ETH: { id: ENV.PYTH_FEEDS.ETH, name: 'ETH/USD' },
		AVAX: { id: ENV.PYTH_FEEDS.AVAX, name: 'AVAX/USD' },
		LINK: { id: ENV.PYTH_FEEDS.LINK, name: 'LINK/USD' },
	};

	type PriceData = {
		price: number;
		change: number;
	};

	let connectedWallet: any = null;
	let walletAddress = '';
	let isLoading = true;
	let isClosingPosition = false;

	// Price data
	let prices: Record<string, PriceData> = {
		SOL: { price: 0, change: 0 },
		BTC: { price: 0, change: 0 },
		ETH: { price: 0, change: 0 },
		AVAX: { price: 0, change: 0 },
		LINK: { price: 0, change: 0 },
	};

	// Trading data
	let openPositions: any[] = [];
	let tradeHistory: any[] = [];
	let accountBalances: { [pairIndex: number]: { tokenInBalance: number; tokenOutBalance: number } } = {};

	// Metrics
	let totalPnL = 0;
	let totalTrades = 0;
	let winningTrades = 0;
	let losingTrades = 0;
	let winRate = 0;
	let totalVolume = 0;
	let avgTradeSize = 0;
	let bestTrade = 0;
	let worstTrade = 0;
	let currentTime = new Date().toLocaleTimeString();
	let unrealizedPnL = 0;

	// Subscribe to wallet changes
	walletStore.subscribe(wallet => {
		connectedWallet = wallet;
		if (wallet.connected && wallet.publicKey) {
			walletAddress = wallet.publicKey.toBase58();
			magicBlockClient.setConnectedWallet(wallet.adapter);
			loadDashboardData();
		} else {
			walletAddress = '';
			resetData();
		}
	});

	function resetData() {
		openPositions = [];
		tradeHistory = [];
		accountBalances = {};
		totalPnL = 0;
		totalTrades = 0;
		winningTrades = 0;
		losingTrades = 0;
		winRate = 0;
		totalVolume = 0;
		avgTradeSize = 0;
		bestTrade = 0;
		worstTrade = 0;
		isLoading = false;
	}

	async function loadDashboardData() {
		if (!connectedWallet?.connected) return;

		isLoading = true;

		try {
			// Reset data before loading
			openPositions = [];
			tradeHistory = [];
			accountBalances = {};

			// Fetch all trade history (includes positions and spot trades)
			const allTrades = await magicBlockClient.fetchTradeHistory();

			// Separate into open positions (only LONG/SHORT that are active) and trade history
			openPositions = allTrades.filter((t: any) =>
				t.status === 'ACTIVE' && (t.tradeType === 'LONG' || t.tradeType === 'SHORT')
			);
			// Trade history includes closed positions AND spot trades
			tradeHistory = allTrades.filter((t: any) =>
				t.status === 'CLOSED' || t.status === 'COMPLETED' || t.tradeType === 'BUY' || t.tradeType === 'SELL'
			);

			// Fetch account balances for all trading pairs
			for (const [symbol, pairIndex] of Object.entries(TRADING_PAIRS)) {
				try {
					const accountData = await magicBlockClient.getUserAccountData(pairIndex);
					if (accountData) {
						accountBalances[pairIndex] = {
							tokenInBalance: accountData.tokenInBalance,
							tokenOutBalance: accountData.tokenOutBalance
						};
					}
				} catch (e) {
					// Account might not be initialized for this pair
				}
			}

			// Calculate metrics from all trades
			calculateMetrics();

		} catch (error) {
			console.error('Failed to load dashboard data:', error);
		} finally {
			isLoading = false;
		}
	}

	function calculateMetrics() {
		// Reset metrics
		let pnlSum = 0;
		winningTrades = 0;
		losingTrades = 0;
		totalVolume = 0;
		bestTrade = 0;
		worstTrade = 0;

		// Calculate metrics from closed trades (realized P&L)
		tradeHistory.forEach(trade => {
			if (trade.pnl !== undefined && trade.pnl !== null) {
				pnlSum += trade.pnl;
				if (trade.pnl > 0) winningTrades++;
				else if (trade.pnl < 0) losingTrades++;

				if (trade.pnl > bestTrade) bestTrade = trade.pnl;
				if (trade.pnl < worstTrade) worstTrade = trade.pnl;
			}
			if (trade.sizeUSDT) totalVolume += trade.sizeUSDT;
		});

		// Also include open positions volume
		openPositions.forEach(pos => {
			if (pos.sizeUSDT) totalVolume += pos.sizeUSDT;
		});

		totalPnL = pnlSum;
		totalTrades = tradeHistory.length + openPositions.length;
		const closedTrades = tradeHistory.length;
		winRate = closedTrades > 0 ? (winningTrades / closedTrades) * 100 : 0;
		avgTradeSize = totalTrades > 0 ? totalVolume / totalTrades : 0;
	}

	function formatAddress(address: string): string {
		if (!address) return '';
		return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
	}

	function getDirectionClass(direction: string): string {
		return direction === 'LONG' ? 'long' : 'short';
	}

	// Calculate pending P&L for a position based on current price
	function calculatePendingPnL(position: any): number {
		const currentPrice = prices[position.pairSymbol]?.price || 0;
		if (!currentPrice || !position.entryPrice) return 0;

		if (position.direction === 'LONG') {
			return (currentPrice - position.entryPrice) * position.size;
		} else {
			return (position.entryPrice - currentPrice) * position.size;
		}
	}

	// Calculate total unrealized P&L
	function calculateUnrealizedPnL() {
		unrealizedPnL = openPositions.reduce((sum, pos) => sum + calculatePendingPnL(pos), 0);
	}

	// Fetch current prices from Pyth
	async function fetchPrices() {
		try {
			const feedIds = Object.values(PYTH_FEEDS).map(f => f.id);
			const priceUpdates = await hermesClient.getLatestPriceUpdates(feedIds);

			if (priceUpdates?.parsed) {
				const symbols = Object.keys(PYTH_FEEDS);
				priceUpdates.parsed.forEach((update: any, index: number) => {
					const symbol = symbols[index];
					if (symbol && update.price) {
						const price = Number(update.price.price) * Math.pow(10, update.price.expo);
						prices[symbol] = {
							price,
							change: prices[symbol]?.change || 0
						};
					}
				});
				// Trigger reactivity
				prices = prices;
				calculateUnrealizedPnL();
			}
		} catch (error) {
			console.error('Error fetching prices:', error);
		}
	}

	// Close a position
	async function closePosition(positionPubkey: string, pairSymbol: string) {
		if (isClosingPosition) return;

		const currentPrice = prices[pairSymbol]?.price;
		if (!currentPrice) {
			toastStore.error('Price Error', 'Unable to get current price. Please try again.');
			return;
		}

		isClosingPosition = true;

		try {
			toastStore.info('Closing Position', 'Submitting close transaction...');
			const signature = await magicBlockClient.closeDirectPosition(positionPubkey, currentPrice);
			toastStore.success('Position Closed', `Transaction: ${signature.substring(0, 8)}...`);

			// Refresh data after closing
			await loadDashboardData();
		} catch (error: any) {
			console.error('Error closing position:', error);
			toastStore.error('Close Failed', error.message || 'Failed to close position');
		} finally {
			isClosingPosition = false;
		}
	}

	// Post trade to Supabase
	let showPostModal = false;
	let selectedTradeForPost: any = null;
	let postAnalysis = '';
	let isPosting = false;

	function openPostModal(trade: any) {
		selectedTradeForPost = trade;
		postAnalysis = '';
		showPostModal = true;
	}

	function closePostModal() {
		showPostModal = false;
		selectedTradeForPost = null;
		postAnalysis = '';
	}

	async function postTradeToSupabase() {
		if (!supabase || !isSupabaseConfigured) {
			toastStore.error('Not Configured', 'Supabase is not configured. Please set up your .env file.');
			return;
		}
		if (!selectedTradeForPost || !walletAddress) return;

		const trade = selectedTradeForPost;
		// Only LONG/SHORT positions can be posted
		if (trade.tradeType !== 'LONG' && trade.tradeType !== 'SHORT') {
			toastStore.error('Invalid Trade', 'Only closed LONG/SHORT positions can be posted.');
			return;
		}

		isPosting = true;
		try {
			const pairIndex = trade.pairIndex ?? TRADING_PAIRS[trade.pairSymbol as keyof typeof TRADING_PAIRS];
			const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
			if (!pairDecimals) {
				throw new Error('Unknown trading pair');
			}

			// Convert to database format (prices: 6 decimals, amount: token decimals)
			const amountTokenOut = BigInt(Math.round((trade.size || 0) * Math.pow(10, pairDecimals.tokenOut)));
			const entryPrice = BigInt(Math.round((trade.entryPrice || 0) * 1e6));
			const exitPrice = BigInt(Math.round((trade.exitPrice || trade.entryPrice || 0) * 1e6));
			const takeProfitPrice = trade.takeProfitPrice
				? BigInt(Math.round(trade.takeProfitPrice * 1e6))
				: null;
			const stopLossPrice = trade.stopLossPrice
				? BigInt(Math.round(trade.stopLossPrice * 1e6))
				: null;
			const openedAt = trade.openedAt
				? BigInt(Math.floor(trade.openedAt.getTime() / 1000))
				: BigInt(0);
			const closedAt = trade.closedAt
				? BigInt(Math.floor(trade.closedAt.getTime() / 1000))
				: BigInt(Math.floor(Date.now() / 1000));

			// Use truncated wallet as author display
			const authorDisplay = walletAddress ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}` : null;

			const { error } = await supabase.from('trade_posts').insert({
				owner_pubkey: walletAddress,
				pair_index: pairIndex,
				position_id: parseInt(trade.positionId || '0', 10),
				position_type: trade.tradeType === 'LONG' ? 'Long' : 'Short',
				amount_token_out: amountTokenOut.toString(),
				entry_price: entryPrice.toString(),
				exit_price: exitPrice.toString(),
				take_profit_price: takeProfitPrice?.toString() ?? null,
				stop_loss_price: stopLossPrice?.toString() ?? null,
				opened_at: openedAt.toString(),
				closed_at: closedAt.toString(),
				position_pubkey: trade.pubkey || null,
				author_username: authorDisplay,
				analysis: postAnalysis.trim() || null
			});

			if (error) {
				if (error.code === '23505') {
					toastStore.error('Already Posted', 'This trade has already been posted to the feed.');
				} else {
					throw error;
				}
				return;
			}

			toastStore.success('Trade Posted', 'Your trade is now live! View it on the landing page.');
			closePostModal();
		} catch (error: any) {
			console.error('Error posting trade:', error);
			toastStore.error('Post Failed', error.message || 'Failed to post trade');
		} finally {
			isPosting = false;
		}
	}

	// Update time every second and fetch prices
	onMount(() => {
		const timeInterval = setInterval(() => {
			currentTime = new Date().toLocaleTimeString();
		}, 1000);

		// Fetch prices immediately and every 2 seconds
		fetchPrices();
		const priceInterval = setInterval(fetchPrices, 2000);

		return () => {
			clearInterval(timeInterval);
			clearInterval(priceInterval);
		};
	});
</script>

<Toast />

<div class="dashboard">
	<header class="dashboard-header">
		<a href="/landing" class="logo">BLOCKBERG</a>
		<div class="nav-links">
			<a href="/terminal" class="nav-link">TERMINAL</a>
			<a href="/dashboard" class="nav-link active">DASHBOARD</a>
			<a href="/competition" class="nav-link">COMPETITION</a>
		</div>
		<div class="header-right">
			<div class="wallet-section">
				<WalletButton />
			</div>
		</div>
	</header>

	<div class="dashboard-content">
		{#if !connectedWallet?.connected}
			<div class="connect-prompt">
				<div class="prompt-icon">🔐</div>
				<h2>Connect Your Wallet</h2>
				<p>Connect your wallet to view your trading dashboard, positions, and performance metrics.</p>
				<div class="wallet-button-container">
					<WalletButton />
				</div>
			</div>
		{:else}
			<div class="dashboard-grid">
				<!-- Account Balances - Horizontal -->
				<div class="panel balances-panel">
					<div class="panel-header">ACCOUNT BALANCES</div>
					<div class="panel-content">
						{#if Object.keys(accountBalances).length > 0}
							<div class="balances-row">
								{#each Object.entries(TRADING_PAIRS) as [symbol, pairIndex]}
									{#if accountBalances[pairIndex]}
										<div class="balance-card">
											<div class="balance-pair">{symbol}/USDT</div>
											<div class="balance-amounts">
												<span class="balance-usdt">{accountBalances[pairIndex].tokenInBalance.toFixed(2)} USDT</span>
												<span class="balance-token">{accountBalances[pairIndex].tokenOutBalance.toFixed(4)} {symbol}</span>
											</div>
										</div>
									{/if}
								{/each}
							</div>
						{:else}
							<div class="empty-state">No initialized accounts</div>
						{/if}
					</div>
				</div>

				<!-- Performance Metrics -->
				<div class="panel metrics-panel">
					<div class="panel-header">PERFORMANCE METRICS</div>
					<div class="panel-content">
						<div class="metrics-grid">
							<div class="metric-card">
								<div class="metric-label">REALIZED P&L</div>
								<div class="metric-value" class:positive={totalPnL >= 0} class:negative={totalPnL < 0}>
									{totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
								</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">UNREALIZED P&L</div>
								<div class="metric-value" class:positive={unrealizedPnL >= 0} class:negative={unrealizedPnL < 0}>
									{unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)}
								</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">WIN RATE</div>
								<div class="metric-value">{winRate.toFixed(1)}%</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">TOTAL TRADES</div>
								<div class="metric-value">{totalTrades}</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">WINNING</div>
								<div class="metric-value positive">{winningTrades}</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">LOSING</div>
								<div class="metric-value negative">{losingTrades}</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">AVG SIZE</div>
								<div class="metric-value">${avgTradeSize.toFixed(2)}</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">BEST TRADE</div>
								<div class="metric-value positive">+${bestTrade.toFixed(2)}</div>
							</div>
							<div class="metric-card">
								<div class="metric-label">WORST TRADE</div>
								<div class="metric-value negative">${worstTrade.toFixed(2)}</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Open Positions -->
				<div class="panel positions-panel">
					<div class="panel-header">
						OPEN POSITIONS
						<button class="refresh-btn" on:click={loadDashboardData}>↻ REFRESH</button>
					</div>
					<div class="panel-content">
						{#if isLoading}
							<div class="loading-state">Loading positions...</div>
						{:else if openPositions.length > 0}
							<div class="positions-table">
								<div class="table-header">
									<span>PAIR</span>
									<span>DIRECTION</span>
									<span>SIZE</span>
									<span>ENTRY</span>
									<span>CURRENT</span>
									<span>P&L</span>
									<span>ACTION</span>
								</div>
								{#each openPositions as position}
									{@const pendingPnL = calculatePendingPnL(position)}
									{@const currentPrice = prices[position.pairSymbol]?.price || 0}
									<div class="table-row">
										<span class="pair">{position.pair || `${position.pairSymbol}/USDT`}</span>
										<span class="direction {getDirectionClass(position.direction)}">{position.direction}</span>
										<span class="size">{position.size?.toFixed(4) || '0'} {position.pairSymbol}</span>
										<span class="entry">${position.entryPrice?.toFixed(4) || '0.0000'}</span>
										<span class="current">${currentPrice.toFixed(4)}</span>
										<span class="pnl" class:positive={pendingPnL >= 0} class:negative={pendingPnL < 0}>
											{pendingPnL >= 0 ? '+' : ''}${pendingPnL.toFixed(4)}
										</span>
										<button
											class="close-btn"
											on:click={() => closePosition(position.pubkey, position.pairSymbol)}
											disabled={isClosingPosition}
										>
											{isClosingPosition ? '...' : 'CLOSE'}
										</button>
									</div>
								{/each}
							</div>
						{:else}
							<div class="empty-state">No open positions</div>
						{/if}
					</div>
				</div>

				<!-- Trade History -->
				<div class="panel history-panel">
					<div class="panel-header">TRADE HISTORY</div>
					<div class="panel-content">
						{#if tradeHistory.length > 0}
							<div class="history-table">
								<div class="table-header">
									<span>DATE</span>
									<span>PAIR</span>
									<span>TYPE</span>
									<span>SIZE</span>
									<span>ENTRY</span>
									<span>EXIT</span>
									<span>P&L</span>
									<span>ACTION</span>
								</div>
								{#each tradeHistory as trade}
									<div class="table-row">
										<span class="date">{trade.closedAt ? trade.closedAt.toLocaleDateString() : trade.date || '—'}</span>
										<span class="pair">{trade.pair}</span>
										<span class="trade-type {trade.tradeType?.toLowerCase() || trade.direction?.toLowerCase()}">
											{trade.tradeType || trade.direction}
										</span>
										<span>{trade.size?.toFixed(4) || '0'} {trade.pairSymbol}</span>
										<span>${trade.entryPrice?.toFixed(4) || trade.price?.toFixed(4) || '0.0000'}</span>
										<span>
											{#if trade.tradeType === 'LONG' || trade.tradeType === 'SHORT'}
												${trade.exitPrice?.toFixed(4) || '—'}
											{:else}
												—
											{/if}
										</span>
										<span class="pnl" class:positive={(trade.pnl || 0) >= 0} class:negative={(trade.pnl || 0) < 0}>
											{#if trade.pnl !== undefined && trade.pnl !== null && (trade.tradeType === 'LONG' || trade.tradeType === 'SHORT')}
												{trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(4)}
											{:else}
												—
											{/if}
										</span>
										<span class="action-cell">
											{#if trade.tradeType === 'LONG' || trade.tradeType === 'SHORT'}
												<button
													class="post-btn"
													on:click={() => openPostModal(trade)}
													disabled={!isSupabaseConfigured}
													title={isSupabaseConfigured ? 'Share this trade to the feed' : 'Supabase not configured'}
												>
													POST
												</button>
											{:else}
												—
											{/if}
										</span>
									</div>
								{/each}
							</div>
						{:else}
							<div class="empty-state">No trade history available</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Post Trade Modal -->
	{#if showPostModal}
		<div class="modal-overlay" on:click={closePostModal} role="button" tabindex="0" on:keydown={(e) => e.key === 'Escape' && closePostModal()}>
			<div class="modal-content" on:click|stopPropagation role="dialog" aria-modal="true" aria-labelledby="modal-title">
				<div class="modal-header">
					<h2 id="modal-title">Post Trade to Feed</h2>
					<button class="modal-close" on:click={closePostModal} aria-label="Close">&times;</button>
				</div>
				{#if selectedTradeForPost}
					<div class="modal-trade-summary">
						<span class="trade-badge">{selectedTradeForPost.pair}</span>
						<span class="trade-badge {selectedTradeForPost.tradeType?.toLowerCase()}">
							{selectedTradeForPost.tradeType}
						</span>
						<span>{selectedTradeForPost.size?.toFixed(4)} @ ${selectedTradeForPost.entryPrice?.toFixed(4)} → ${selectedTradeForPost.exitPrice?.toFixed(4)}</span>
						<span class="pnl" class:positive={(selectedTradeForPost.pnl || 0) >= 0} class:negative={(selectedTradeForPost.pnl || 0) < 0}>
							{selectedTradeForPost.pnl >= 0 ? '+' : ''}${selectedTradeForPost.pnl?.toFixed(4) || '0'}
						</span>
					</div>
					<label for="post-analysis" class="modal-label">Analysis / Description (optional)</label>
					<textarea
						id="post-analysis"
						class="modal-textarea"
						placeholder="Share your trade analysis, setup, or lessons learned..."
						bind:value={postAnalysis}
						rows="4"
					></textarea>
				{/if}
				<div class="modal-actions">
					<button class="modal-btn cancel" on:click={closePostModal} disabled={isPosting}>Cancel</button>
					<button class="modal-btn primary" on:click={postTradeToSupabase} disabled={isPosting}>
						{isPosting ? 'Posting...' : 'Post to Feed'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	<footer class="footer">
		<div class="footer-content">
			<div class="footer-left">
				<span class="footer-brand">BLOCKBERG</span>
				<span class="footer-tagline">Paper Trading Terminal</span>
			</div>
			<div class="footer-center">
				<span class="footer-powered">Powered by</span>
				<a href="https://pyth.network" target="_blank" rel="noopener noreferrer" class="footer-link">Pyth Network</a>
				<span class="footer-separator">•</span>
				<a href="https://magicblock.gg" target="_blank" rel="noopener noreferrer" class="footer-link">MagicBlock</a>
				<span class="footer-separator">•</span>
				<a href="https://solana.com" target="_blank" rel="noopener noreferrer" class="footer-link">Solana</a>
			</div>
			<div class="footer-right">
				<span class="footer-copyright">© 2026 Blockberg. All rights reserved.</span>
			</div>
		</div>
	</footer>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #000;
		color: #ff9500;
		font-family: 'Courier New', 'Lucida Console', monospace;
	}

	.dashboard {
		min-height: 100vh;
		background: #000;
		display: flex;
		flex-direction: column;
	}

	.dashboard-header {
		background: #0a0a0a;
		padding: 12px 20px;
		display: flex;
		align-items: center;
		gap: 20px;
		border-bottom: 1px solid #333;
	}

	.logo {
		font-size: 20px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 2px;
		text-decoration: none;
	}

	.nav-links {
		display: flex;
		gap: 5px;
	}

	.nav-link {
		color: #666;
		text-decoration: none;
		padding: 8px 16px;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 1px;
		background: #1a1a1a;
		transition: all 0.2s ease;
	}

	.nav-link:hover {
		color: #ff9500;
		background: #222;
	}

	.nav-link.active {
		color: #ff9500;
		background: #000;
		border-bottom: 2px solid #ff9500;
	}

	.header-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 15px;
	}

	.dashboard-content {
		flex: 1;
		padding: 20px;
	}

	/* Connect Prompt */
	.connect-prompt {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 60vh;
		text-align: center;
	}

	.prompt-icon {
		font-size: 48px;
		margin-bottom: 20px;
	}

	.connect-prompt h2 {
		color: #ff9500;
		font-size: 24px;
		margin: 0 0 10px 0;
		letter-spacing: 2px;
	}

	.connect-prompt p {
		color: #666;
		font-size: 14px;
		margin: 0 0 30px 0;
		max-width: 400px;
	}

	/* Dashboard Grid */
	.dashboard-grid {
		display: flex;
		flex-direction: column;
		gap: 15px;
	}

	.panel {
		background: #000;
		border: 1px solid #333;
	}

	.panel-header {
		background: #0a0a0a;
		color: #ff9500;
		padding: 10px 15px;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 1px;
		border-bottom: 1px solid #333;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.panel-content {
		padding: 15px;
	}

	/* Balances Panel */
	.balances-panel .panel-content {
		padding: 10px 15px;
	}

	.balances-row {
		display: flex;
		gap: 15px;
		flex-wrap: wrap;
	}

	.balance-card {
		flex: 1;
		min-width: 150px;
		background: #0a0a0a;
		border: 1px solid #333;
		padding: 10px 15px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.balance-pair {
		color: #ff9500;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 1px;
	}

	.balance-amounts {
		display: flex;
		gap: 15px;
		font-size: 11px;
	}

	.balance-usdt {
		color: #00ff00;
		font-family: 'Courier New', monospace;
	}

	.balance-token {
		color: #fff;
		font-family: 'Courier New', monospace;
	}

	/* Metrics Panel */
	.metrics-grid {
		display: grid;
		grid-template-columns: repeat(9, 1fr);
		gap: 10px;
	}

	.metric-card {
		background: #0a0a0a;
		border: 1px solid #333;
		padding: 12px;
		text-align: center;
	}

	.metric-label {
		color: #666;
		font-size: 9px;
		letter-spacing: 1px;
		margin-bottom: 6px;
	}

	.metric-value {
		color: #fff;
		font-size: 14px;
		font-weight: bold;
		font-family: 'Courier New', monospace;
	}

	.metric-value.positive {
		color: #00ff00;
	}

	.metric-value.negative {
		color: #ff4444;
	}

	/* Positions Panel */

	.refresh-btn {
		background: none;
		border: 1px solid #333;
		color: #ff9500;
		padding: 4px 10px;
		font-size: 10px;
		cursor: pointer;
		font-family: 'Courier New', monospace;
		transition: all 0.2s ease;
	}

	.refresh-btn:hover {
		background: #1a1a1a;
		border-color: #ff9500;
	}

	/* Tables */
	.positions-table,
	.history-table {
		width: 100%;
	}

	.table-header {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr 1fr 1.5fr 1fr 1fr;
		gap: 10px;
		padding: 10px 0;
		border-bottom: 1px solid #333;
		color: #666;
		font-size: 10px;
		font-weight: bold;
		letter-spacing: 1px;
	}

	.history-table .table-header {
		grid-template-columns: 1.2fr 1fr 1fr 1fr 1fr 1fr 1fr 0.8fr;
	}

	.table-row {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr 1fr 1.5fr 1fr 1fr 0.8fr;
		gap: 10px;
		padding: 12px 0;
		border-bottom: 1px solid #222;
		font-size: 11px;
		color: #ccc;
		align-items: center;
	}

	.history-table .table-row {
		grid-template-columns: 1.2fr 1fr 1fr 1fr 1fr 1fr 1fr 0.8fr;
	}

	.table-row:hover {
		background: #0a0a0a;
	}

	.table-row .pair {
		color: #fff;
		font-weight: bold;
	}

	.table-row .direction {
		font-weight: bold;
	}

	.table-row .direction.long,
	.table-row .trade-type.long,
	.table-row .trade-type.buy {
		color: #00ff00;
	}

	.table-row .direction.short,
	.table-row .trade-type.short,
	.table-row .trade-type.sell {
		color: #ff4444;
	}

	.table-row .pnl.positive {
		color: #00ff00;
	}

	.table-row .pnl.negative {
		color: #ff4444;
	}

	.close-btn {
		background: none;
		border: 1px solid #ff4444;
		color: #ff4444;
		padding: 4px 12px;
		font-size: 10px;
		font-weight: bold;
		cursor: pointer;
		font-family: 'Courier New', monospace;
		letter-spacing: 1px;
		transition: all 0.2s ease;
	}

	.close-btn:hover:not(:disabled) {
		background: #ff4444;
		color: #000;
	}

	.close-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.post-btn {
		background: none;
		border: 1px solid #ff9500;
		color: #ff9500;
		padding: 4px 12px;
		font-size: 10px;
		font-weight: bold;
		cursor: pointer;
		font-family: 'Courier New', monospace;
		letter-spacing: 1px;
		transition: all 0.2s ease;
	}

	.post-btn:hover:not(:disabled) {
		background: #ff9500;
		color: #000;
	}

	.post-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		border-color: #555;
		color: #666;
	}

	.action-cell {
		display: flex;
		align-items: center;
	}

	/* Post Trade Modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 20px;
	}

	.modal-content {
		background: #0a0a0a;
		border: 1px solid #333;
		max-width: 480px;
		width: 100%;
		padding: 24px;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
		border-bottom: 1px solid #333;
		padding-bottom: 12px;
	}

	.modal-header h2 {
		color: #ff9500;
		font-size: 16px;
		font-weight: bold;
		letter-spacing: 1px;
		margin: 0;
	}

	.modal-close {
		background: none;
		border: none;
		color: #666;
		font-size: 24px;
		cursor: pointer;
		line-height: 1;
		padding: 0 4px;
		transition: color 0.2s;
	}

	.modal-close:hover {
		color: #ff9500;
	}

	.modal-trade-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin-bottom: 16px;
		padding: 12px;
		background: #000;
		border: 1px solid #222;
		font-size: 12px;
	}

	.trade-badge {
		padding: 2px 8px;
		background: #1a1a1a;
		border: 1px solid #333;
		color: #fff;
	}

	.trade-badge.long {
		color: #00ff00;
		border-color: #00ff00;
	}

	.trade-badge.short {
		color: #ff4444;
		border-color: #ff4444;
	}

	.modal-label {
		display: block;
		color: #666;
		font-size: 11px;
		margin-bottom: 8px;
		letter-spacing: 1px;
	}

	.modal-textarea {
		width: 100%;
		background: #000;
		border: 1px solid #333;
		color: #fff;
		padding: 12px;
		font-family: 'Courier New', monospace;
		font-size: 12px;
		margin-bottom: 20px;
		resize: vertical;
		min-height: 80px;
		box-sizing: border-box;
	}

	.modal-textarea::placeholder {
		color: #555;
	}

	.modal-textarea:focus {
		outline: none;
		border-color: #ff9500;
	}

	.modal-actions {
		display: flex;
		gap: 12px;
		justify-content: flex-end;
	}

	.modal-btn {
		padding: 10px 20px;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 1px;
		cursor: pointer;
		font-family: 'Courier New', monospace;
		border: 1px solid #333;
		transition: all 0.2s ease;
	}

	.modal-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.modal-btn.cancel {
		background: #1a1a1a;
		color: #666;
	}

	.modal-btn.cancel:hover:not(:disabled) {
		color: #fff;
		border-color: #555;
	}

	.modal-btn.primary {
		background: #ff9500;
		color: #000;
		border-color: #ff9500;
	}

	.modal-btn.primary:hover:not(:disabled) {
		background: #ffaa33;
		border-color: #ffaa33;
	}

	.table-row .status {
		font-size: 10px;
		padding: 2px 8px;
		border-radius: 3px;
	}

	.table-row .status.open {
		background: rgba(0, 255, 0, 0.1);
		color: #00ff00;
		border: 1px solid #00ff00;
	}

	/* Empty & Loading States */
	.empty-state,
	.loading-state {
		text-align: center;
		padding: 40px 20px;
		color: #666;
		font-size: 12px;
	}

	/* Footer */
	.footer {
		background: #0a0a0a;
		border-top: 1px solid #333;
		padding: 12px 20px;
	}

	.footer-content {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.footer-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.footer-brand {
		color: #ff9500;
		font-weight: bold;
		font-size: 14px;
		letter-spacing: 2px;
	}

	.footer-tagline {
		color: #666;
		font-size: 11px;
	}

	.footer-center {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.footer-powered {
		color: #666;
		font-size: 11px;
	}

	.footer-link {
		color: #ff9500;
		text-decoration: none;
		font-size: 11px;
		transition: color 0.2s ease;
	}

	.footer-link:hover {
		color: #fff;
	}

	.footer-separator {
		color: #444;
		font-size: 10px;
	}

	.footer-right {
		display: flex;
		align-items: center;
	}

	.footer-copyright {
		color: #444;
		font-size: 10px;
	}
</style>
