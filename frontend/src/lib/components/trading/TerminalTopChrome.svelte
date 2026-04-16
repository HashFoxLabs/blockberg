<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import MarketSelectNav from '$lib/components/trading/MarketSelectNav.svelte';
	import { magicBlockClient, TRADING_PAIRS, ALL_MARKETS } from '$lib/magicblock';
	import { walletStore } from '$lib/wallet/stores';
	import { tradingModeStore, type TradingContext } from '$lib/stores/tradingMode';
	import WalletButton from '$lib/wallet/WalletButton.svelte';
	import { toastStore } from '$lib/toast/store';
	import * as ENV from '$lib/env';
	import {
		pythPrices as priceStore,
		pythConnectionStatus,
		pythLastUpdate as lastUpdateStore,
		startPythStream,
		type PriceData,
	} from '$lib/stores/pythPrices';

	const dispatch = createEventDispatcher<{
		prices: Record<string, PriceData>;
		accountschanged: void;
		marketselect: { symbol: string };
	}>();

	export let activeSection: 'terminal' | 'dashboard' = 'dashboard';

	/** When set (e.g. on `/terminal`), nav + ticker track the parent `selectedTab`. */
	export let selectedMarketSymbol: string | undefined = undefined;

	/** Matches terminal `selectedTab` / `?pair=` for nav + headline ticker. */
	let navMarketSymbol = 'SOL';

	$: displayMarket = selectedMarketSymbol ?? navMarketSymbol;

	/** Same headline symbols as `/terminal` ticker strip */
	const TICKER_HEADLINE = ['SOL', 'ETH', 'BTC', 'TAO'] as const;

	let businessNews: { title: string; url: string; imageurl: string | null; source: string }[] = [];

	let prices: Record<string, PriceData> = $priceStore;
	let pythStatus = 'Initializing...';
	let pythLastUpdate = 0;

	let walletAddress = '';
	let walletBalance = 0;
	let magicBlockStatus = 'Initializing...';
	let connectedWallet: any = null;
	let accountsInitialized: { [pairIndex: number]: boolean } = {};
	let fastTradingSessionActive = false;

	let showSessionFundModal = false;
	let sessionFundSolAmount = 0.05;
	let sessionFundLoading = false;
	let showSessionActiveNotice = false;
	let sessionActiveTimeLabel = '';

	let showDevnetWalletFundingModal = false;
	let fundingPopupSolBalance = 0;
	let fundingPopupAddress = '';

	const DEVNET_FUNDING_DISMISS_KEY = 'blockberg_devnet_funding_dismissed';

	let disconnectSessionLoading = false;

	let tradingContext: TradingContext = { mode: 'regular' };

	tradingModeStore.subscribe(context => {
		tradingContext = context;
		if (connectedWallet?.connected) {
			void updateWalletStatusBar();
		}
	});

	$: {
		const q = $page.url.searchParams.get('pair');
		if (q && (ALL_MARKETS as readonly string[]).includes(q)) {
			navMarketSymbol = q;
		}
	}

	async function fetchBusinessNews() {
		try {
			const rssUrl = 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en';
			const response = await fetch(`${ENV.RSS2JSON_API_URL}?rss_url=${encodeURIComponent(rssUrl)}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json();
			if (data.items && data.items.length > 0) {
				businessNews = data.items.map((item: any) => ({
					title: item.title,
					url: item.link,
					imageurl: item.enclosure?.link || item.thumbnail || null,
					source: item.author || 'Google News',
				}));
			}
		} catch (error) {
			console.error('Failed to fetch business news:', error);
			businessNews = [];
		}
	}

	function tickerPriceFmt(p: PriceData): string {
		if (!p || p.price <= 0) return '—';
		const decimals = p.price >= 100 ? 2 : p.price >= 1 ? 3 : 5;
		return p.price.toFixed(decimals);
	}

	function onTickerSelect(sym: string) {
		navMarketSymbol = sym;
		if (activeSection === 'dashboard') {
			goto(`/terminal?pair=${sym}`);
		} else {
			dispatch('marketselect', { symbol: sym });
		}
	}

	async function updateWalletStatusBar() {
		if (!connectedWallet?.connected) return;
		try {
			walletBalance = await magicBlockClient.getBalance();
			accountsInitialized = await magicBlockClient.getAccountStatus();
			fastTradingSessionActive = magicBlockClient.isPaperTradingSessionActive();
			magicBlockStatus = fastTradingSessionActive
				? 'Connected · Session active'
				: 'Connected · No session';
			maybeOfferDevnetFunding();
		} catch (error) {
			console.error('Wallet status update error:', error);
			magicBlockStatus = 'Connected - Status check failed';
		}
	}

	walletStore.subscribe(wallet => {
		connectedWallet = wallet;
		if (wallet.connected && wallet.publicKey) {
			walletAddress = wallet.publicKey.toBase58();
			magicBlockClient.setConnectedWallet(wallet.adapter);
			void (async () => {
				await updateWalletStatusBar();
				if (activeSection === 'dashboard') {
					dispatch('accountschanged');
				}
			})();
		} else {
			walletAddress = '';
			magicBlockClient.setConnectedWallet(null);
			walletBalance = 0;
			accountsInitialized = {};
			fastTradingSessionActive = false;
			magicBlockStatus = 'Ready - Connect wallet to trade';
			showSessionFundModal = false;
			showSessionActiveNotice = false;
			showDevnetWalletFundingModal = false;
		}
	});

	function maybeOfferDevnetFunding() {
		if (typeof sessionStorage === 'undefined') return;
		if (sessionStorage.getItem(DEVNET_FUNDING_DISMISS_KEY)) return;
		if (!connectedWallet?.connected) return;
		if (showSessionFundModal) return;
		if (walletBalance >= 0.05) return;
		fundingPopupSolBalance = walletBalance;
		fundingPopupAddress = walletAddress;
		showDevnetWalletFundingModal = true;
	}

	function dismissDevnetFundingModal() {
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.setItem(DEVNET_FUNDING_DISMISS_KEY, '1');
		}
		showDevnetWalletFundingModal = false;
	}

	function openSessionFundModal() {
		if (!connectedWallet?.connected || magicBlockClient.isPaperTradingSessionActive()) return;
		sessionFundSolAmount = 0.05;
		showDevnetWalletFundingModal = false;
		showSessionFundModal = true;
	}

	function closeSessionFundModal() {
		showSessionFundModal = false;
		sessionFundLoading = false;
	}

	function formatSessionRemainingLabel(): string {
		const sec = magicBlockClient.getPaperSessionTimeRemainingSeconds();
		if (sec <= 0) return '';
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}

	async function confirmFundSession() {
		const amount = Number(sessionFundSolAmount);
		if (!connectedWallet?.connected) return;
		if (amount < 0.01 || amount > 2 || Number.isNaN(amount)) {
			toastStore.error('Session', 'Enter between 0.01 and 2 SOL.');
			return;
		}
		const reserve = 0.02;
		if (walletBalance < amount + reserve) {
			toastStore.error(
				'Session',
				`Need at least ${(amount + reserve).toFixed(3)} SOL (top-up + fees). Use AIRDROP or add SOL.`
			);
			return;
		}
		sessionFundLoading = true;
		try {
			magicBlockStatus = 'Approve session funding…';
			await magicBlockClient.createPaperTradingSession({ topUpSol: amount });
			fastTradingSessionActive = true;
			showSessionFundModal = false;
			magicBlockStatus = 'Connected · Session active';
			sessionActiveTimeLabel = formatSessionRemainingLabel();
			showSessionActiveNotice = true;
			toastStore.success('Session enabled', `${amount.toFixed(3)} SOL funded for one-click trading.`);
			await updateWalletStatusBar();
			if (activeSection === 'dashboard') dispatch('accountschanged');
		} catch (e: any) {
			toastStore.error('Session failed', e?.message || String(e));
			magicBlockStatus = 'Session funding failed';
		} finally {
			sessionFundLoading = false;
		}
	}

	async function copyWalletAddressToClipboard() {
		if (!walletAddress) return;
		try {
			await navigator.clipboard.writeText(walletAddress);
			toastStore.success('Copied', 'Wallet address copied');
		} catch {
			toastStore.error('Copy failed', 'Could not copy address');
		}
	}

	async function initializeAllAccounts() {
		if (!connectedWallet?.connected) {
			return;
		}

		if (walletBalance < 0.6) {
			magicBlockStatus = 'Insufficient SOL. Click AIRDROP first.';
			return;
		}

		try {
			magicBlockStatus = 'Initializing...';

			for (const [, pairIndex] of Object.entries(TRADING_PAIRS)) {
				if (!accountsInitialized[pairIndex]) {
					await magicBlockClient.initializeAccount(pairIndex);
				}
			}

			await updateWalletStatusBar();
			if (
				connectedWallet?.connected &&
				!magicBlockClient.isPaperTradingSessionActive() &&
				true
			) {
				openSessionFundModal();
			}

			setTimeout(async () => {
				await updateWalletStatusBar();
				if (activeSection === 'dashboard') dispatch('accountschanged');
			}, 3000);
			if (activeSection === 'dashboard') dispatch('accountschanged');
		} catch (error: any) {
			console.error('Init error:', error);
			magicBlockStatus = 'Initialization failed';
		}
	}

	function enableFastTradingSession() {
		openSessionFundModal();
	}

	async function disconnectPaperSession() {
		if (!connectedWallet?.connected) return;
		disconnectSessionLoading = true;
		try {
			magicBlockStatus = 'Ending session…';
			await magicBlockClient.revokePaperTradingSession();
			fastTradingSessionActive = false;
			showSessionActiveNotice = false;
			magicBlockStatus = 'Connected · No session';
			toastStore.success('Session ended', 'Use FAST TRADES to fund and enable a new session.');
			await updateWalletStatusBar();
			if (activeSection === 'dashboard') dispatch('accountschanged');
		} catch (e: any) {
			toastStore.error('End session failed', e?.message || String(e));
			magicBlockStatus = 'Session revoke failed';
			await updateWalletStatusBar();
		} finally {
			disconnectSessionLoading = false;
		}
	}

	function startPythLazerUpdates() {
		priceStore.subscribe((p) => {
			prices = p;
			dispatch('prices', p);
		});
		pythConnectionStatus.subscribe((s) => {
			pythStatus = s;
		});
		lastUpdateStore.subscribe((t) => {
			pythLastUpdate = t;
		});
		void startPythStream();
	}

	async function requestAirdrop() {
		if (!connectedWallet?.connected) {
			return;
		}

		try {
			magicBlockStatus = 'Requesting airdrop...';
			const { Connection } = await import('@solana/web3.js');
			const solanaConnection = new Connection(ENV.SOLANA_RPC, 'confirmed');
			const signature = await solanaConnection.requestAirdrop(connectedWallet.publicKey, 2000000000);
			await solanaConnection.confirmTransaction(signature, 'confirmed');
			magicBlockStatus = 'Airdrop sent';

			const pollInterval = setInterval(async () => {
				await updateWalletStatusBar();
				if (showDevnetWalletFundingModal) {
					fundingPopupSolBalance = walletBalance;
				}
				if (walletBalance > 1) {
					magicBlockStatus = `Funded: ${walletBalance.toFixed(2)} SOL`;
					clearInterval(pollInterval);
				}
			}, 2000);

			setTimeout(() => clearInterval(pollInterval), 60000);
			if (activeSection === 'dashboard') dispatch('accountschanged');
		} catch (error: any) {
			console.error('Airdrop error:', error);
			magicBlockStatus = 'Airdrop failed';
		}
	}

	onMount(() => {
		const initWallet = async () => {
			try {
				magicBlockStatus = 'Initializing session wallet fallback...';
				await magicBlockClient.initializeSessionWallet();
				magicBlockClient.setAdminWallet(
					'2ACsdGiDz4qhCNTkbkPcHNEk5DuG9cfyV4o1j9sidxhFKhyyXWg4GgHutwQrnXBovSRA9ixfVWwYWzNH8hHmbDy2'
				);
				if (!connectedWallet?.connected) {
					magicBlockStatus = 'Ready - Connect wallet to trade';
				}
			} catch {
				magicBlockStatus = 'Initialization failed';
			}
		};

		void initWallet();
		startPythLazerUpdates();
		void fetchBusinessNews();
	});

	function onNavMarketSelect(e: CustomEvent<{ symbol: string }>) {
		const sym = e.detail.symbol;
		navMarketSymbol = sym;
		if (activeSection === 'dashboard') {
			goto(`/terminal?pair=${sym}`);
		} else {
			dispatch('marketselect', { symbol: sym });
		}
	}
</script>

<div class="terminal-top-chrome">
	<div class="command-bar">
		<a href="/landing" class="logo">
			<img class="logo-icon" src="/favicon.png" alt="HASHFOX" />
			<span class="logo-text">HASHFOX</span>
		</a>
		<div class="nav-links">
			<a href="/terminal" class="nav-link" class:active={activeSection === 'terminal'}>TERMINAL</a>
			<a href="/dashboard" class="nav-link" class:active={activeSection === 'dashboard'}>HISTORY</a>
		</div>
		<MarketSelectNav selectedSymbol={displayMarket} on:select={onNavMarketSelect} />
		<div class="pyth-status">
			<span class="status-label">PYTH:</span>
			<span class="status-value">{pythStatus}</span>
			{#if pythLastUpdate > 0}
				<span class="status-age">{Math.floor((Date.now() - pythLastUpdate) / 1000)}s ago</span>
			{/if}
		</div>
		<div class="magicblock-status">
			<span class="status-label">MAGICBLOCK:</span>
			{#if connectedWallet?.connected && !fastTradingSessionActive}
				<button
					type="button"
					class="status-value magicblock-session-trigger"
					title="Fund session for one-click trading"
					on:click={openSessionFundModal}
				>
					{magicBlockStatus}
				</button>
			{:else}
				<span class="status-value">{magicBlockStatus}</span>
			{/if}
			{#if connectedWallet?.connected}
				<span class="wallet-balance">{walletBalance.toFixed(4)} SOL</span>
				{#if walletBalance < 0.1}
					<button type="button" class="airdrop-btn" on:click={requestAirdrop}>AIRDROP</button>
				{/if}
				{#if (Object.keys(accountsInitialized).length === 0 || Object.values(accountsInitialized).some(initialized => !initialized))}
					<button type="button" class="initialize-btn" on:click={initializeAllAccounts}>INITIALIZE</button>
				{/if}
				{#if connectedWallet?.connected && Object.values(accountsInitialized).length > 0 && Object.values(accountsInitialized).every(Boolean) && !fastTradingSessionActive}
					<button type="button" class="initialize-btn fast-session-btn" on:click={enableFastTradingSession}
						>FAST TRADES</button
					>
				{/if}
				{#if connectedWallet?.connected && Object.values(accountsInitialized).length > 0 && Object.values(accountsInitialized).every(Boolean) && fastTradingSessionActive}
					<button
						type="button"
						class="initialize-btn session-end-btn"
						disabled={disconnectSessionLoading}
						title="Revoke session on-chain and clear local keys"
						on:click={disconnectPaperSession}
					>
						{disconnectSessionLoading ? '…' : 'END SESSION'}
					</button>
				{/if}
			{/if}
		</div>
		<div class="wallet-section">
			<WalletButton />
		</div>
	</div>

	<div class="ticker-bar">
		<div class="ticker-prices">
			{#each TICKER_HEADLINE as sym}
				{@const p = prices[sym]}
				{#if p}
					<div
						class="ticker-item"
						class:ticker-active={sym === displayMarket}
						role="button"
						tabindex="0"
						on:click={() => onTickerSelect(sym)}
						on:keydown={(e) => e.key === 'Enter' && onTickerSelect(sym)}
					>
						<span class="ticker-sym">{sym}/USD</span>
						<span class="price">{tickerPriceFmt(p)}</span>
						{#if p.price > 0}
							<span class={p.change >= 0 ? 'change-up' : 'change-down'}>
								{p.change >= 0 ? '▲' : '▼'} {Math.abs(p.change).toFixed(2)}%
							</span>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
		<div class="news-ticker-container">
			<div class="news-ticker">
				{#if businessNews.length > 0}
					{#each [...businessNews, ...businessNews] as article}
						<a href={article.url} target="_blank" rel="noopener noreferrer" class="ticker-news-item">
							{#if article.imageurl}
								<img src={article.imageurl} alt="" class="ticker-news-img" />
							{/if}
							<span class="ticker-news-text">{article.title}</span>
						</a>
					{/each}
				{:else}
					<span class="ticker-loading">Loading news…</span>
				{/if}
			</div>
		</div>
	</div>

	{#if showDevnetWalletFundingModal}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="session-overlay"
			role="dialog"
			aria-modal="true"
			tabindex="0"
			on:keydown={(e) => e.key === 'Escape' && dismissDevnetFundingModal()}
		>
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
			<div class="session-modal session-modal--funding" role="document" on:click|stopPropagation>
				<div class="funding-network-badge">DEVNET</div>
				<h3 class="session-title">Fund your wallet</h3>
				<p class="session-desc">
					You need test SOL on this cluster for <strong>initialize</strong>, <strong>session top-up</strong>, and fees.
					Balance is low — use AIRDROP in the bar or a devnet faucet.
				</p>
				<div class="funding-balance-row">
					<span class="funding-balance-amount">{fundingPopupSolBalance.toFixed(4)} SOL</span>
					<span class="funding-balance-label">current balance</span>
				</div>
				<div class="funding-address-block">
					<span class="funding-address-label">Wallet address</span>
					<div class="funding-address-row">
						<code class="funding-address">{fundingPopupAddress}</code>
						<button
							type="button"
							class="funding-copy-btn"
							title="Copy"
							on:click={copyWalletAddressToClipboard}
						>
							⎘
						</button>
					</div>
				</div>
				<a
					class="funding-faucet-link"
					href="https://faucet.solana.com/"
					target="_blank"
					rel="noopener noreferrer"
				>
					faucet.solana.com — get devnet SOL
				</a>
				<div class="session-modal-actions">
					<button type="button" class="session-secondary-btn" on:click={dismissDevnetFundingModal}>
						Got it
					</button>
					<button type="button" class="session-primary-btn" on:click={requestAirdrop}>AIRDROP</button>
				</div>
			</div>
		</div>
	{/if}

	{#if showSessionFundModal}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="session-overlay"
			role="dialog"
			aria-modal="true"
			tabindex="0"
			on:keydown={(e) => e.key === 'Escape' && !sessionFundLoading && closeSessionFundModal()}
		>
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
			<div class="session-modal" role="document" on:click|stopPropagation>
				<div class="session-status-dot pending"></div>
				<h3 class="session-title">Enable one-click trading</h3>
				<p class="session-desc">
					A <strong>session key</strong> signs paper trades for you (no popup per order). Your main wallet approves
					once to create it and transfer SOL to the session for network fees. Session lasts 24 hours.
				</p>

				<div class="session-sol-input-block">
					<label class="session-sol-label" for="sessionSolChrome">
						SOL to fund session
						<span class="session-sol-hint">Min 0.01 · Recommended 0.05–0.2</span>
					</label>
					<div class="session-sol-row">
						<input
							id="sessionSolChrome"
							type="number"
							min="0.01"
							max="2"
							step="0.01"
							bind:value={sessionFundSolAmount}
							class="session-sol-field"
							disabled={sessionFundLoading}
						/>
						<span class="session-sol-unit">SOL</span>
					</div>
					<p class="session-trade-estimate">
						≈ <strong>{Math.max(0, Math.floor(Number(sessionFundSolAmount) / 0.002))}</strong> txs at ~0.002 SOL each
						(estimate)
					</p>
				</div>

				{#if walletBalance < Number(sessionFundSolAmount) + 0.02}
					<p class="session-balance-warn">
						Main wallet: <strong>{walletBalance.toFixed(4)} SOL</strong> — need top-up + ~0.02 SOL for fees. Use
						<strong>AIRDROP</strong> or add SOL first.
					</p>
				{/if}

				<div class="session-details">
					<div class="session-detail-row">
						<span class="detail-label">Duration</span>
						<span class="detail-value">24 hours</span>
					</div>
					<div class="session-detail-row">
						<span class="detail-label">Funded amount</span>
						<span class="detail-value">{Number(sessionFundSolAmount).toFixed(3)} SOL</span>
					</div>
					<div class="session-detail-row">
						<span class="detail-label">Revocable</span>
						<span class="detail-value">Yes</span>
					</div>
				</div>

				<div class="session-modal-actions">
					<button
						type="button"
						class="session-secondary-btn"
						disabled={sessionFundLoading}
						on:click={closeSessionFundModal}
					>
						Cancel
					</button>
					<button
						type="button"
						class="session-primary-btn"
						disabled={sessionFundLoading || Number(sessionFundSolAmount) < 0.01}
						on:click={confirmFundSession}
					>
						{#if sessionFundLoading}
							Signing…
						{:else}
							Fund &amp; enable session
						{/if}
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if showSessionActiveNotice}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="session-overlay"
			role="dialog"
			aria-modal="true"
			tabindex="0"
			on:keydown={(e) => e.key === 'Escape' && (showSessionActiveNotice = false)}
		>
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
			<div class="session-modal" role="document" on:click|stopPropagation>
				<div class="session-status-dot active"></div>
				<h3 class="session-title session-title--active">One-click trading active</h3>
				<p class="session-desc">
					Session key is funded and active. Trades use the session signer; remaining time:
				</p>
				<div class="session-time-badge">{sessionActiveTimeLabel || formatSessionRemainingLabel()}</div>
				<button type="button" class="session-primary-btn" on:click={() => (showSessionActiveNotice = false)}>
					Got it
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.terminal-top-chrome {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.command-bar {
		--nav-fs: 12px;
		--nav-label-fs: 11px;
		--nav-meta-fs: 10px;
		--nav-pad-y: 5px;
		--nav-pad-x: 10px;
		--nav-pill-gap: 6px;
		box-sizing: border-box;
		width: 100%;
		background: #1a1a1a;
		padding: 8px 14px;
		display: flex;
		flex-direction: row;
		flex-wrap: nowrap;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid #333;
		overflow-x: auto;
		overflow-y: hidden;
		min-height: 52px;
		scrollbar-width: thin;
		scrollbar-color: #ff9500 #1a1a1a;
	}

	.command-bar::-webkit-scrollbar {
		height: 6px;
	}

	.command-bar::-webkit-scrollbar-track {
		background: #1a1a1a;
	}

	.command-bar::-webkit-scrollbar-thumb {
		background: #ff9500;
		border-radius: 3px;
	}

	.logo {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.logo-icon {
		width: 24px;
		height: 24px;
		object-fit: contain;
		filter: drop-shadow(0 0 10px rgba(255, 149, 0, 0.18));
	}

	.logo-text {
		font-size: 19px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 2px;
	}

	.nav-links {
		display: flex;
		flex-flow: row nowrap;
		gap: 15px;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.nav-link {
		color: #666;
		text-decoration: none;
		font-size: 14px;
		padding: 5px 11px;
		border: 1px solid transparent;
		transition: all 0.2s;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.nav-link:hover {
		color: #fff;
		border-color: #333;
	}

	.nav-link.active {
		color: #ff9500;
		border-color: #ff9500;
	}

	.pyth-status {
		display: flex;
		flex-flow: row nowrap;
		align-items: center;
		gap: var(--nav-pill-gap);
		color: #ff9500;
		font-size: var(--nav-fs);
		padding: var(--nav-pad-y) var(--nav-pad-x);
		background: #000;
		border: 1px solid #333;
		flex: 0 0 auto;
		min-width: max-content;
		line-height: 1.25;
		white-space: nowrap;
	}

	.status-label {
		color: #666;
		font-size: var(--nav-label-fs);
		letter-spacing: 0.5px;
	}

	.status-value {
		color: #00ff00;
		font-weight: bold;
		font-size: var(--nav-fs);
	}

	.status-age {
		color: #999;
		font-size: var(--nav-meta-fs);
	}

	.magicblock-status {
		display: flex;
		flex-flow: row nowrap;
		align-items: center;
		gap: 5px;
		color: #ff9500;
		font-size: var(--nav-fs);
		padding: var(--nav-pad-y) 8px;
		background: #000;
		border: 1px solid #333;
		flex: 0 0 auto;
		min-width: max-content;
		line-height: 1.25;
		white-space: nowrap;
	}

	.magicblock-status > .status-label,
	.magicblock-status > .status-value,
	.magicblock-status > .magicblock-session-trigger,
	.magicblock-status > .wallet-balance,
	.magicblock-status > .airdrop-btn,
	.magicblock-status > .initialize-btn,
	.magicblock-status > .session-end-btn {
		flex: 0 0 auto;
		white-space: nowrap;
	}

	.magicblock-status > .wallet-balance {
		margin-left: 0;
	}

	.magicblock-status > .airdrop-btn,
	.magicblock-status > .initialize-btn,
	.magicblock-status > .session-end-btn {
		margin-left: 0;
	}

	.wallet-balance {
		color: #00ff00;
		font-weight: bold;
		margin-left: 8px;
		font-size: var(--nav-fs);
	}

	.airdrop-btn {
		background: #ff9500;
		color: #000;
		border: none;
		padding: var(--nav-pad-y) 12px;
		font-size: var(--nav-label-fs);
		font-weight: bold;
		cursor: pointer;
		margin-left: 8px;
		font-family: 'Courier New', monospace;
		letter-spacing: 1px;
		transition: all 0.2s ease;
	}

	.airdrop-btn:hover {
		background: #ffb733;
		transform: scale(1.05);
	}

	.initialize-btn {
		background: #00ff00;
		color: #000;
		border: none;
		padding: var(--nav-pad-y) 12px;
		font-size: var(--nav-label-fs);
		font-weight: bold;
		cursor: pointer;
		margin-left: 8px;
		font-family: 'Courier New', monospace;
		letter-spacing: 1px;
		transition: all 0.2s ease;
	}

	.initialize-btn:hover {
		background: #33ff33;
		transform: scale(1.05);
	}

	.fast-session-btn {
		background: #ff9500;
	}

	.fast-session-btn:hover {
		background: #ffb733;
	}

	.session-end-btn {
		background: #3a2020;
		color: #ff8888;
		border: 1px solid #663333;
	}

	.session-end-btn:hover:not(:disabled) {
		background: #552828;
		color: #ffaaaa;
		transform: none;
	}

	.session-end-btn:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.wallet-section {
		display: flex;
		align-items: center;
		flex: 0 0 auto;
		min-width: max-content;
		white-space: nowrap;
	}

	.command-bar .wallet-section :global(.wallet-connected) {
		padding: var(--nav-pad-y) var(--nav-pad-x);
		gap: 9px;
	}

	.command-bar .wallet-section :global(.wallet-address),
	.command-bar .wallet-section :global(.wallet-name),
	.command-bar .wallet-section :global(.connect-button),
	.command-bar .wallet-section :global(.disconnect-button) {
		font-size: var(--nav-fs);
		line-height: 1.25;
	}

	.command-bar .wallet-section :global(.wallet-name) {
		font-size: var(--nav-label-fs);
	}

	.command-bar .wallet-section :global(.connect-button) {
		padding: var(--nav-pad-y) calc(var(--nav-pad-x) + 6px);
		min-width: 7.5rem;
	}

	.command-bar .wallet-section :global(.disconnect-button) {
		padding: var(--nav-pad-y) var(--nav-pad-x);
		font-size: var(--nav-label-fs);
	}

	.command-bar .wallet-section :global(.spinner) {
		width: 13px;
		height: 13px;
	}

	.ticker-bar {
		background: #0a0a0a;
		display: flex;
		border-bottom: 1px solid #333;
		flex-shrink: 0;
		height: 36px;
		overflow: hidden;
	}

	.ticker-prices {
		display: flex;
		align-items: center;
		gap: 0;
		padding: 0 12px 0 14px;
		flex-shrink: 0;
		border-right: 1px solid #333;
	}

	.ticker-item {
		font-size: 12px;
		color: #888;
		display: flex;
		gap: 6px;
		align-items: center;
		cursor: pointer;
		flex-shrink: 0;
		padding: 2px 8px;
		border-bottom: 2px solid transparent;
		transition:
			color 0.12s ease,
			border-color 0.12s ease;
		white-space: nowrap;
	}

	.ticker-item:hover {
		color: #ccc;
	}

	.ticker-item.ticker-active {
		color: #ff9500;
		border-bottom-color: #ff9500;
	}

	.ticker-sym {
		font-weight: bold;
		letter-spacing: 0.03em;
	}

	.price {
		color: #fff;
		font-weight: bold;
	}

	.change-up {
		color: #00ff00;
		font-size: 12px;
	}

	.change-down {
		color: #ff0000;
		font-size: 12px;
	}

	.news-ticker-container {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		position: relative;
		background: #0a0a0a;
	}

	.news-ticker {
		display: flex;
		align-items: center;
		gap: 40px;
		animation: ticker-scroll 8s linear infinite;
		white-space: nowrap;
		padding: 0 20px;
		height: 100%;
	}

	@keyframes ticker-scroll {
		0% {
			transform: translateX(0);
		}
		100% {
			transform: translateX(-50%);
		}
	}

	.ticker-news-item {
		display: flex;
		align-items: center;
		gap: 8px;
		text-decoration: none;
		color: #ccc;
		font-size: 11px;
		transition: color 0.2s ease;
		flex-shrink: 0;
	}

	.ticker-news-item:hover {
		color: #ff9500;
	}

	.ticker-news-img {
		width: 24px;
		height: 24px;
		object-fit: cover;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.ticker-news-text {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ticker-loading {
		color: #666;
		font-size: 11px;
	}

	.magicblock-session-trigger {
		background: none;
		border: none;
		padding: 0;
		margin: 0;
		cursor: pointer;
		font: inherit;
		color: #00ff00;
		text-decoration: underline;
		text-underline-offset: 2px;
		text-align: left;
		white-space: nowrap;
	}

	.magicblock-session-trigger:hover {
		color: #33ff33;
	}

	.session-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.8);
		backdrop-filter: blur(6px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 10000;
		animation: sessionFadeIn 0.2s ease-out;
	}

	@keyframes sessionFadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.session-modal {
		background: #0a0a0a;
		border: 1px solid #2a2a2a;
		border-radius: 16px;
		padding: 28px 24px;
		max-width: 420px;
		width: 90vw;
		text-align: center;
		animation: sessionSlideUp 0.25s ease-out;
	}

	@keyframes sessionSlideUp {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.session-modal--funding {
		text-align: left;
	}

	.funding-network-badge {
		display: inline-block;
		font-size: 10px;
		font-weight: bold;
		letter-spacing: 0.12em;
		color: #000;
		background: #ff9500;
		padding: 4px 10px;
		border-radius: 4px;
		margin-bottom: 12px;
	}

	.session-status-dot {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		margin: 0 auto 14px auto;
	}

	.session-status-dot.pending {
		background: #ff9500;
		box-shadow: 0 0 12px rgba(255, 149, 0, 0.45);
	}

	.session-status-dot.active {
		background: #00ff66;
		box-shadow: 0 0 12px rgba(0, 255, 102, 0.4);
	}

	.session-title {
		color: #fff;
		font-size: 18px;
		font-weight: 700;
		margin: 0 0 10px 0;
	}

	.session-title--active {
		color: #00ff66;
	}

	.session-desc {
		color: #999;
		font-size: 12px;
		line-height: 1.55;
		margin: 0 0 18px 0;
	}

	.session-sol-input-block {
		margin: 12px 0;
		background: rgba(255, 149, 0, 0.06);
		border: 1px solid rgba(255, 149, 0, 0.25);
		border-radius: 8px;
		padding: 12px 14px;
		text-align: left;
	}

	.session-sol-label {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 11px;
		font-weight: 600;
		color: #e8e8e8;
		margin-bottom: 8px;
	}

	.session-sol-hint {
		font-size: 10px;
		font-weight: 400;
		color: #666;
	}

	.session-sol-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.session-sol-field {
		flex: 1;
		background: #000;
		border: 1px solid #444;
		border-radius: 6px;
		padding: 8px 10px;
		color: #fff;
		font-size: 15px;
		font-weight: 600;
		font-family: inherit;
		outline: none;
	}

	.session-sol-field:focus {
		border-color: #ff9500;
	}

	.session-sol-unit {
		font-size: 12px;
		font-weight: 700;
		color: #ff9500;
	}

	.session-trade-estimate {
		margin: 8px 0 0;
		font-size: 11px;
		color: #888;
	}

	.session-trade-estimate strong {
		color: #ff9500;
	}

	.session-balance-warn {
		font-size: 11px;
		color: #ff6b6b;
		text-align: left;
		margin: 0 0 12px 0;
		line-height: 1.45;
	}

	.session-details {
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid #222;
		border-radius: 8px;
		padding: 12px 14px;
		margin-bottom: 16px;
		text-align: left;
	}

	.session-detail-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 0;
		font-size: 11px;
	}

	.session-detail-row + .session-detail-row {
		border-top: 1px solid #222;
		margin-top: 4px;
		padding-top: 10px;
	}

	.detail-label {
		color: #666;
	}

	.detail-value {
		color: #ccc;
		font-weight: 600;
	}

	.session-modal-actions {
		display: flex;
		gap: 10px;
		justify-content: stretch;
	}

	.session-modal-actions .session-primary-btn,
	.session-modal-actions .session-secondary-btn {
		flex: 1;
	}

	.session-primary-btn,
	.session-secondary-btn {
		padding: 12px 14px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: bold;
		font-family: inherit;
		cursor: pointer;
		border: none;
		letter-spacing: 0.04em;
	}

	.session-primary-btn {
		background: #ff9500;
		color: #000;
	}

	.session-primary-btn:hover:not(:disabled) {
		background: #ffb733;
	}

	.session-primary-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.session-secondary-btn {
		background: #222;
		color: #ccc;
		border: 1px solid #444;
	}

	.session-secondary-btn:hover:not(:disabled) {
		background: #333;
	}

	.session-time-badge {
		display: inline-block;
		padding: 6px 14px;
		background: rgba(0, 255, 102, 0.1);
		border: 1px solid rgba(0, 255, 102, 0.35);
		border-radius: 20px;
		color: #00ff66;
		font-size: 12px;
		font-weight: 700;
		margin-bottom: 18px;
	}

	.funding-balance-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-bottom: 14px;
		flex-wrap: wrap;
	}

	.funding-balance-amount {
		font-size: 20px;
		font-weight: 700;
		color: #ff9500;
	}

	.funding-balance-label {
		font-size: 11px;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.funding-address-block {
		margin-bottom: 14px;
	}

	.funding-address-label {
		display: block;
		font-size: 10px;
		color: #666;
		margin-bottom: 6px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.funding-address-row {
		display: flex;
		align-items: center;
		gap: 8px;
		background: #000;
		border: 1px solid #333;
		border-radius: 6px;
		padding: 8px 10px;
	}

	.funding-address {
		flex: 1;
		font-size: 10px;
		color: #aaa;
		word-break: break-all;
	}

	.funding-copy-btn {
		background: #222;
		border: 1px solid #444;
		color: #ff9500;
		border-radius: 4px;
		padding: 4px 8px;
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
	}

	.funding-copy-btn:hover {
		background: #333;
	}

	.funding-faucet-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: #6ae;
		margin-bottom: 16px;
	}

	.funding-faucet-link:hover {
		color: #8cf;
	}
</style>
