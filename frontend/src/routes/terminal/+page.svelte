<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { magicBlockClient, PositionDirection, PERP_LEVERAGE_TIERS, TRADING_PAIRS, ALL_MARKETS } from '$lib/magicblock';
	import {
		pythPrices as priceStore,
		pythConnectionStatus,
		pythLastUpdate as lastUpdateStore,
		startPythStream,
		type PriceData,
	} from '$lib/stores/pythPrices';
	import { walletStore } from '$lib/wallet/stores';
	import {
		binanceOrderBook,
		binanceTrades,
		connectBinance,
		disconnectBinance,
	} from '$lib/stores/binanceOrderbook';
	import TerminalTopChrome from '$lib/components/trading/TerminalTopChrome.svelte';
	import PythChart from '$lib/components/trading/PythChart.svelte';
	import Toast from '$lib/toast/Toast.svelte';
	import { toastStore } from '$lib/toast/store';
	import * as ENV from '$lib/env';

	let prices: Record<string, PriceData> = $priceStore;
	let selectedTab = 'SOL';
	let chartView: 'tradingview' | 'pyth' = 'tradingview';
	let positionSize = '100';
	let takeProfit = '';
	let stopLoss = '';
	let limitPriceInput = '';
	let perpLeverage = 10;
	let selectedPercentage = 0;
	let tradingMode = 'manual'; // 'manual' or 'percentage'
	let availableBalance = { tokenIn: 0, tokenOut: 0 };
	/** Single size field; USDT = notional, BASE = amount in {selectedTab} (converted to notional on submit). */
	let tradeSize = '';
	let tradeSide: 'buy' | 'sell' = 'buy';
	/** Spot = cash legs; Perp = margined (program perp mode). Synced from Spot | Limit | Perps tabs. */
	let tradeSurface: 'spot' | 'perp' = 'spot';
	/** Spot = market spot + TP/SL; Limit = spot limit + TP/SL; Perps = market perp long/short + leverage + TP/SL. */
	let tradingTabUI: 'spot' | 'limit' | 'perps' = 'spot';
	let sizeDenom: 'USDT' | 'BASE' = 'USDT';
	let orderBookColumn: 'book' | 'trades' = 'book';
	let positionsDockTab: 'orders' | 'balance' = 'balance';
	let orderBookPrecision = '0.01';
	let activePositions: any[] = [];
	let onChainPositions: any[] = [];
	let totalPnL = 0;
	let totalTrades = 0;
	let winningTrades = 0;
	let currentTime = new Date().toLocaleTimeString();
	let pythStatus = 'Initializing...';
	let pythLastUpdate = 0;
	let leaderboardData: any[] = [];

	let walletAddress = '';
	let walletBalance = 0;
	let magicBlockStatus = 'Initializing...';
	let isOnChainMode = true;
	let connectedWallet: any = null;
	let accountsInitialized: { [pairIndex: number]: boolean } = {};
	let showInitializeModal = false;
	let lastFetchTime = 0;
	const FETCH_COOLDOWN = 5000;
	let mockTokenBalances: {
		[pairIndex: number]: {
			tokenInBalance: number;
			tokenOutBalance: number;
			totalPositions: number;
			totalUsdtUsd?: number;
			lockedMarginUsd?: number;
			availableUsd?: number;
		};
	} = {};
	/** MagicBlock session key active → perp/close txs skip repeated wallet popups */
	let fastTradingSessionActive = false;

	/** Polymock-style: modal to choose SOL top-up before `create_session` */
	let showSessionFundModal = false;
	let sessionFundSolAmount = 0.05;
	let sessionFundLoading = false;
	let showSessionActiveNotice = false;
	let sessionActiveTimeLabel = '';

	let showDevnetWalletFundingModal = false;
	let fundingPopupSolBalance = 0;
	let fundingPopupAddress = '';

	const DEVNET_FUNDING_DISMISS_KEY = 'blockberg_devnet_funding_dismissed';


	// Function to refresh trading data based on mode
	async function refreshTradingData() {
		if (!connectedWallet?.connected) return;
		await updateWalletStatus();
	}

	// Subscribe to wallet changes
	walletStore.subscribe(wallet => {
		connectedWallet = wallet;
		if (wallet.connected && wallet.publicKey) {
			walletAddress = wallet.publicKey.toBase58();
			magicBlockClient.setConnectedWallet(wallet.adapter);
			refreshTradingData();
		} else {
			walletAddress = '';
			magicBlockClient.setConnectedWallet(null);
			walletBalance = 0;
			accountsInitialized = {};
			fastTradingSessionActive = false;
			availableBalance = { tokenIn: 0, tokenOut: 0 };
			magicBlockStatus = 'Ready - Connect wallet to trade';
			showSessionFundModal = false;
			showSessionActiveNotice = false;
			showDevnetWalletFundingModal = false;
		}
	});

	async function fetchOnChainPositions(force = false) {
		if (!connectedWallet?.connected) {
			onChainPositions = [];
			return;
		}

		const now = Date.now();
		if (!force && now - lastFetchTime < FETCH_COOLDOWN) {
			return;
		}
		lastFetchTime = now;

		try {
			onChainPositions = await magicBlockClient.fetchPositions();
		} catch (error) {
			onChainPositions = [];
		}
	}

	async function updateWalletStatus() {
		try {
			walletBalance = await magicBlockClient.getBalance();
			accountsInitialized = await magicBlockClient.getAccountStatus();

			// Positions first (forced) so balance math and UI lists match right after trades.
			await fetchOnChainPositions(true);

			mockTokenBalances = await magicBlockClient.getAllUserAccountData();
			updateAvailableBalance();

			await updateLeaderboardAndStats();

			fastTradingSessionActive = magicBlockClient.isPaperTradingSessionActive();
			magicBlockStatus = fastTradingSessionActive
				? 'Connected · Session active'
				: 'Connected · No session';

			maybeOfferDevnetFunding();

			// Force reactivity update
			mockTokenBalances = mockTokenBalances;
			availableBalance = availableBalance;
		} catch (error) {
			console.error('Wallet status update error:', error);
			magicBlockStatus = 'Connected - Status check failed';
		}
	}

	async function updateLeaderboardAndStats() {
		try {
			const currentPrices: Record<string, number> = {};
			for (const [symbol, priceData] of Object.entries(prices)) {
				currentPrices[symbol] = priceData.price;
			}

			leaderboardData = await magicBlockClient.fetchLeaderboard(currentPrices);

			if (connectedWallet?.connected) {
				let userTotalValue = 0;
				let userTotalPositions = 0;

				for (const [pairIndex, balances] of Object.entries(mockTokenBalances)) {
					const pairSymbols = ['SOL', 'BTC', 'ETH', 'AVAX', 'LINK'];
					const pairSymbol = pairSymbols[Number(pairIndex)];
					const currentPrice = prices[pairSymbol]?.price || 0;

					const pairValue =
						(balances.totalUsdtUsd ?? balances.tokenInBalance) +
						balances.tokenOutBalance * currentPrice;
					userTotalValue += pairValue;
					userTotalPositions += balances.totalPositions;
				}

				totalPnL = userTotalValue - 10000;
				totalTrades = userTotalPositions;
			}
		} catch (error) {
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

			// Initialize accounts for all pairs that aren't already initialized
			for (const [pairName, pairIndex] of Object.entries(TRADING_PAIRS)) {
				if (!accountsInitialized[pairIndex]) {
					const signature = await magicBlockClient.initializeAccount(pairIndex);
				}
			}

			// Update status after initialization, then prompt to fund session (Polymock-style modal)
			await updateWalletStatus();
			if (
				connectedWallet?.connected &&
				!magicBlockClient.isPaperTradingSessionActive() &&
				true
			) {
				openSessionFundModal();
			}

			// Refresh mock token balances after initialization
			setTimeout(async () => {
				await updateWalletStatus();
				updateAvailableBalance();
			}, 3000);
		} catch (error: any) {
			console.error('Init error:', error);
			magicBlockStatus = 'Initialization failed';
		}
	}

	function enableFastTradingSession() {
		openSessionFundModal();
	}

	let disconnectSessionLoading = false;
	let closeAllPositionsLoading = false;

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
			await updateWalletStatus();
		} catch (e: any) {
			toastStore.error('End session failed', e?.message || String(e));
			magicBlockStatus = 'Session revoke failed';
			await updateWalletStatus();
		} finally {
			disconnectSessionLoading = false;
		}
	}

	function updateTime() {
		currentTime = new Date().toLocaleTimeString();
	}

	function startPythLazerUpdates() {
		priceStore.subscribe((p) => {
			prices = p;
		});
		pythConnectionStatus.subscribe((s) => {
			pythStatus = s;
		});
		lastUpdateStore.subscribe((t) => {
			pythLastUpdate = t;
		});
		void startPythStream();
	}

	function precisionOptionsForTab(tab: string): string[] {
		switch (tab) {
			case 'BTC':
				return ['1', '5', '10'];
			case 'ETH':
			case 'BNB':
			case 'LTC':
				return ['0.1', '1', '5'];
			case 'SOL':
			case 'AVAX':
			case 'DOT':
			case 'ATOM':
			case 'APT':
			case 'INJ':
			case 'TAO':
				return ['0.01', '0.05', '0.1'];
			case 'LINK':
			case 'NEAR':
			case 'UNI':
			case 'SUI':
				return ['0.001', '0.01', '0.05'];
			case 'XRP':
			case 'DOGE':
			case 'ADA':
			case 'TRX':
			case 'MATIC':
				return ['0.0001', '0.001', '0.01'];
			default:
				return ['0.01', '0.05', '0.1'];
		}
	}

	async function switchTab(newTab: string) {
		selectedTab = newTab;
		connectBinance(newTab);
		const opts = precisionOptionsForTab(newTab);
		if (!opts.includes(orderBookPrecision)) {
			orderBookPrecision = opts[0];
		}

		if (tradingTabUI === 'limit') {
			const px = prices[newTab as keyof typeof prices]?.price;
			const cur = parseFloat(String(limitPriceInput));
			if (px && px > 0 && (!Number.isFinite(cur) || cur <= 0)) {
				limitPriceInput = px.toFixed(2);
			}
		}

		// Update available balance for the new pair
		updateAvailableBalance();
		
		// Refresh account data for the new pair
		if (connectedWallet?.connected) {
			await updateWalletStatus();
		}
	}

	function getActivePanelType(): 'buy' | 'sell' | 'long' | 'short' {
		return tradeSurface === 'spot'
			? tradeSide === 'buy'
				? 'buy'
				: 'sell'
			: tradeSide === 'buy'
				? 'long'
				: 'short';
	}

	$: activeTradingPanel = getActivePanelType();

	function effectivePaperExecution(): 'market' | 'limit' {
		if (tradingTabUI === 'limit') return 'limit';
		return 'market';
	}

	function needsLimitPriceField(): boolean {
		return tradingTabUI === 'limit';
	}

	/** Always reads mode + tab + input so the submit control stays in sync (no `&&` short-circuit gaps). */
	$: limitPriceMissingForSubmit =
		tradingTabUI === 'limit' &&
		(!limitPriceInput || parseFloat(String(limitPriceInput)) <= 0);

	function showTpSlFields(): boolean {
		return true;
	}

	function setTradingTabUI(tab: 'spot' | 'limit' | 'perps') {
		tradingTabUI = tab;
		if (tab === 'perps') tradeSurface = 'perp';
		else tradeSurface = 'spot';
		if (tab === 'limit') {
			const px = prices[selectedTab as keyof typeof prices]?.price;
			if (px && px > 0 && (!limitPriceInput || String(limitPriceInput).trim() === '')) {
				limitPriceInput = px.toFixed(2);
			}
		}
	}

	function synthDecimals(sym: string): number {
		if (sym === 'BTC') return 6;
		if (sym === 'SOL') return 4;
		return 4;
	}

	$: firstUnifiedBalance =
		mockTokenBalances[TRADING_PAIRS.SOL] ??
		mockTokenBalances[TRADING_PAIRS.BTC] ??
		mockTokenBalances[TRADING_PAIRS.ETH] ??
		mockTokenBalances[TRADING_PAIRS.AVAX] ??
		mockTokenBalances[TRADING_PAIRS.LINK] ??
		null;

	$: heldTokens = (Object.entries(TRADING_PAIRS) as [string, number][]).filter(([sym, idx]) => {
		const row = mockTokenBalances[idx];
		return row && row.tokenOutBalance > 0.000001;
	});

	// Only perp positions show in the open orders dock — spot trades are instant and only affect balance
	$: allDockOrders = onChainPositions.filter(
		(p) =>
			p.type === 'direct' &&
			p.tradeMode === 'perp' &&
			(p.status === 'ACTIVE' || p.status === 'PENDING')
	);

	/** On-chain `locked_margin_usd`: only perp margin (spot trades settle immediately into balance). */
	$: usdtReservedBreakdown = (() => {
		let spot = 0;
		let perp = 0;
		for (const p of onChainPositions) {
			if (p.type !== 'direct') continue;
			if (p.status !== 'ACTIVE' && p.status !== 'PENDING') continue;
			const m = Number(p.marginUsd) || 0;
			if (p.tradeMode === 'perp') perp += m;
			else spot += m;
		}
		return { spot, perp };
	})();

	/** Sum of mark-to-market unrealized PnL (USDT) across active perp positions only. */
	$: portfolioMarkUnrealizedPnlUsd = (() => {
		let sum = 0;
		for (const p of onChainPositions) {
			if (p.type !== 'direct' || p.status !== 'ACTIVE') continue;
			if (p.tradeMode !== 'perp') continue;
			const markPx = prices[p.pairSymbol]?.price ?? 0;
			const entry = p.entryPrice ?? 0;
			const notional = p.notionalUsd ?? 0;
			if (markPx <= 0 || entry <= 0) continue;
			sum +=
				p.direction === 'LONG'
					? ((markPx - entry) / entry) * notional
					: ((entry - markPx) / entry) * notional;
		}
		return sum;
	})();

	// Live orderbook and trades from Binance WebSocket
	$: orderBookData = $binanceOrderBook;
	$: liveTradesList = $binanceTrades;

	function notionalFromSizeInput(): number {
		const raw = parseFloat(tradeSize);
		if (!raw || raw <= 0) return 0;
		const px = prices[selectedTab as keyof typeof prices]?.price ?? 0;
		if (sizeDenom === 'BASE') {
			if (!px) return 0;
			return raw * px;
		}
		return raw;
	}

	function resetTradeForm() {
		tradeSize = '';
		tradingTabUI = 'spot';
		tradeSurface = 'spot';
		limitPriceInput = '';
		takeProfit = '';
		stopLoss = '';
		resetToManualMode();
	}

	function updateAvailableBalance() {
		if (!connectedWallet?.connected) {
			availableBalance = { tokenIn: 0, tokenOut: 0 };
			return;
		}

		const currentPairIndex = TRADING_PAIRS[selectedTab as keyof typeof TRADING_PAIRS];
		const row = mockTokenBalances[currentPairIndex];
		if (row) {
			const free =
				typeof row.availableUsd === 'number'
					? row.availableUsd
					: Math.max(0, row.tokenInBalance - (row.lockedMarginUsd ?? 0));

			availableBalance = {
				tokenIn: free,
				tokenOut: row.tokenOutBalance
			};
		} else {
			availableBalance = { tokenIn: 0, tokenOut: 0 };
		}
	}

	function setPercentageSize(percentage: number) {
		selectedPercentage = percentage;
		tradingMode = 'percentage';

		const currentPrice = prices[selectedTab as keyof typeof prices].price;
		if (!currentPrice || currentPrice <= 0) {
			return;
		}

		const type = getActivePanelType();
		const isSell = (type === 'sell') && tradeSurface === 'spot';
		const decimals = selectedTab === 'BTC' ? 6 : selectedTab === 'SOL' ? 4 : 6;
		let sizeValue: string;

		if (isSell) {
			// Selling spot: base off the asset balance the user actually holds.
			// Use truncation (not toFixed rounding) so we never produce a value above the actual balance.
			if (sizeDenom === 'BASE') {
				const baseAmt = (availableBalance.tokenOut * percentage) / 100;
				const factor = Math.pow(10, decimals);
				sizeValue = (Math.floor(baseAmt * factor) / factor).toString();
			} else {
				// USDT denom: convert asset balance → USDT value
				const usdtValue = (availableBalance.tokenOut * currentPrice * percentage) / 100;
				sizeValue = Math.max(0.01, Math.floor(usdtValue * 100) / 100).toFixed(2);
			}
		} else if (sizeDenom === 'BASE') {
			const usdtAmount = (availableBalance.tokenIn * percentage) / 100;
			const baseAmt = usdtAmount / currentPrice;
			sizeValue = Math.max(0.0001, baseAmt).toFixed(decimals);
		} else {
			const usdtAmount = (availableBalance.tokenIn * percentage) / 100;
			sizeValue = Math.max(0.01, usdtAmount).toFixed(2);
		}

		tradeSize = sizeValue;
	}

	function resetToManualMode() {
		tradingMode = 'manual';
		selectedPercentage = 0;
	}

function maybeOfferDevnetFunding() {
		if (typeof sessionStorage === 'undefined') return;
		if (sessionStorage.getItem(DEVNET_FUNDING_DISMISS_KEY)) return;
		if (!connectedWallet?.connected || false) return;
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
		if (false) return;
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
			await updateWalletStatus();
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

	/** Paper program orders use session-only sends (Polymock-style); block before RPC to surface a clear message. */
	function requirePaperSessionOrToast(): boolean {
		if (!magicBlockClient.isPaperTradingSessionActive()) {
			magicBlockStatus = 'Paper session required';
			toastStore.error(
				'Session required',
				'Fund a paper session: click MAGICBLOCK status, FAST TRADES, or finish Initialize.'
			);
			return false;
		}
		return true;
	}

	async function submitPanelOrder() {
		if (!connectedWallet?.connected) {
			return;
		}

		const currentPrice = prices[selectedTab as keyof typeof prices].price;
		const sizeVal = notionalFromSizeInput();
		const panel = getActivePanelType();

		if (!sizeVal || sizeVal <= 0 || !currentPrice || currentPrice <= 0) {
			magicBlockStatus = 'Price not loaded. Please wait...';
			return;
		}

		// Spot buy/sell: execute against held balance, not open a position
		if (panel === 'buy' || panel === 'sell') {
			if (panel === 'sell') {
				const tokenAmount = sizeDenom === 'BASE'
					? parseFloat(tradeSize)
					: sizeVal / currentPrice;
				// Allow a small tolerance to absorb rounding differences from toFixed/floor
				if (tokenAmount > availableBalance.tokenOut * 1.0001 + 0.0001) {
					toastStore.error('Insufficient balance', `You only have ${availableBalance.tokenOut.toFixed(6)} ${selectedTab} to sell.`);
					return;
				}
			}
			await executeSpotTrade(panel === 'buy' ? 'BUY' : 'SELL');
			return;
		}

		// Perp long/short: open a leveraged position
		const exec = effectivePaperExecution();
		if (needsLimitPriceField()) {
			const lim = parseFloat(limitPriceInput);
			if (!lim || lim <= 0) {
				toastStore.error('Limit order', 'Enter a valid limit price (USD).');
				return;
			}
		}

		if (!isOnChainMode) {
			return;
		}

		if (!requirePaperSessionOrToast()) {
			return;
		}

		try {
			magicBlockStatus = 'Submitting order...';
			const sideLong = panel === 'long';
			const tp = showTpSlFields() && takeProfit ? parseFloat(takeProfit) : undefined;
			const sl = showTpSlFields() && stopLoss ? parseFloat(stopLoss) : undefined;
			const lim = limitPriceInput ? parseFloat(limitPriceInput) : undefined;

			await magicBlockClient.placePaperOrder({
				pairSymbol: selectedTab,
				side: sideLong ? 'long' : 'short',
				surface: 'perp',
				execution: exec,
				notionalUsd: sizeVal,
				leverage: Number(perpLeverage),
				limitPriceUsd: exec === 'limit' ? lim : undefined,
				takeProfitUsd: tp,
				stopLossUsd: sl,
				marketPriceUsd: currentPrice,
			});

			magicBlockStatus = 'Order submitted';
			toastStore.success(
				'Order submitted',
				`${exec.toUpperCase()} perp ${sideLong ? 'LONG' : 'SHORT'} on ${selectedTab}`
			);

			await updateWalletStatus();
			updateAvailableBalance();
			setTimeout(async () => {
				await updateWalletStatus();
				updateAvailableBalance();
			}, 1000);

			resetTradeForm();
		} catch (error: any) {
			console.error('Order error:', error);
			magicBlockStatus = 'Order failed';
			const detail =
				error?.message ||
				(typeof error === 'object' && error !== null
					? JSON.stringify(error)
					: String(error));
			toastStore.error('Order failed', detail || 'Transaction failed. Please try again.');
		}
	}

	function updateCurrentSize(value: string) {
		tradeSize = value;
		resetToManualMode();
	}

	function onDenomChange(newDenom: 'USDT' | 'BASE') {
		const currentPrice = prices[selectedTab]?.price ?? 0;
		const raw = parseFloat(tradeSize);
		if (!raw || raw <= 0 || currentPrice <= 0) {
			sizeDenom = newDenom;
			return;
		}
		const decimals = selectedTab === 'BTC' ? 6 : selectedTab === 'SOL' ? 4 : 6;
		if (newDenom === 'BASE' && sizeDenom === 'USDT') {
			// USDT → asset: divide by price
			tradeSize = (raw / currentPrice).toFixed(decimals);
		} else if (newDenom === 'USDT' && sizeDenom === 'BASE') {
			// asset → USDT: multiply by price
			tradeSize = (raw * currentPrice).toFixed(2);
		}
		sizeDenom = newDenom;
		resetToManualMode();
	}

	async function executeSpotTrade(action: 'BUY' | 'SELL') {

		if (!connectedWallet?.connected) {
			return;
		}

		const currentPrice = prices[selectedTab as keyof typeof prices].price;
		const raw = parseFloat(tradeSize);
		const tokenAmount =
			sizeDenom === 'USDT' && currentPrice > 0 ? raw / currentPrice : raw;

		if (tokenAmount <= 0 || !currentPrice || currentPrice <= 0) {
			magicBlockStatus = 'Price not loaded. Please wait...';
			return;
		}

		if (isOnChainMode && connectedWallet?.connected) {
			try {
				magicBlockStatus = `${action}...`;

				let txSig: string;

					if (!requirePaperSessionOrToast()) {
						return;
					}

					if (action === 'SELL') {
						// Close existing spot LONG positions to reduce the held balance.
						// Positions are sorted oldest-first so we exhaust small positions before large ones.
						const spotLongs = onChainPositions
							.filter(
								(p) =>
									p.type === 'direct' &&
									p.tradeMode === 'spot' &&
									p.direction === 'LONG' &&
									p.pairSymbol === selectedTab &&
									(p.status === 'ACTIVE' || p.status === 'PENDING')
							)
							.sort(
								(a, b) =>
									(a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0)
							);

						if (spotLongs.length === 0) {
							toastStore.error(
								'No position to sell',
								`No open spot ${selectedTab} position found.`
							);
							return;
						}

						let remaining = tokenAmount;
						for (const pos of spotLongs) {
							if (remaining <= 0.00001) break;

							const posBase =
								pos.amountTokenOut > 0
									? pos.amountTokenOut
									: pos.entryPrice > 0
									? pos.notionalUsd / pos.entryPrice
									: 0;
							if (posBase <= 0) continue;

							if (posBase <= remaining + 0.0001) {
								// Close this position fully via session key (no wallet popup)
								txSig = await magicBlockClient.closeDirectPosition(pos.pubkey, currentPrice);
								remaining -= posBase;
							} else {
								// Position is larger than what we need to sell.
								// Close it fully, then re-open a LONG for the excess so the user
								// keeps the unsold portion.
								txSig = await magicBlockClient.closeDirectPosition(pos.pubkey, currentPrice);
								const excessBase = posBase - remaining;
								const excessNotional = excessBase * currentPrice;
								if (excessNotional >= 0.01) {
									await magicBlockClient.executeSpotTrade(
										selectedTab,
										'BUY',
										currentPrice,
										excessBase,
										{ notionalUsd: excessNotional }
									);
								}
								remaining = 0;
							}
						}

						magicBlockStatus = 'SELL complete';
					} else {
						// BUY: open a new spot LONG position
						const n = notionalFromSizeInput();
						txSig = await magicBlockClient.executeSpotTrade(
							selectedTab,
							action,
							currentPrice,
							0,
							{ notionalUsd: n > 0 ? n : tokenAmount * currentPrice }
						);
						magicBlockStatus = `${action} complete`;
					}

				// Show success toast
				toastStore.success(
					`${action} Order Executed`,
					`Successfully ${action === 'BUY' ? 'bought' : 'sold'} ${tokenAmount} ${selectedTab} at $${currentPrice.toFixed(2)}`
				);

				await updateWalletStatus();
				updateAvailableBalance();

				setTimeout(async () => {
					await updateWalletStatus();
					updateAvailableBalance();
				}, 1000);
			} catch (error: any) {
				console.error('Trade error:', error);
				magicBlockStatus = `${action} failed`;

				// Show error toast with the actual error message
				const errorMessage = error.message || 'Transaction failed. Please try again.';
				toastStore.error(`${action} Failed`, errorMessage);
				return;
			}
		}

		tradeSize = '';
		resetToManualMode();
	}

	async function openPosition(direction: 'LONG' | 'SHORT') {
		if (!connectedWallet?.connected) {
			return;
		}

		const currentPrice = prices[selectedTab as keyof typeof prices].price;
		const tokenAmount = notionalFromSizeInput();

		if (!tokenAmount || tokenAmount <= 0 || !currentPrice || currentPrice <= 0) {
			magicBlockStatus = 'Price not loaded. Please wait...';
			return;
		}

		if (isOnChainMode) {
			if (!requirePaperSessionOrToast()) {
				return;
			}
			try {
				magicBlockStatus = 'Opening...';
				const tp = takeProfit ? parseFloat(takeProfit) : undefined;
				const sl = stopLoss ? parseFloat(stopLoss) : undefined;

				const txSig = await magicBlockClient.openPosition(
					selectedTab,
					direction === 'LONG' ? PositionDirection.Long : PositionDirection.Short,
					currentPrice,
					tokenAmount,
					tp,
					sl,
					perpLeverage
				);

				magicBlockStatus = 'Position opened';

				// Show success toast
				const tpSlInfo = tp || sl ? ` (TP: ${tp ? `$${tp}` : 'N/A'}, SL: ${sl ? `$${sl}` : 'N/A'})` : '';
				toastStore.success(
					`${direction} Position Opened`,
					`Opened ${direction} position on ${selectedTab} - Size: $${tokenAmount} at $${currentPrice.toFixed(2)}${tpSlInfo}`
				);

				// Immediate refresh
				await updateWalletStatus();
				updateAvailableBalance();

				// Additional refresh after delay
				setTimeout(async () => {
					await updateWalletStatus();
					updateAvailableBalance();
				}, 1000);
			} catch (error: any) {
				console.error('Position error:', error);
				magicBlockStatus = 'Open failed';

				// Show error toast with the actual error message
				const errorMessage = error.message || 'Failed to open position. Please try again.';
				toastStore.error(`${direction} Position Failed`, errorMessage);
				return;
			}
		}

		const position = {
			id: Date.now(),
			symbol: selectedTab,
			direction,
			entryPrice: currentPrice,
			size: tokenAmount,
			takeProfit: takeProfit ? parseFloat(takeProfit) : null,
			stopLoss: stopLoss ? parseFloat(stopLoss) : null,
			timestamp: new Date().toLocaleTimeString(),
			pnl: 0
		};

		activePositions = [...activePositions, position];
		
		resetTradeForm();
	}

	async function closePosition(id: number | string) {
		if (isOnChainMode && connectedWallet?.connected) {
			const onChainPos = onChainPositions.find((p) => p.pubkey === id);
			if (onChainPos && !requirePaperSessionOrToast()) {
				return;
			}
			try {
				magicBlockStatus = 'Closing position on-chain...';

				let txSig: string;

				if (onChainPos) {
					if (onChainPos.status === 'PENDING') {
						txSig = await magicBlockClient.cancelLimitOrder(id.toString());
					} else {
						const currentPrice =
							prices[onChainPos.pairSymbol]?.price || onChainPos.entryPrice || 0;
						txSig = await magicBlockClient.closeDirectPosition(id.toString(), currentPrice);
					}
				} else {
					toastStore.error('Close failed', 'Position not found. Refresh and try again.');
					magicBlockStatus = 'Close failed';
					return;
				}

				magicBlockStatus = `Position closed: ${txSig.substring(0, 8)}...`;

				// Show success toast
				if (onChainPos) {
					if (onChainPos.status === 'PENDING') {
						toastStore.success(
							'Order cancelled',
							`Removed limit order on ${onChainPos.pairSymbol}`
						);
					} else {
						const pnlDisplay =
							onChainPos.pnl >= 0
								? `+$${onChainPos.pnl.toFixed(2)}`
								: `-$${Math.abs(onChainPos.pnl).toFixed(2)}`;
						toastStore.success(
							'Position Closed',
							`Closed ${onChainPos.direction} ${onChainPos.pairSymbol} position. P&L: ${pnlDisplay}`
						);
					}
				} else {
					toastStore.success('Position Closed', 'Your position has been closed successfully.');
				}

				await updateWalletStatus();
				setTimeout(async () => {
					await updateWalletStatus();
				}, 1000);

			} catch (error: any) {
				if (error.message?.includes('This transaction has already been processed') ||
					error.message?.includes('Transaction already processed')) {
					magicBlockStatus = 'Position closed';
					toastStore.success('Position Closed', 'Your position has been closed successfully.');

					await updateWalletStatus();
					setTimeout(async () => {
						await updateWalletStatus();
					}, 1000);
				} else {
					magicBlockStatus = 'Close failed';
					const errorMessage = error.message || 'Failed to close position. Please try again.';
					toastStore.error('Close Position Failed', errorMessage);
				}
			}
		}

		// Handle traditional position closing for off-chain mode
		const position = activePositions.find(p => p.id === id);
		if (!position) return;

		const currentPrice = prices[position.symbol].price;
		const pnl = position.direction === 'LONG'
			? ((currentPrice - position.entryPrice) / position.entryPrice) * position.size
			: ((position.entryPrice - currentPrice) / position.entryPrice) * position.size;

		totalPnL += pnl;
		totalTrades += 1;
		if (pnl > 0) winningTrades += 1;

		activePositions = activePositions.filter(p => p.id !== id);
	}

	/** Close every perp position / order listed in the dock (same set as `allDockOrders`). */
	async function closeAllOpenPositions() {
		if (!isOnChainMode || !connectedWallet?.connected) return;
		if (!requirePaperSessionOrToast()) return;

		const queue = onChainPositions.filter(
			(p) =>
				p.type === 'direct' &&
				p.tradeMode === 'perp' &&
				(p.status === 'ACTIVE' || p.status === 'PENDING')
		);
		if (queue.length === 0) {
			toastStore.info('Nothing to close', 'No open perp positions or orders in the list.');
			return;
		}

		closeAllPositionsLoading = true;
		magicBlockStatus = `Closing ${queue.length} position(s)…`;
		let closed = 0;
		try {
			for (const p of queue) {
				if (p.status === 'PENDING') {
					await magicBlockClient.cancelLimitOrder(p.pubkey);
				} else {
					const currentPrice = prices[p.pairSymbol]?.price || p.entryPrice || 0;
					if (!currentPrice || currentPrice <= 0) {
						throw new Error(`No live price for ${p.pairSymbol}; cannot close.`);
					}
					await magicBlockClient.closeDirectPosition(p.pubkey, currentPrice);
				}
				closed++;
			}
			await updateWalletStatus();
			toastStore.success('All closed', `Closed or cancelled ${closed} perp order(s).`);
			magicBlockStatus = 'All positions closed';
		} catch (e: any) {
			magicBlockStatus = 'Close all failed';
			toastStore.error(
				'Close all failed',
				e?.message || String(e) || 'One or more closes failed. Refresh and retry.'
			);
			await updateWalletStatus();
		} finally {
			closeAllPositionsLoading = false;
		}
	}

	async function requestAirdrop() {
		if (!connectedWallet?.connected) {
			return;
		}

		try {
			magicBlockStatus = 'Requesting airdrop...';
			const { Connection } = await import('@solana/web3.js');
			const solanaConnection = new Connection(ENV.SOLANA_RPC, 'confirmed');
			const signature = await solanaConnection.requestAirdrop(
				connectedWallet.publicKey,
				2000000000
			);
			await solanaConnection.confirmTransaction(signature, 'confirmed');
			magicBlockStatus = 'Airdrop sent';

			const pollInterval = setInterval(async () => {
				await updateWalletStatus();
				if (showDevnetWalletFundingModal) {
					fundingPopupSolBalance = walletBalance;
				}
				if (walletBalance > 1) {
					magicBlockStatus = `Funded: ${walletBalance.toFixed(2)} SOL`;
					clearInterval(pollInterval);
				}
			}, 2000);

			setTimeout(() => clearInterval(pollInterval), 60000);
		} catch (error: any) {
			console.error('Airdrop error:', error);
			magicBlockStatus = 'Airdrop failed';
		}
	}

	// Reactive statement to fetch positions when wallet connects
	$: if (connectedWallet?.connected) {
		setTimeout(async () => {
			await fetchOnChainPositions(true);
		}, 1000);
	}

	// Reactive statement to update available balance when tab or balances change
	$: if (selectedTab && mockTokenBalances && onChainPositions) {
		updateAvailableBalance();
	}

	$: {
		activePositions = activePositions.map(position => {
			const currentPrice = prices[position.symbol].price;
			const pnl = position.direction === 'LONG'
				? position.size * ((currentPrice - position.entryPrice) / position.entryPrice)
				: position.size * ((position.entryPrice - currentPrice) / position.entryPrice);

			if (position.takeProfit &&
				((position.direction === 'LONG' && currentPrice >= position.takeProfit) ||
				 (position.direction === 'SHORT' && currentPrice <= position.takeProfit))) {
				setTimeout(() => closePosition(position.id), 0);
			}

			if (position.stopLoss &&
				((position.direction === 'LONG' && currentPrice <= position.stopLoss) ||
				 (position.direction === 'SHORT' && currentPrice >= position.stopLoss))) {
				setTimeout(() => closePosition(position.id), 0);
			}

			return { ...position, pnl };
		});
	}

	onMount(() => {

		// Initialize session wallet as fallback but don't set as primary wallet
		const initializeWallet = async () => {
			try {
				magicBlockStatus = 'Initializing session wallet fallback...';
				await magicBlockClient.initializeSessionWallet();
				magicBlockClient.setAdminWallet('2ACsdGiDz4qhCNTkbkPcHNEk5DuG9cfyV4o1j9sidxhFKhyyXWg4GgHutwQrnXBovSRA9ixfVWwYWzNH8hHmbDy2');
				
				// If no wallet is connected, show default status
				if (!connectedWallet?.connected) {
					magicBlockStatus = 'Ready - Connect wallet to trade';
				}
			} catch (error) {
				magicBlockStatus = 'Initialization failed';
			}
		};

		initializeWallet();
		startPythLazerUpdates();
		updateTime();
		connectBinance(selectedTab);

		const qPair = get(page).url.searchParams.get('pair');
		if (qPair && (ALL_MARKETS as readonly string[]).includes(qPair)) {
			void switchTab(qPair);
		}

		setInterval(updateTime, 1000);

		// Fetch positions every 15 seconds to avoid devnet RPC rate limits
		setInterval(async () => {
			if (connectedWallet?.connected) {
				await fetchOnChainPositions();
			}
		}, 15000);

		// Initial position fetch when page loads (after wallet might be connected)
		setTimeout(async () => {
			if (connectedWallet?.connected) {
				await fetchOnChainPositions();
			}
		}, 3000);


	});

	onDestroy(() => {
		disconnectBinance();
	});
</script>

<div class="bloomberg">
	<TerminalTopChrome
		activeSection="terminal"
		selectedMarketSymbol={selectedTab}
		on:marketselect={(e) => void switchTab(e.detail.symbol)}
	/>

	<div class="main-grid">
		<div class="panel chart-panel">
			<div class="panel-header">
				<div class="chart-header-left">
					<span class="chart-title">{selectedTab}/USD</span>
					<div class="chart-view-toggle">
						<button
							type="button"
							class="cv-btn"
							class:cv-active={chartView === 'tradingview'}
							on:click={() => chartView = 'tradingview'}
						>TradingView</button>
						<button
							type="button"
							class="cv-btn"
							class:cv-active={chartView === 'pyth'}
							on:click={() => chartView = 'pyth'}
						>Pyth Live</button>
					</div>
				</div>
				<div class="chart-stats">
					<div class="stat-box">
						<span class="stat-label">SPOT</span>
						<span class="stat-value price-value">${prices[selectedTab].price.toFixed(4)}</span>
						<span class={prices[selectedTab].change >= 0 ? 'change-up' : 'change-down'}>
							{prices[selectedTab].change >= 0 ? '▲' : '▼'} {Math.abs(prices[selectedTab].change).toFixed(2)}%
						</span>
					</div>
					<div class="stat-box">
						<span class="stat-label">EMA</span>
						<span class="stat-value ema-value">${prices[selectedTab].emaPrice.toFixed(4)}</span>
					</div>
					<div class="stat-box">
						<span class="stat-label">CONFIDENCE</span>
						<span class="stat-value conf-value">±{prices[selectedTab].spread.toFixed(3)}%</span>
					</div>
					{#if prices[selectedTab].publishTime > 0}
						<div class="stat-box">
							<span class="stat-label">FRESH</span>
							<span class="stat-value fresh-value">{Math.floor((Date.now() / 1000 - prices[selectedTab].publishTime))}s</span>
						</div>
					{/if}
				</div>
			</div>
			<div class="chart-container">
				{#if chartView === 'tradingview'}
					<iframe
						src="https://www.tradingview.com/widgetembed/?symbol=BINANCE:{selectedTab}USDT&interval=15&theme=dark&style=1&locale=en&allow_symbol_change=0"
						style="width:100%;height:100%;border:none;"
						title="{selectedTab} Chart"
						allow="fullscreen"
					></iframe>
				{:else}
					<PythChart symbol={selectedTab} interval="15m" />
				{/if}
			</div>


		</div>

		<div class="panel orderbook-panel">
			<div class="ob-top">
				<span class="ob-title">{selectedTab}/USDT</span>
			</div>
			<div class="ob-tabs">
				<button
					type="button"
					class="ob-tab"
					class:active={orderBookColumn === 'book'}
					on:click={() => (orderBookColumn = 'book')}
				>
					Order Book
				</button>
				<button
					type="button"
					class="ob-tab"
					class:active={orderBookColumn === 'trades'}
					on:click={() => (orderBookColumn = 'trades')}
				>
					Trades
				</button>
			</div>
			<div class="ob-body">
				{#if orderBookColumn === 'book'}
					{@const maxSz = Math.max(
						...orderBookData.asks.map((a) => a.size),
						...orderBookData.bids.map((b) => b.size),
						1e-12
					)}
					<div class="ob-col-hdr">
						<span>Price</span>
						<span class="ob-hdr-mid">Size ({selectedTab})</span>
						<span class="ob-hdr-end">Total ({selectedTab})</span>
					</div>
					<div class="ob-scroll">
						<div class="ob-side ob-asks-wrap">
							{#each [...orderBookData.asks].reverse() as row}
								<div
									class="ob-row ob-ask-row"
									style="--ob-depth-pct: {Math.min(100, (row.size / maxSz) * 100)}%"
								>
									<span class="ob-p ob-ask-p">{row.price.toFixed(4)}</span>
									<span class="ob-s">{row.size.toFixed(4)}</span>
									<span class="ob-t">{row.total.toFixed(4)}</span>
								</div>
							{/each}
						</div>
						<div class="ob-spread-row">
							Spread {orderBookData.spreadAbs.toFixed(4)}
							<span class="ob-spread-pct">{orderBookData.spreadPct.toFixed(3)}%</span>
						</div>
						<div class="ob-side ob-bids-wrap">
							{#each orderBookData.bids as row}
								<div
									class="ob-row ob-bid-row"
									style="--ob-depth-pct: {Math.min(100, (row.size / maxSz) * 100)}%"
								>
									<span class="ob-p ob-bid-p">{row.price.toFixed(4)}</span>
									<span class="ob-s">{row.size.toFixed(4)}</span>
									<span class="ob-t">{row.total.toFixed(4)}</span>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div class="ob-col-hdr ob-trades-hdr">
						<span>Price</span>
						<span class="ob-hdr-mid">Size</span>
						<span class="ob-hdr-end">Time</span>
					</div>
					<div class="ob-scroll ob-trades-scroll">
						{#each liveTradesList as t}
							<div
								class="ob-trade-line"
								class:trade-buy={t.side === 'buy'}
								class:trade-sell={t.side === 'sell'}
							>
								<span>{t.price.toFixed(2)}</span>
								<span class="ob-hdr-mid">{t.size.toFixed(4)}</span>
								<span class="ob-hdr-end">{t.t}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<div class="panel trade-column-panel">
			<div class="trading-panel-hl">
				<div class="hl-trading-form-scroll">
					<div class="hl-order-tabs">
						<button
							type="button"
							class="hl-ot"
							class:active={tradingTabUI === 'spot'}
							on:click={() => setTradingTabUI('spot')}
						>
							Spot
						</button>
						<button
							type="button"
							class="hl-ot"
							class:active={tradingTabUI === 'limit'}
							on:click={() => setTradingTabUI('limit')}
						>
							Limit
						</button>
						<button
							type="button"
							class="hl-ot"
							class:active={tradingTabUI === 'perps'}
							on:click={() => setTradingTabUI('perps')}
						>
							Perps
						</button>
					</div>

				<div class="hl-buy-sell">
					<button
						type="button"
						class="hl-bs hl-bs-buy"
						class:active={tradeSide === 'buy'}
						on:click={() => (tradeSide = 'buy')}
					>
						{tradingTabUI === 'perps' ? 'Long' : 'Buy'}
					</button>
					<button
						type="button"
						class="hl-bs hl-bs-sell"
						class:active={tradeSide === 'sell'}
						on:click={() => (tradeSide = 'sell')}
					>
						{tradingTabUI === 'perps' ? 'Short' : 'Sell'}
					</button>
				</div>

					{#if tradingTabUI === 'limit'}
						<div class="hl-field hl-field-limit-priority">
							<span class="hl-label">Limit price (USD)</span>
							<input
								type="number"
								class="hl-input hl-input-full"
								bind:value={limitPriceInput}
								min="0"
								step="0.01"
								placeholder={prices[selectedTab as keyof typeof prices].price > 0
									? prices[selectedTab as keyof typeof prices].price.toFixed(2)
									: '0.00'}
							/>
							<p class="hl-limit-hint">
								Required for limit orders — set the USD price at which this order should fill.
							</p>
						</div>
					{/if}

				<p class="hl-available">
					Available to trade:
					<strong>
						{#if tradeSide === 'sell' && tradeSurface === 'spot'}
							{availableBalance.tokenOut.toFixed(4)} {selectedTab}
							{#if prices[selectedTab]?.price > 0}
								≈ ${(availableBalance.tokenOut * prices[selectedTab].price).toFixed(2)}
							{/if}
						{:else}
							{availableBalance.tokenIn.toFixed(2)} USDT
						{/if}
					</strong>
				</p>

				<div class="hl-size-block">
					<span class="hl-label">Size</span>
					<div class="hl-size-input-row">
						<input
							type="number"
							class="hl-input"
							value={tradeSize}
							on:input={(e) => updateCurrentSize((e.target as HTMLInputElement).value)}
							placeholder="0.00"
						/>
						<select
							class="hl-unit-select"
							value={sizeDenom}
							on:change={(e) => onDenomChange((e.target as HTMLSelectElement).value as 'USDT' | 'BASE')}
						>
							<option value="USDT">USDT</option>
							<option value="BASE">{selectedTab}</option>
						</select>
					</div>
				</div>

				{#if tradingTabUI !== 'perps'}
					<div class="hl-pct-row">
						{#each [25, 50, 75] as pct}
							<button
								type="button"
								class="hl-pct-btn"
								class:hl-pct-active={selectedPercentage === pct}
								on:click={() => setPercentageSize(pct)}
							>{pct}%</button>
						{/each}
						<button
							type="button"
							class="hl-pct-btn hl-pct-max"
							class:hl-pct-active={selectedPercentage === 100}
							on:click={() => setPercentageSize(100)}
						>Max</button>
					</div>
				{/if}

				{#if tradingTabUI === 'perps'}
					<div class="hl-field">
						<span class="hl-label">Leverage</span>
						<select class="hl-input hl-select-full" bind:value={perpLeverage}>
							{#each PERP_LEVERAGE_TIERS as lev}
								<option value={lev}>{lev}x</option>
							{/each}
						</select>
					</div>
				{/if}

				{#if showTpSlFields()}
					<div class="hl-field">
						<span class="hl-label">Take profit (price)</span>
						<input type="number" class="hl-input hl-input-full" bind:value={takeProfit} placeholder="Optional" />
					</div>
					<div class="hl-field">
						<span class="hl-label">Stop loss (price)</span>
						<input type="number" class="hl-input hl-input-full" bind:value={stopLoss} placeholder="Optional" />
					</div>
				{/if}
				</div>

				<div class="hl-trading-footer">
					<div class="hl-summary">
						{#if tradeSize && true}
							{@const n = notionalFromSizeInput()}
							{@const lev = tradeSurface === 'perp' ? Number(perpLeverage) : 1}
							<span>Est. margin lock: {n > 0 ? (n / lev).toFixed(2) : '—'} USDT</span>
						{/if}
					</div>

					<button
						type="button"
						class="hl-submit"
						class:hl-submit-buy={tradeSide === 'buy'}
						class:hl-submit-sell={tradeSide === 'sell'}
						on:click={submitPanelOrder}
						disabled={!connectedWallet?.connected ||
							!tradeSize ||
							notionalFromSizeInput() <= 0 ||
							limitPriceMissingForSubmit}
					>
						{#if !connectedWallet?.connected}
							Connect wallet
						{:else if tradingTabUI === 'perps'}
							{@const mktPx = prices[selectedTab]?.price}
							{tradeSide === 'buy' ? 'Long' : 'Short'} {selectedTab} @ {mktPx > 0 ? '$' + mktPx.toFixed(4) : '…'}
						{:else if tradingTabUI === 'limit'}
							{@const limPx = parseFloat(String(limitPriceInput ?? ''))}
							{tradeSide === 'buy' ? 'Buy' : 'Sell'} {selectedTab} limit @ ${Number.isFinite(limPx) && limPx > 0 ? limPx.toFixed(4) : '…'}
						{:else}
							{@const mktPx = prices[selectedTab]?.price}
							{tradeSide === 'buy' ? 'Buy' : 'Sell'} {selectedTab} @ {mktPx > 0 ? '$' + mktPx.toFixed(4) : '…'}
						{/if}
					</button>
				</div>
			</div>
		</div>

		{#if connectedWallet?.connected && true}
			<div class="positions-strip">
				<div class="chart-positions-panel chart-dock-orders positions-strip-inner">
					<div class="chart-positions-header dock-orders-header">
						<div class="dock-tab-btns">
							<button
								type="button"
								class="dock-tab-btn"
								class:dock-tab-active={positionsDockTab === 'balance'}
								on:click={() => (positionsDockTab = 'balance')}
							>
								Balance
							</button>
							<button
								type="button"
								class="dock-tab-btn"
								class:dock-tab-active={positionsDockTab === 'orders'}
								on:click={() => (positionsDockTab = 'orders')}
							>
								Open Orders
							</button>
							{#if portfolioMarkUnrealizedPnlUsd !== 0}
								<span class="dock-upnl-pill" class:pnl-pos={portfolioMarkUnrealizedPnlUsd >= 0} class:pnl-neg={portfolioMarkUnrealizedPnlUsd < 0}>
									uPnL {portfolioMarkUnrealizedPnlUsd >= 0 ? '+' : ''}{portfolioMarkUnrealizedPnlUsd.toFixed(2)} USDT
								</span>
							{/if}
						</div>
						<div class="chart-positions-header-actions">
							{#if positionsDockTab === 'orders' && allDockOrders.length > 0}
								<button
									type="button"
									class="chart-positions-close-all"
									disabled={closeAllPositionsLoading ||
										!connectedWallet?.connected ||
										!fastTradingSessionActive}
									title={!fastTradingSessionActive
										? 'Fund a paper session first (same as single close).'
										: 'Close or cancel every open perp in the list'}
									on:click={closeAllOpenPositions}
								>
									{closeAllPositionsLoading ? 'Closing…' : 'Close all'}
								</button>
							{/if}
							<button
								type="button"
								class="chart-positions-refresh dock-refresh-hl"
								on:click={() => updateWalletStatus()}
							>
								↻ Refresh
							</button>
						</div>
					</div>

					{#if positionsDockTab === 'orders'}
						{#if allDockOrders.length === 0}
							<div class="chart-positions-empty">
								No open or pending paper positions. Submit a trade to see it here.
							</div>
						{:else}
							<div class="chart-positions-list">
							{#each allDockOrders as p}
								{@const isPerp = p.tradeMode === 'perp'}
								{@const sideLabel = isPerp
									? p.direction
									: p.direction === 'LONG'
										? 'BUY'
										: 'SELL'}
								{@const markPx   = prices[p.pairSymbol]?.price ?? 0}
								{@const entry     = p.entryPrice ?? 0}
								{@const notional  = p.notionalUsd ?? 0}
								{@const margin    = p.marginUsd ?? 0}
								{@const refPx =
									entry > 0
										? entry
										: p.status === 'PENDING' && p.limitPrice != null
											? p.limitPrice
											: 0}
								{@const sizeTokens = refPx > 0 ? notional / refPx : 0}
								{@const rawPnl    = p.status === 'ACTIVE' && markPx > 0 && entry > 0
									? (p.direction === 'LONG'
										? (markPx - entry) / entry * notional
										: (entry - markPx) / entry * notional)
									: null}
								{@const liqPx = p.liquidationPrice != null && p.liquidationPrice > 0 ? p.liquidationPrice : null}
								<div class="chart-position-row">
									<div class="cp-title">
										<span
											class="cp-side"
											class:cp-side-long={p.direction === 'LONG'}
											class:cp-side-short={p.direction === 'SHORT'}>{sideLabel}</span>
										<span class="cp-pair-main">{p.pairSymbol}/USDT</span>
										<span class="cp-ctx-soft">
											{isPerp ? 'Perp' : 'Spot'}
											{#if isPerp && p.leverage > 1}
												<span class="cp-lev-inline">{p.leverage}x</span>
											{/if}
											<span> · {p.orderType === 'limit' ? 'Limit' : 'Mkt'}</span>
											{#if p.status === 'PENDING'}
												<span class="cp-pend"> · Open order</span>
											{/if}
										</span>
									</div>

									<div class="cp-block cp-block-num">
										<span class="cp-block-label">Pos. size</span>
										<span class="cp-block-value">{sizeTokens.toFixed(4)} {p.pairSymbol}</span>
									</div>

									<div class="cp-block cp-block-num">
										<span class="cp-block-label">{p.status === 'PENDING' ? 'Limit' : 'Entry'}</span>
										<span class="cp-block-value"
											>${(p.status === 'PENDING' && p.limitPrice != null ? p.limitPrice : entry).toFixed(4)}</span>
									</div>

									<div class="cp-block cp-block-num">
										<span class="cp-block-label">Current</span>
										<span class="cp-block-value"
											>{markPx > 0 ? '$' + markPx.toFixed(4) : '—'}</span>
									</div>

									<div class="cp-block cp-block-num">
										<span class="cp-block-label">TP</span>
										<span class="cp-block-value"
											>{p.takeProfitPrice != null && p.takeProfitPrice > 0
												? '$' + p.takeProfitPrice.toFixed(2)
												: '—'}</span
										>
									</div>
									<div class="cp-block cp-block-num">
										<span class="cp-block-label">SL</span>
										<span class="cp-block-value"
											>{p.stopLossPrice != null && p.stopLossPrice > 0
												? '$' + p.stopLossPrice.toFixed(2)
												: '—'}</span
										>
									</div>

									<div class="cp-block cp-block-num cp-block-pnl">
										<span class="cp-block-label">uPnL</span>
										<div class="cp-pnl-stack">
											{#if p.status === 'ACTIVE' && rawPnl !== null}
												<span class="cp-pnl-val" class:pnl-pos={rawPnl >= 0} class:pnl-neg={rawPnl < 0}>
													{rawPnl >= 0 ? '+' : ''}{rawPnl.toFixed(2)}
												</span>
											{:else}
												<span class="cp-pnl-ph">—</span>
											{/if}
										</div>
									</div>

									<div class="cp-block cp-block-num">
										<span class="cp-block-label">{isPerp ? 'Margin' : 'Cost'}</span>
										<span class="cp-block-value">${margin.toFixed(2)}</span>
									</div>

									<div class="cp-block cp-block-num">
										<span class="cp-block-label">Liq. price</span>
										<span class="cp-block-value" class:cp-liq-val={liqPx !== null && isPerp}
											>{liqPx !== null && isPerp ? '$' + liqPx.toFixed(4) : '—'}</span>
									</div>

									<button
										type="button"
										class="cp-action"
										class:cp-action-cancel={p.status === 'PENDING'}
										on:click={() => closePosition(p.pubkey)}
									>
										{p.status === 'PENDING' ? 'Cancel' : 'Close'}
									</button>
								</div>
							{/each}
						</div>
					{/if}
				{/if}

				{#if positionsDockTab === 'balance'}
					{#if firstUnifiedBalance}
						{@const u = firstUnifiedBalance}
						<div class="balance-tab-content">
							<div class="bal-list">
								<div class="bal-card">
									<div class="cp-block">
										<span class="cp-block-label">Asset</span>
										<span class="cp-block-value bal-asset-name">USDT</span>
									</div>
									<div class="cp-block cp-block-num">
										<span class="cp-block-label">Balance</span>
										<span class="cp-block-value">{(u.availableUsd ?? u.tokenInBalance).toFixed(2)}</span>
										{#if usdtReservedBreakdown.perp > 0.001}
											<span class="bal-locked-inline">{usdtReservedBreakdown.perp.toFixed(2)} locked</span>
										{/if}
									</div>
									<div class="cp-block cp-block-num">
										<span class="cp-block-label">Price</span>
										<span class="cp-block-value bal-dim">—</span>
									</div>
									<div class="cp-block cp-block-num">
										<span class="cp-block-label">Value (USDT)</span>
										<span class="cp-block-value bal-green">{(u.availableUsd ?? u.tokenInBalance).toFixed(2)}</span>
									</div>
								</div>
								{#each heldTokens as [sym, idx]}
									{@const row = mockTokenBalances[idx]}
									{@const px = prices[sym]?.price ?? 0}
									{@const usdVal = row ? row.tokenOutBalance * px : 0}
									<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
									<div class="bal-card bal-card-clickable" class:bal-card-active={sym === selectedTab} on:click={() => switchTab(sym)}>
										<div class="cp-block">
											<span class="cp-block-label">Asset</span>
											<span class="cp-block-value bal-asset-name">{sym}</span>
										</div>
										<div class="cp-block cp-block-num">
											<span class="cp-block-label">Balance</span>
											<span class="cp-block-value">{row ? row.tokenOutBalance.toFixed(synthDecimals(sym)) : '—'}</span>
										</div>
										<div class="cp-block cp-block-num">
											<span class="cp-block-label">Price</span>
											<span class="cp-block-value">{px > 0 ? '$' + px.toFixed(2) : '—'}</span>
										</div>
										<div class="cp-block cp-block-num">
											<span class="cp-block-label">Value (USDT)</span>
											<span class="cp-block-value">{usdVal > 0 ? usdVal.toFixed(2) : '—'}</span>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{:else if Object.values(accountsInitialized).some(Boolean)}
						<p class="dock-hint">Loading account…</p>
					{:else}
						<p class="dock-hint">Initialize your paper account from the header to trade.</p>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
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
					<label class="session-sol-label" for="sessionSolBerg">
						SOL to fund session
						<span class="session-sol-hint">Min 0.01 · Recommended 0.05–0.2</span>
					</label>
					<div class="session-sol-row">
						<input
							id="sessionSolBerg"
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
				<button
					type="button"
					class="session-primary-btn"
					on:click={() => (showSessionActiveNotice = false)}
				>
					Got it
				</button>
			</div>
		</div>
	{/if}
</div>

<Toast />

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #000;
		color: #ff9500;
		font-family: 'Courier New', 'Lucida Console', monospace;
		overflow-x: hidden;
	}

	:global(html) {
		background: #000;
	}

	.bloomberg {
		background: #000;
		display: flex;
		flex-direction: column;
		overflow-x: hidden;
	}

	/* Used in chart stats (ticker strip lives in TerminalTopChrome) */
	.change-up {
		color: #00ff00;
		font-size: 12px;
	}

	.change-down {
		color: #ff0000;
		font-size: 12px;
	}

	.main-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px minmax(260px, 300px);
		grid-template-rows: minmax(min(78vh, 820px), auto) auto;
		gap: 0;
		background: #000;
		overflow: hidden;
		align-items: stretch;
	}

	.panel {
		background: #000;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.chart-panel {
		grid-column: 1;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		min-height: min(78vh, 820px);
		height: auto;
		overflow: hidden;
	}

	.orderbook-panel {
		grid-column: 2;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		background: #000;
		border-left: 1px solid #1a1a1a;
		border-right: 1px solid #1a1a1a;
		min-height: min(78vh, 820px);
		max-height: min(78vh, 820px);
		overflow: hidden;
	}

	.ob-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 10px;
		border-bottom: 1px solid #1a1a1a;
	}

	.ob-title {
		font-size: 11px;
		font-weight: bold;
		color: #eaecef;
	}

	.ob-precision-select {
		appearance: none;
		-moz-appearance: none;
		background-color: #1a1a1a;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23848e9c' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 6px center;
		border: 1px solid #333;
		color: #eaecef;
		font-size: 10px;
		padding: 4px 22px 4px 8px;
		border-radius: 4px;
		font-family: inherit;
		cursor: pointer;
	}

	.ob-precision-select:focus,
	.ob-precision-select:focus-visible {
		outline: none;
		border-color: #ff9500;
		box-shadow: 0 0 0 1px #ff9500;
	}

	.ob-tabs {
		display: flex;
		border-bottom: 1px solid #1a1a1a;
	}

	.ob-tab {
		flex: 1;
		background: transparent;
		border: none;
		color: #848e9c;
		font-size: 10px;
		padding: 8px 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.ob-tab.active {
		color: #ff9500;
		border-bottom: 2px solid #ff9500;
	}

	.ob-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		font-size: 10px;
	}

	.ob-col-hdr {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		padding: 4px 8px;
		color: #848e9c;
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}

	.ob-hdr-mid {
		text-align: center;
	}

	.ob-hdr-end {
		text-align: right;
	}

	.ob-scroll {
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.ob-row {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		padding: 1px 8px;
		font-family: 'Courier New', monospace;
		align-items: center;
	}

	.ob-row .ob-p,
	.ob-row .ob-s,
	.ob-row .ob-t {
		position: relative;
		z-index: 1;
	}

	/* Full-row depth: strong under the proportional width, faint tint across the rest (no empty black). */
	.ob-ask-row {
		background: linear-gradient(
			90deg,
			rgba(246, 70, 93, 0.14) 0%,
			rgba(246, 70, 93, 0.07) min(var(--ob-depth-pct, 0%), 100%),
			rgba(246, 70, 93, 0.038) 100%
		);
	}

	.ob-bid-row {
		background: linear-gradient(
			90deg,
			rgba(0, 255, 0, 0.12) 0%,
			rgba(0, 255, 0, 0.065) min(var(--ob-depth-pct, 0%), 100%),
			rgba(0, 255, 0, 0.034) 100%
		);
	}

	.ob-ask-p {
		color: #f6465d;
	}

	.ob-bid-p {
		color: #00ff00;
	}

	.ob-s {
		text-align: center;
		color: #eaecef;
	}

	.ob-t {
		text-align: right;
		color: #848e9c;
	}

	.ob-spread-row {
		text-align: center;
		padding: 4px 4px 0;
		line-height: 1.2;
		color: #848e9c;
		font-size: 9px;
		border-top: 1px solid #1a1a1a;
		border-bottom: 1px solid #1a1a1a;
	}

	.ob-asks-wrap > .ob-row:last-child {
		padding-bottom: 0;
	}

	.ob-bids-wrap > .ob-row:first-child {
		padding-top: 0;
	}

	.ob-spread-pct {
		margin-left: 6px;
		color: #5e6673;
	}

	.ob-trades-scroll {
		padding-bottom: 8px;
	}

	.ob-trade-line {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		padding: 3px 8px;
		font-family: 'Courier New', monospace;
	}

	.ob-trade-line.trade-buy span:first-child {
		color: #0ecb81;
	}

	.ob-trade-line.trade-sell span:first-child {
		color: #f6465d;
	}

	.trade-column-panel {
		grid-column: 3;
		grid-row: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-height: min(78vh, 820px);
		max-height: min(78vh, 820px);
		background: #000;
	}

	.positions-strip {
		grid-column: 1 / -1;
		grid-row: 2;
		flex-shrink: 0;
		border-top: 1px solid #1a1a1a;
		background: #000;
		max-height: min(220px, 32vh);
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.positions-strip-inner {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.trading-panel-hl {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: 10px 12px 12px;
		border-top: 1px solid #1a1a1a;
		box-sizing: border-box;
	}

	.hl-trading-form-scroll {
		flex: 1;
		min-height: 0;
		overflow-x: hidden;
		overflow-y: auto;
		padding-bottom: 8px;
	}

	.hl-trading-footer {
		flex-shrink: 0;
		margin-top: auto;
		padding-top: 10px;
		border-top: 1px solid #1a1a1a;
	}

	.hl-trading-footer .hl-summary {
		margin-bottom: 8px;
	}

	.hl-trading-footer .hl-submit {
		margin-bottom: 0;
	}

	/* HL panels: kill browser blue (focus rings, color-scheme, native controls) */
	.chart-dock,
	.positions-strip,
	.trade-column-panel,
	.orderbook-panel {
		color-scheme: dark;
		--hl-accent: #ff9500;
		--hl-bg: #000;
		--hl-surface: #1a1a1a;
		--hl-border: #333;
		--hl-text: #eaecef;
		--hl-muted: #848e9c;
	}

	.chart-dock :focus-visible,
	.positions-strip :focus-visible,
	.trade-column-panel :focus-visible,
	.orderbook-panel :focus-visible {
		outline: 2px solid var(--hl-accent);
		outline-offset: 2px;
	}

	.chart-dock :focus:not(:focus-visible),
	.positions-strip :focus:not(:focus-visible),
	.trade-column-panel :focus:not(:focus-visible),
	.orderbook-panel :focus:not(:focus-visible) {
		outline: none;
	}

	.chart-dock button,
	.chart-dock select,
	.chart-dock input,
	.positions-strip button,
	.trade-column-panel button,
	.trade-column-panel select,
	.trade-column-panel input,
	.orderbook-panel button {
		-webkit-tap-highlight-color: transparent;
	}

	.trade-column-panel select {
		appearance: none;
		-moz-appearance: none;
	}

	.chart-dock input:-webkit-autofill,
	.trade-column-panel input:-webkit-autofill {
		-webkit-box-shadow: 0 0 0 40px var(--hl-surface) inset;
		-webkit-text-fill-color: var(--hl-text);
		caret-color: var(--hl-text);
	}

	.chart-dock {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-top: 1px solid #1a1a1a;
		max-height: min(340px, 38vh);
		min-height: 0;
		overflow: hidden;
		background: #000;
	}

	.chart-dock-balances {
		flex-shrink: 0;
		padding: 6px 6px 8px;
		border-bottom: 1px solid #1a1a1a;
	}

	.dock-header-hl {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 8px;
	}

	.dock-header-main {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 10px 14px;
		min-width: 0;
	}

	.dock-mark-upnl {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		white-space: nowrap;
	}

	.dock-mark-upnl-lbl {
		font-size: 9px;
		font-weight: 700;
		color: #ff9500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.dock-mark-upnl-val {
		font-size: 11px;
		font-weight: 700;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		font-variant-numeric: tabular-nums;
	}

	.dock-title {
		font-size: 10px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 0.4px;
	}

	.dock-refresh-hl {
		background: transparent;
		border: 1px solid #333;
		color: #ff9500;
		font-size: 9px;
		padding: 4px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.dock-refresh-hl:hover {
		border-color: #ff9500;
		color: #ffb733;
	}

	.dock-usdt-strip {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 2.1fr) minmax(0, 1fr);
		width: 100%;
		margin-bottom: 6px;
		border: 1px solid #252525;
		border-radius: 3px;
		overflow-x: hidden;
		overflow-y: hidden;
		background: #0a0a0a;
	}

	.dock-usdt-strip .dock-stat {
		padding: 7px 10px 8px;
		border-right: 1px solid #252525;
		min-width: 0;
	}

	.dock-usdt-strip .dock-stat:last-child {
		border-right: none;
	}

	.dock-usdt-strip:has(> .dock-stat:only-child) {
		grid-template-columns: 1fr;
	}

	.dock-stat {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.dock-usdt-strip .dock-stat.dock-stat--strip {
		flex-direction: row;
		flex-wrap: nowrap;
		align-items: baseline;
		gap: 6px 10px;
		min-width: max-content;
	}

	.dock-usdt-strip .dock-stat-lbl {
		color: #ff9500;
		font-weight: 700;
		font-size: 9px;
		letter-spacing: 0.06em;
	}

	.dock-stat-lbl {
		font-size: 8px;
		color: #6b7280;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		line-height: 1.2;
	}

	.dock-stat-val {
		font-size: 12px;
		font-weight: 600;
		color: #f0f2f5;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		font-variant-numeric: tabular-nums;
		line-height: 1.25;
	}

	.dock-assets-grid {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 4px;
	}

	.dock-asset-cell {
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 4px;
		padding: 6px 4px;
		text-align: center;
	}

	.dock-asset-active {
		border-color: #ff9500;
		box-shadow: 0 0 0 1px rgba(255, 149, 0, 0.2);
	}

	.dock-asset-sym {
		display: block;
		font-size: 9px;
		color: #848e9c;
		margin-bottom: 4px;
	}

	.dock-asset-amt {
		font-size: 10px;
		color: #eaecef;
		font-family: 'Courier New', monospace;
	}

	.dock-hint {
		margin: 0;
		font-size: 10px;
		color: #848e9c;
	}

	.chart-dock-orders {
		border-top: none;
		background: #050505;
	}

	.dock-orders-header {
		color: #ff9500 !important;
	}

	.cp-pair {
		font-size: 10px;
		font-weight: bold;
		color: #ff9500;
	}

	.hl-order-tabs {
		display: flex;
		gap: 4px;
		margin-bottom: 8px;
	}

	.hl-ot {
		flex: 1;
		background: #1a1a1a;
		border: 1px solid #333;
		color: #848e9c;
		padding: 8px 4px;
		font-size: 10px;
		cursor: pointer;
		border-radius: 4px;
		font-family: inherit;
	}

	.hl-ot.active {
		color: #000;
		background: #ff9500;
		border-color: #ff9500;
		font-weight: bold;
	}

	.hl-ot-pro {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
	}

	.hl-chev {
		font-size: 9px;
		opacity: 0.85;
	}

	.hl-pro-sub {
		display: flex;
		gap: 4px;
		margin-bottom: 10px;
	}

	.hl-ot-sm {
		font-size: 9px;
		padding: 6px 4px;
	}


	.hl-buy-sell {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
		margin-bottom: 10px;
	}

	.hl-bs {
		padding: 12px 8px;
		font-size: 13px;
		font-weight: bold;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-family: inherit;
		transition: background 0.15s ease, color 0.15s ease;
	}

	.hl-bs-buy {
		background: #1a1a1a;
		color: #5e6673;
	}

	.hl-bs-buy.active {
		background: #333;
		color: #00ff00;
		box-shadow: inset 0 0 0 1px #00ff00;
	}

	.hl-bs-sell {
		background: #1a1a1a;
		color: #5e6673;
	}

	.hl-bs-sell.active {
		background: #333;
		color: #f6465d;
		box-shadow: inset 0 0 0 1px #f6465d;
	}

	.hl-surface-row {
		display: flex;
		gap: 6px;
		margin-bottom: 10px;
	}

	.hl-sf {
		flex: 1;
		padding: 6px;
		font-size: 10px;
		background: #1a1a1a;
		border: 1px solid #333;
		color: #848e9c;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}

	.hl-sf.active {
		border-color: #ff9500;
		color: #ff9500;
	}

	.hl-available {
		font-size: 10px;
		color: #848e9c;
		margin: 0 0 10px;
	}

	.hl-available strong {
		color: #eaecef;
	}

	.hl-size-block {
		margin-bottom: 12px;
	}

	.hl-label {
		display: block;
		font-size: 10px;
		color: #848e9c;
		margin-bottom: 4px;
	}

	.hl-size-input-row {
		display: flex;
		gap: 6px;
		align-items: stretch;
	}

	.hl-input {
		background: #1a1a1a;
		border: 1px solid #333;
		color: #eaecef;
		padding: 10px 10px;
		border-radius: 4px;
		font-size: 12px;
		font-family: 'Courier New', monospace;
	}

	.hl-input:focus,
	.hl-input:focus-visible {
		outline: none;
		border-color: #ff9500;
		box-shadow: 0 0 0 1px #ff9500;
	}

	.hl-size-input-row .hl-input {
		flex: 1;
		min-width: 0;
	}

	.hl-unit-select {
		background-color: #1a1a1a;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23848e9c' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 8px center;
		border: 1px solid #333;
		color: #eaecef;
		padding: 0 22px 0 8px;
		border-radius: 4px;
		font-size: 10px;
		font-family: inherit;
		cursor: pointer;
		max-width: 96px;
	}

	select.hl-input.hl-select-full {
		appearance: none;
		-moz-appearance: none;
		background-color: #1a1a1a;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23848e9c' d='M0 0h10L5 6z'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 10px center;
		padding-right: 28px;
	}

	.hl-unit-select:focus,
	.hl-unit-select:focus-visible,
	.hl-select-full:focus,
	.hl-select-full:focus-visible {
		outline: none;
		border-color: #ff9500;
		box-shadow: 0 0 0 1px #ff9500;
	}

	.hl-pct-row {
		display: flex;
		gap: 6px;
		margin-bottom: 14px;
	}

	.hl-pct-btn {
		flex: 1;
		padding: 5px 0;
		background: #1a1a1a;
		border: 1px solid #2a2a2a;
		border-radius: 4px;
		color: #8a8f9a;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.12s, color 0.12s, border-color 0.12s;
		letter-spacing: 0.02em;
	}

	.hl-pct-btn:hover {
		background: #222;
		border-color: #444;
		color: #ccc;
	}

	.hl-pct-btn.hl-pct-active {
		background: rgba(255, 149, 0, 0.12);
		border-color: #ff9500;
		color: #ff9500;
	}

	.hl-pct-max {
		font-weight: 700;
		letter-spacing: 0.03em;
	}

	.hl-field {
		margin-bottom: 10px;
	}

	.hl-field-limit-priority {
		margin-top: 2px;
		margin-bottom: 12px;
	}

	.hl-limit-hint {
		margin: 6px 0 0;
		font-size: 10px;
		color: #7a818c;
		line-height: 1.35;
	}

	.hl-input-full,
	.hl-select-full {
		width: 100%;
		box-sizing: border-box;
	}

	.hl-summary {
		font-size: 9px;
		color: #5e6673;
		margin-bottom: 10px;
		min-height: 14px;
	}

	.hl-submit {
		width: 100%;
		padding: 14px 12px;
		font-size: 13px;
		font-weight: bold;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-family: inherit;
		margin-bottom: 12px;
		transition: opacity 0.15s ease;
	}

	.hl-submit:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.hl-submit-buy:not(:disabled) {
		background: #1a1a1a;
		color: #00ff00;
		box-shadow: inset 0 0 0 2px #00ff00;
	}

	.hl-submit-sell:not(:disabled) {
		background: #1a1a1a;
		color: #f6465d;
		box-shadow: inset 0 0 0 2px #f6465d;
	}

	.hl-orders-mini {
		border-top: 1px solid #1a1a1a;
		padding-top: 10px;
	}

	.hl-orders-title {
		font-size: 9px;
		color: #848e9c;
		text-transform: uppercase;
		margin-bottom: 6px;
		letter-spacing: 0.5px;
	}

	.hl-order-line {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 9px;
		color: #eaecef;
		padding: 4px 0;
		border-bottom: 1px solid #1a1a1a;
	}

	.hl-order-x {
		background: transparent;
		border: 1px solid #333;
		color: #ff9500;
		font-size: 9px;
		padding: 2px 8px;
		border-radius: 3px;
		cursor: pointer;
		font-family: inherit;
	}

	.panel-header {
		background: #1a1a1a;
		color: #ff9500;
		padding: 8px 12px;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 1px;
		border-bottom: 1px solid #333;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.chart-container {
		background: #0a0a0a;
		flex: 1;
		min-height: min(52vh, 560px);
		width: 100%;
	}

	.chart-positions-panel {
		border-top: 1px solid #333;
		background: #050505;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		padding: 6px 8px 8px;
	}

	.chart-positions-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: #ff9500;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 0.5px;
		flex-shrink: 0;
		padding: 0 0 0 0;
		border-bottom: 1px solid #1a1a1a;
	}

	.dock-tab-btns {
		display: flex;
		align-items: stretch;
		gap: 0;
		flex-shrink: 0;
	}

	.dock-tab-btn {
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: #6b7280;
		font-size: 11px;
		font-weight: 600;
		padding: 8px 14px;
		cursor: pointer;
		font-family: inherit;
		letter-spacing: 0.3px;
		transition: color 0.15s, border-color 0.15s;
	}

	.dock-tab-btn:hover {
		color: #d1d5db;
	}

	.dock-tab-active {
		color: #ff9500 !important;
		border-bottom-color: #ff9500;
	}

	.dock-upnl-pill {
		align-self: center;
		margin-left: 8px;
		font-size: 11px;
		font-weight: 700;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		font-variant-numeric: tabular-nums;
		padding: 2px 8px;
		border-radius: 3px;
		border: 1px solid currentColor;
		opacity: 0.9;
	}

	.balance-tab-content {
		overflow-y: auto;
		overflow-x: hidden;
		flex: 1;
		min-height: 0;
	}

	.bal-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.bal-card {
		display: grid;
		grid-template-columns: minmax(80px, 1fr) minmax(80px, 1.2fr) minmax(80px, 1.2fr) minmax(80px, 1.2fr);
		gap: 4px 8px;
		align-items: center;
		font-size: 11px;
		padding: 4px 8px;
		background: #101010;
		border: 1px solid #262626;
		border-radius: 3px;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		line-height: 1.2;
	}

	.bal-card-clickable {
		cursor: pointer;
		transition: background 0.1s, border-color 0.1s;
	}

	.bal-card-clickable:hover {
		background: #181818;
		border-color: #3a3a3a;
	}

	.bal-card-active {
		border-left: 2px solid #ff9500;
		background: #110e00;
	}

	.bal-card-active .bal-asset-name {
		color: #ff9500;
	}

	.bal-asset-name {
		font-size: 12px;
		font-weight: 600;
		color: #e6e8ea;
		letter-spacing: 0.04em;
		line-height: 1.15;
	}

	.bal-green {
		color: #2ebd85 !important;
	}

	.bal-dim {
		color: #555 !important;
	}

	.bal-locked-inline {
		font-size: 9px;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		font-variant-numeric: tabular-nums;
		color: #f59e0b;
		line-height: 1.15;
	}

	.chart-positions-header-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.chart-positions-close-all {
		background: transparent;
		border: 1px solid #663c14;
		color: #ff9500;
		font-size: 10px;
		padding: 2px 8px;
		cursor: pointer;
		font-family: 'Courier New', monospace;
		border-radius: 3px;
	}

	.chart-positions-close-all:hover:not(:disabled) {
		border-color: #ff9500;
		color: #fff;
	}

	.chart-positions-close-all:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.positions-strip .chart-positions-panel {
		border-top: none;
		padding: 6px 10px 8px;
		flex: 1;
		min-height: 0;
	}

	.chart-positions-refresh {
		background: transparent;
		border: 1px solid #444;
		color: #888;
		font-size: 10px;
		padding: 2px 8px;
		cursor: pointer;
		font-family: 'Courier New', monospace;
		border-radius: 3px;
	}

	.chart-positions-refresh:hover {
		border-color: #ff9500;
		color: #ff9500;
	}

	.chart-positions-empty {
		color: #555;
		font-size: 10px;
		padding: 6px 0;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.chart-positions-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.chart-position-row {
		display: grid;
		grid-template-columns:
			minmax(108px, 1.2fr) minmax(64px, 0.88fr) minmax(46px, 0.6fr) minmax(46px, 0.6fr) minmax(40px, 0.48fr)
			minmax(40px, 0.48fr) minmax(68px, 0.82fr) minmax(44px, 0.56fr) minmax(46px, 0.62fr) auto;
		gap: 4px 8px;
		align-items: center;
		font-size: 11px;
		padding: 4px 8px;
		background: #101010;
		border: 1px solid #262626;
		border-radius: 3px;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		min-width: 700px;
		line-height: 1.2;
	}

	.cp-liq-val {
		color: #f59e0b;
	}

	.cp-title {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-width: 0;
	}

	.cp-side {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		line-height: 1.15;
	}

	.cp-side-long {
		color: #2ebd85;
	}

	.cp-side-short {
		color: #f14f6b;
	}

	.cp-pair-main {
		font-size: 12px;
		font-weight: 600;
		color: #e6e8ea;
		line-height: 1.15;
	}

	.cp-ctx-soft {
		font-size: 11px;
		color: #ffb14a;
		line-height: 1.2;
		font-weight: 500;
	}

	.cp-lev-inline {
		color: #ffb14a;
		font-size: 11px;
		font-weight: 600;
	}

	.cp-pend {
		color: #ffb14a;
		font-size: 11px;
		font-weight: 600;
	}

	.cp-block {
		display: flex;
		flex-direction: column;
		gap: 0;
		justify-content: center;
		min-width: 0;
	}

	.cp-block-num {
		text-align: right;
	}

	.cp-block-num .cp-block-label {
		text-align: right;
	}

	.cp-block-label {
		font-size: 11px;
		font-weight: 700;
		color: #ff9500;
		letter-spacing: 0.04em;
		line-height: 1.15;
	}

	.cp-block-value {
		font-size: 12px;
		color: #e6e8ea;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.cp-block-pnl .cp-block-label {
		text-align: right;
	}

	.cp-pnl-stack {
		min-height: 18px;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		justify-content: center;
		gap: 0;
	}

	.cp-pnl-val {
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.cp-pnl-ph {
		font-size: 12px;
		color: #3f3f46;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.pnl-pos {
		color: #0ecb81;
	}

	.pnl-neg {
		color: #f6465d;
	}

	.cp-action {
		margin-left: auto;
		align-self: center;
		background: #2a2a2a;
		border: 1px solid #555;
		color: #ff9500;
		padding: 3px 10px;
		font-size: 10px;
		cursor: pointer;
		font-family: ui-monospace, 'Cascadia Code', 'Courier New', monospace;
		border-radius: 3px;
		white-space: nowrap;
		line-height: 1.2;
	}

	.cp-action:hover {
		background: #ff9500;
		color: #000;
		border-color: #ff9500;
	}

	.cp-action.cp-action-cancel {
		color: #848e9c;
		border-color: #444;
	}

	.cp-action.cp-action-cancel:hover {
		background: #3a1a1a;
		color: #f6465d;
		border-color: #f6465d;
	}

	.balance-amounts-stacked {
		width: 100%;
	}

	.token-balance-secondary .token-label,
	.token-balance-secondary .token-amount {
		font-size: 10px;
		font-weight: normal;
		color: #888;
	}

	.token-balance-secondary .token-amount {
		color: #aaa;
	}

	.trading-panel-below {
		background: #000;
		padding: 15px;
		border-top: 1px solid #333;
		display: flex;
		flex-direction: column;
		gap: 15px;
		min-height: 200px;
	}

	/* Balance Display */
	.balance-display {
		display: flex;
		gap: 20px;
		padding: 8px 12px;
		background: #0a0a0a;
		border: 1px solid #333;
		border-radius: 4px;
	}

	.balance-item {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
	}

	.balance-label {
		color: #666;
		font-weight: bold;
		letter-spacing: 0.5px;
	}

	.balance-value {
		color: #ff9500;
		font-family: 'Courier New', monospace;
		font-weight: bold;
		min-width: 80px;
		text-align: right;
	}

	/* Trading Panel Right */
	.trading-panel-right {
		border-top: 1px solid #333;
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow-x: hidden;
		overflow-y: hidden;
	}

	.trading-panel-right .panel-subheader {
		padding: 8px 12px;
		flex-shrink: 0;
	}

	/* Trading Form Header with Back Button */
	.trading-form-header {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.back-btn {
		background: none;
		border: 1px solid #444;
		color: #ff9500;
		width: 28px;
		height: 28px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s ease;
		flex-shrink: 0;
	}

	.back-btn:hover {
		background: #222;
		border-color: #ff9500;
	}

	.back-arrow {
		font-size: 16px;
		font-weight: bold;
	}

	.form-title {
		flex: 1;
		font-weight: bold;
		letter-spacing: 1px;
	}

	.form-title.buy-title {
		color: #00ff00;
	}

	.form-title.sell-title {
		color: #ff4444;
	}

	.form-price {
		color: #fff;
		font-family: 'Courier New', monospace;
		font-size: 11px;
	}

	.trading-form-content {
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		overflow-x: hidden;
		overflow-y: auto;
		flex: 1;
	}

	/* Trading Sections */
	.trading-sections {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		overflow-x: hidden;
		overflow-y: auto;
		flex: 1;
	}

	.trading-quick-stats {
		background: #0a0a0a;
		border: 1px solid #333;
		border-radius: 6px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: auto;
	}

	.quick-stat {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 4px 0;
		border-bottom: 1px solid #222;
	}

	.quick-stat:last-child {
		border-bottom: none;
	}

	.quick-stat .stat-label {
		color: #666;
		font-size: 11px;
	}

	.quick-stat .stat-value {
		color: #fff;
		font-size: 11px;
		font-family: 'Courier New', monospace;
	}

	.quick-stat .stat-value-up {
		color: #00ff00;
		font-size: 11px;
		font-family: 'Courier New', monospace;
	}

	.quick-stat .stat-value-down {
		color: #ff4444;
		font-size: 11px;
		font-family: 'Courier New', monospace;
	}

	.trading-section {
		background: #0a0a0a;
		border: 1px solid #333;
		border-radius: 6px;
		padding: 12px;
		transition: all 0.3s ease;
	}

	.trading-section:hover {
		border-color: #666;
		transform: translateY(-1px);
	}

	.buy-section {
		border-left: 3px solid #00ff00;
	}

	.sell-section {
		border-left: 3px solid #ff4444;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12px;
		padding-bottom: 8px;
		border-bottom: 1px solid #333;
	}

	.section-title {
		color: #ff9500;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 1px;
	}

	.section-price {
		color: #fff;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		font-weight: bold;
	}

	.section-buttons {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}

	.action-btn {
		background: linear-gradient(145deg, #1a1a1a, #0a0a0a);
		border: 1px solid #333;
		color: #fff;
		padding: 12px;
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.2s ease;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		font-family: 'Courier New', monospace;
		font-weight: bold;
		font-size: 11px;
		letter-spacing: 1px;
		position: relative;
		overflow: hidden;
	}

	.action-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	}

	.action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
		transform: none !important;
	}

	.action-btn.active {
		box-shadow: 0 0 15px rgba(255, 149, 0, 0.4);
		border-color: #ff9500;
	}

	.buy-btn {
		border-color: #0ecb81;
		color: #0ecb81;
	}

	.buy-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #0ecb81, #0aa06e);
		color: #04110b;
		border-color: #0ecb81;
	}

	.buy-btn.active {
		background: rgba(14, 203, 129, 0.12);
		box-shadow: 0 0 0 1px rgba(14, 203, 129, 0.22);
		border-color: #0ecb81;
	}

	.sell-btn {
		border-color: #f6465d;
		color: #f6465d;
	}

	.sell-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #f6465d, #d63c52);
		color: #fff;
		border-color: #f6465d;
	}

	.sell-btn.active {
		background: rgba(246, 70, 93, 0.12);
		box-shadow: 0 0 0 1px rgba(246, 70, 93, 0.22);
		border-color: #f6465d;
	}

	.long-btn {
		border-color: #0ecb81;
		color: #0ecb81;
	}

	.long-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #0ecb81, #0aa06e);
		color: #04110b;
		border-color: #0ecb81;
	}

	.long-btn.active {
		background: rgba(14, 203, 129, 0.12);
		box-shadow: 0 0 0 1px rgba(14, 203, 129, 0.22);
		border-color: #0ecb81;
	}

	.short-btn {
		border-color: #f6465d;
		color: #f6465d;
	}

	.short-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #f6465d, #d63c52);
		color: #fff;
		border-color: #f6465d;
	}

	.short-btn.active {
		background: rgba(246, 70, 93, 0.12);
		box-shadow: 0 0 0 1px rgba(246, 70, 93, 0.22);
		border-color: #f6465d;
	}

	.btn-text {
		font-size: 11px;
		letter-spacing: 1px;
		font-weight: bold;
	}

	/* Trading Controls Panel */
	.trading-controls-panel {
		background: #0a0a0a;
		border: 1px solid #333;
		border-radius: 6px;
		padding: 15px;
		margin-top: 10px;
		animation: slideDown 0.3s ease;
		overflow: hidden;
	}

	@keyframes slideDown {
		from {
			max-height: 0;
			opacity: 0;
			transform: translateY(-10px);
		}
		to {
			max-height: 600px;
			opacity: 1;
			transform: translateY(0);
		}
	}

	.controls-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 15px;
		padding-bottom: 10px;
		border-bottom: 1px solid #333;
	}

	.controls-title {
		color: #ff9500;
		font-size: 13px;
		font-weight: bold;
		letter-spacing: 1px;
	}

	.close-panel-btn {
		background: #333;
		border: none;
		color: #fff;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		transition: all 0.2s ease;
	}

	.close-panel-btn:hover {
		background: #ff4444;
		transform: scale(1.1);
	}


	.exec-mode-toggle {
		display: flex;
		gap: 2px;
		background: #1a1a1a;
		border-radius: 4px;
		padding: 2px;
		margin-bottom: 10px;
	}

	.paper-orders-strip {
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid #333;
		font-size: 11px;
	}

	.paper-orders-title {
		color: #888;
		margin-bottom: 6px;
		font-size: 10px;
		letter-spacing: 1px;
	}

	.paper-order-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 0;
		border-bottom: 1px solid #222;
		flex-wrap: wrap;
	}

	.paper-order-meta {
		color: #ccc;
		font-family: 'Courier New', monospace;
		font-size: 10px;
	}

	.paper-order-price {
		color: #ff9500;
		font-family: 'Courier New', monospace;
		font-size: 10px;
	}

	.paper-order-action {
		background: #2a2a2a;
		border: 1px solid #555;
		color: #ff9500;
		padding: 4px 10px;
		border-radius: 3px;
		font-size: 10px;
		cursor: pointer;
		font-family: 'Courier New', monospace;
	}

	.paper-order-action:hover {
		background: #ff9500;
		color: #000;
		border-color: #ff9500;
	}

	.trading-select {
		cursor: pointer;
		width: 100%;
	}

	/* Trading Mode Toggle */
	.trading-mode-toggle {
		display: flex;
		gap: 2px;
		background: #1a1a1a;
		border-radius: 4px;
		padding: 2px;
		margin-bottom: 15px;
	}

	.mode-toggle-btn {
		flex: 1;
		background: transparent;
		border: none;
		color: #666;
		padding: 8px 16px;
		font-family: 'Courier New', monospace;
		font-size: 10px;
		font-weight: bold;
		cursor: pointer;
		transition: all 0.2s ease;
		border-radius: 2px;
		letter-spacing: 1px;
	}

	.mode-toggle-btn.active {
		background: #ff9500;
		color: #000;
	}

	.mode-toggle-btn:hover:not(.active) {
		background: #333;
		color: #fff;
	}

	/* Advanced Percentage Controls */
	.percentage-controls-advanced {
		margin-bottom: 15px;
		padding: 12px;
		background: #1a1a1a;
		border-radius: 4px;
		border: 1px solid #333;
	}

	.percentage-label {
		color: #ff9500;
		font-size: 10px;
		font-weight: bold;
		letter-spacing: 1px;
		margin-bottom: 8px;
	}

	.percentage-buttons-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
	}

	.percentage-btn-advanced {
		background: #0a0a0a;
		border: 1px solid #333;
		color: #666;
		padding: 8px;
		border-radius: 3px;
		cursor: pointer;
		transition: all 0.2s ease;
		font-family: 'Courier New', monospace;
		font-size: 10px;
		font-weight: bold;
		letter-spacing: 0.5px;
	}

	.percentage-btn-advanced:hover {
		background: #333;
		color: #fff;
		border-color: #666;
		transform: translateY(-1px);
	}

	.percentage-btn-advanced.active {
		background: #ff9500;
		color: #000;
		border-color: #ff9500;
		box-shadow: 0 0 8px rgba(255, 149, 0, 0.4);
	}

	/* Input Controls */
	.input-controls-grid {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 15px;
	}

	.input-control {
		position: relative;
	}

	.input-label {
		display: block;
		color: #ff9500;
		font-size: 9px;
		font-weight: bold;
		letter-spacing: 1px;
		margin-bottom: 5px;
	}

	.trading-input {
		width: 100%;
		background: #000;
		border: 1px solid #333;
		color: #fff;
		padding: 10px 35px 10px 10px;
		font-family: 'Courier New', monospace;
		font-size: 12px;
		border-radius: 3px;
		transition: all 0.2s ease;
		outline: none;
	}

	.trading-input:focus {
		border-color: #ff9500;
		box-shadow: 0 0 5px rgba(255, 149, 0, 0.3);
	}

	.input-suffix {
		position: absolute;
		right: 8px;
		top: 50%;
		transform: translateY(-50%);
		color: #666;
		font-size: 10px;
		font-weight: bold;
		pointer-events: none;
		margin-top: 10px;
	}

	/* Execute Section */
	.execute-section {
		margin-top: 15px;
	}

	.trade-summary {
		background: #1a1a1a;
		border: 1px solid #333;
		border-radius: 4px;
		padding: 10px;
		margin-bottom: 12px;
	}

	.summary-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 6px;
		font-size: 10px;
		color: #666;
	}

	.summary-row:last-child {
		margin-bottom: 0;
	}

	.summary-value {
		color: #fff;
		font-family: 'Courier New', monospace;
		font-weight: bold;
	}

	.execute-btn {
		width: 100%;
		padding: 12px;
		border: none;
		border-radius: 4px;
		font-family: 'Courier New', monospace;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 1px;
		cursor: pointer;
		transition: all 0.2s ease;
		text-transform: uppercase;
	}

	.execute-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
		transform: none !important;
	}

	.execute-btn.buy-execute {
		background: linear-gradient(145deg, #00ff00, #00cc00);
		color: #000;
		border: 2px solid #00ff00;
	}

	.execute-btn.buy-execute:hover:not(:disabled) {
		background: linear-gradient(145deg, #00cc00, #009900);
		transform: translateY(-2px);
		box-shadow: 0 4px 15px rgba(0, 255, 0, 0.4);
	}

	.execute-btn.sell-execute {
		background: linear-gradient(145deg, #ff4444, #cc3333);
		color: #fff;
		border: 2px solid #ff4444;
	}

	.execute-btn.sell-execute:hover:not(:disabled) {
		background: linear-gradient(145deg, #cc3333, #990000);
		transform: translateY(-2px);
		box-shadow: 0 4px 15px rgba(255, 68, 68, 0.4);
	}


	.chart-header-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.chart-title {
		color: #ff9500;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 1px;
	}

	.chart-view-toggle {
		display: flex;
		gap: 2px;
		background: #111;
		border: 1px solid #222;
		border-radius: 4px;
		padding: 2px;
	}

	.cv-btn {
		padding: 2px 8px;
		background: transparent;
		border: none;
		border-radius: 3px;
		color: #5e6673;
		font-size: 10px;
		font-weight: 600;
		cursor: pointer;
		letter-spacing: 0.03em;
		transition: background 0.1s, color 0.1s;
	}

	.cv-btn:hover {
		color: #ccc;
	}

	.cv-btn.cv-active {
		background: #222;
		color: #ff9500;
	}

	.chart-stats {
		margin-left: auto;
		display: flex;
		gap: 12px;
		align-items: center;
	}

	.stat-box {
		display: flex;
		align-items: baseline;
		gap: 4px;
		background: #0a0a0a;
		padding: 2px 6px;
		border: 1px solid #333;
		font-size: 9px;
	}

	.stat-label {
		color: #666;
		font-size: 8px;
		font-weight: bold;
		letter-spacing: 0.5px;
	}

	.stat-value {
		font-size: 9px;
		font-weight: bold;
		font-family: 'Courier New', monospace;
		display: flex;
		align-items: center;
		gap: 3px;
	}

	.price-value {
		color: #fff;
	}

	.ema-value {
		color: #fff;
	}

	.conf-value {
		color: #ffaa00;
	}

	.fresh-value {
		color: #00ff00;
	}

	.positions-panel {
		background: #000;
		border-top: 1px solid #333;
		padding: 8px;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.positions-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		color: #ff9500;
		font-size: 10px;
		font-weight: bold;
		letter-spacing: 1px;
		margin-bottom: 8px;
		padding: 4px 0;
	}

	.refresh-positions-btn {
		background: none;
		border: 1px solid #ff9500;
		color: #ff9500;
		padding: 4px 8px;
		border-radius: 3px;
		cursor: pointer;
		font-size: 1.2em;
		transition: all 0.2s;
	}

	.refresh-positions-btn:hover {
		background: #ff9500;
		color: #000;
		transform: rotate(180deg);
	}

	.position-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px;
		border: 1px solid #333;
		margin-bottom: 6px;
		font-size: 11px;
		background: #0a0a0a;
	}

	.position-info {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.position-direction {
		font-weight: bold;
		padding: 2px 6px;
		font-size: 10px;
	}

	.position-direction.long {
		background: #00cc00;
		color: #000;
	}

	.position-direction.short {
		background: #cc0000;
		color: #fff;
	}

	.position-size {
		color: #ff9500;
		font-weight: bold;
	}

	.position-details {
		display: flex;
		flex-direction: column;
		gap: 8px;
		color: #fff;
	}

	.position-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 15px;
	}

	.tp-price {
		color: #00ff00;
		font-size: 0.9em;
	}

	.sl-price {
		color: #ff4444;
		font-size: 0.9em;
	}

	.position-time {
		color: #888;
		font-size: 0.8em;
	}

	.position-current-price {
		color: #ffd700;
		font-weight: bold;
	}

	.close-button {
		background: #333;
		color: #ff9500;
		border: none;
		padding: 4px 12px;
		font-family: 'Courier New', monospace;
		font-size: 10px;
		font-weight: bold;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.close-button:hover {
		background: #ff9500;
		color: #000;
		transform: scale(1.05);
	}


	.onchain-position {
		border-left: 3px solid #00ff00;
	}

	.position-direction.onchain {
		background: #00ff00;
		color: #000;
		font-size: 8px;
		padding: 2px 4px;
	}

	.position-address {
		color: #ff9500;
		font-family: 'Courier New', monospace;
		font-size: 10px;
	}

	.position-data {
		color: #666;
		font-family: 'Courier New', monospace;
		font-size: 9px;
		word-break: break-all;
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.position-current-price {
		color: #ff9500;
		font-size: 10px;
	}

	.leaderboard-stats {
		margin-left: auto;
		display: flex;
		gap: 15px;
		align-items: center;
		font-size: 10px;
		font-weight: normal;
	}

	.leaderboard-table {
		padding: 10px;
		overflow-y: auto;
	}

	.table-header {
		display: grid;
		grid-template-columns: 50px 1fr 100px 60px;
		gap: 10px;
		padding: 8px;
		color: #ff9500;
		font-size: 10px;
		font-weight: bold;
		border-bottom: 1px solid #333;
		margin-bottom: 5px;
	}

	.leader-row {
		display: grid;
		grid-template-columns: 50px 1fr 100px 60px;
		gap: 10px;
		padding: 8px;
		font-size: 12px;
		border-bottom: 1px solid #1a1a1a;
		transition: all 0.2s ease;
	}

	.leader-row:hover {
		background: #1a1a1a;
		transform: translateX(2px);
	}

	.leader-row.highlight {
		background: #1a1a1a;
		border: 1px solid #ff9500;
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% {
			border-color: #ff9500;
		}
		50% {
			border-color: #ffb733;
		}
	}

	.rank {
		color: #ff9500;
		font-weight: bold;
	}

	.address {
		color: #fff;
		font-family: monospace;
	}

	.pnl-up {
		color: #00ff00;
		font-weight: bold;
		text-align: right;
	}

	.pnl-down {
		color: #ff0000;
		font-weight: bold;
		text-align: right;
	}

	::-webkit-scrollbar {
		width: 8px;
	}

	::-webkit-scrollbar-track {
		background: #000;
	}

	::-webkit-scrollbar-thumb {
		background: #333;
	}

	::-webkit-scrollbar-thumb:hover {
		background: #ff9500;
	}

	/* Mock Token Balance Styles */
	.balance-refresh {
		color: #00ff00;
		cursor: pointer;
		font-size: 10px;
		font-weight: bold;
		font-family: inherit;
		transition: all 0.2s ease;
		padding: 2px 8px;
		border: 1px solid #00ff00;
		background: rgba(0, 255, 0, 0.1);
	}

	.balance-refresh:hover {
		background: #00ff00;
		color: #000;
		transform: scale(1.05);
	}

	.token-balances {
		padding: 10px;
		flex-shrink: 0;
	}

	.balance-row {
		display: flex;
		flex-direction: column;
		padding: 8px;
		margin-bottom: 8px;
		border: 1px solid #333;
		background: #0a0a0a;
		transition: all 0.2s ease;
	}

	.balance-row:hover {
		border-color: #ff9500;
		background: #1a1a1a;
	}

	.balance-row.loading {
		opacity: 0.6;
		border-color: #666;
	}

	.balance-row.not-initialized {
		opacity: 0.4;
		border-color: #444;
	}

	.pair-info {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 6px;
	}

	.pair-name {
		color: #ff9500;
		font-weight: bold;
		font-size: 12px;
		letter-spacing: 1px;
	}

	.pair-status {
		font-size: 9px;
		padding: 2px 6px;
		border-radius: 2px;
		font-weight: bold;
	}

	.balance-row .pair-status {
		background: #00cc00;
		color: #000;
	}

	.balance-row.loading .pair-status {
		background: #ff9500;
		color: #000;
	}

	.balance-row.not-initialized .pair-status {
		background: #666;
		color: #fff;
	}

	.balance-amounts {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.token-balance {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 11px;
	}

	.token-label {
		color: #666;
		font-weight: bold;
		letter-spacing: 0.5px;
	}

	.token-amount {
		color: #fff;
		font-family: 'Courier New', monospace;
		font-weight: bold;
	}


	.pnl-balance {
		border-top: 1px solid #333;
		padding-top: 8px;
		margin-top: 8px;
	}

	.pnl-balance .token-amount {
		font-weight: bold;
		font-size: 1.1em;
	}

	.no-wallet {
		padding: 40px 20px;
		text-align: center;
	}

	.no-wallet-message {
		color: #666;
		font-size: 12px;
		font-style: italic;
	}

	.leaderboard-section {
		border-top: 1px solid #333;
		margin-top: 10px;
	}

	.panel-subheader {
		background: #1a1a1a;
		color: #ff9500;
		padding: 6px 12px;
		font-size: 10px;
		font-weight: bold;
		letter-spacing: 1px;
		border-bottom: 1px solid #333;
		display: flex;
		align-items: center;
	}

	.initialize-hint {
		margin-top: 8px;
		padding: 8px;
		background: rgba(255, 149, 0, 0.1);
		border: 1px solid #ff9500;
		border-radius: 4px;
	}

	.hint-text {
		color: #ff9500;
		font-size: 10px;
		font-style: italic;
		line-height: 1.4;
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

	/* Session / devnet funding modals (Polymock-aligned) */
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
