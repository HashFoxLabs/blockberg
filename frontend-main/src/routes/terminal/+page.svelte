<script lang="ts">
	import { onMount } from 'svelte';
	import { HermesClient } from '@pythnetwork/hermes-client';
	import { magicBlockClient, PositionDirection, TRADING_PAIRS } from '$lib/magicblock';
	import { walletStore } from '$lib/wallet/stores';
	import { tradingModeStore, type TradingContext } from '$lib/stores/tradingMode';
	import WalletButton from '$lib/wallet/WalletButton.svelte';
	import Toast from '$lib/toast/Toast.svelte';
	import { toastStore } from '$lib/toast/store';
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
		confidence: number;
		emaPrice: number;
		publishTime: number;
		spread: number;
	};

	let news: any[] = [];
	let businessNews: any[] = [];
	let prices: Record<string, PriceData> = {
		SOL: { price: 0, change: 0, confidence: 0, emaPrice: 0, publishTime: 0, spread: 0 },
		BTC: { price: 0, change: 0, confidence: 0, emaPrice: 0, publishTime: 0, spread: 0 },
		ETH: { price: 0, change: 0, confidence: 0, emaPrice: 0, publishTime: 0, spread: 0 },
		AVAX: { price: 0, change: 0, confidence: 0, emaPrice: 0, publishTime: 0, spread: 0 },
		LINK: { price: 0, change: 0, confidence: 0, emaPrice: 0, publishTime: 0, spread: 0 },
	};
	let previousPrices: Record<string, number> = {};
	let command = '';
	let selectedTab = 'SOL';
	let positionSize = '100';
	let takeProfit = '';
	let stopLoss = '';
	let selectedPercentage = 0;
	let tradingMode = 'manual'; // 'manual' or 'percentage'
	let availableBalance = { tokenIn: 0, tokenOut: 0 };
	let activeTradingPanel = ''; // 'buy', 'sell', 'long', 'short', or ''
	let buySize = '';
	let sellSize = '';
	let longSize = '';
	let shortSize = '';
	let activePositions: any[] = [];
	let onChainPositions: any[] = [];
	let totalPnL = 0;
	let totalTrades = 0;
	let winningTrades = 0;
	let currentTime = new Date().toLocaleTimeString();
	let competitionEndTime = new Date(Date.now() + 3600000);
	let timeRemaining = '';
	let newsLoading = true;
	let showAllNews = false;
	let pythUpdateInterval: any = null;
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
	let mockTokenBalances: { [pairIndex: number]: { tokenInBalance: number; tokenOutBalance: number; totalPositions: number } } = {};

	// Trading mode context
	let tradingContext: TradingContext = { mode: 'regular' };
	let tournamentParticipantData: any = null;

	// Subscribe to trading mode changes
	tradingModeStore.subscribe(context => {
		tradingContext = context;
		console.log('[TRADING MODE] Mode changed:', context);
		// Refresh balances when mode changes
		if (connectedWallet?.connected) {
			refreshTradingData();
		}
	});

	// Function to refresh trading data based on mode
	async function refreshTradingData() {
		if (!connectedWallet?.connected) return;

		if (tradingContext.mode === 'tournament' && tradingContext.tournamentId) {
			// Fetch tournament participant data
			console.log('[TRADING] Fetching tournament data for tournament #', tradingContext.tournamentId);
			tournamentParticipantData = await magicBlockClient.fetchTournamentParticipant(tradingContext.tournamentId);
			console.log('[TRADING] Tournament participant data:', tournamentParticipantData);
			updateAvailableBalance();
		} else {
			// Regular mode - existing logic
			tournamentParticipantData = null;
			await updateWalletStatus();
		}
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
			availableBalance = { tokenIn: 0, tokenOut: 0 };
			magicBlockStatus = 'Ready - Connect wallet to trade';
			tournamentParticipantData = null;
		}
	});

	async function fetchOnChainPositions() {
		if (!connectedWallet?.connected) {
			onChainPositions = [];
			return;
		}

		const now = Date.now();
		if (now - lastFetchTime < FETCH_COOLDOWN) {
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

			mockTokenBalances = await magicBlockClient.getAllUserAccountData();
			updateAvailableBalance();

			await fetchOnChainPositions();

			await updateLeaderboardAndStats();

			const totalPairs = Object.keys(TRADING_PAIRS).length;
			const initializedPairs = Object.values(accountsInitialized).filter(Boolean).length;

			if (initializedPairs === 0) {
				magicBlockStatus = 'Connected - Initialize accounts to trade';
			} else if (initializedPairs === totalPairs) {
				magicBlockStatus = `Connected - All ${totalPairs} pairs initialized`;
			} else {
				magicBlockStatus = `Connected - ${initializedPairs}/${totalPairs} pairs initialized`;
			}

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

					const pairValue = balances.tokenInBalance + (balances.tokenOutBalance * currentPrice);
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

			// Update status after initialization
			await updateWalletStatus();

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

	function updateTime() {
		currentTime = new Date().toLocaleTimeString();
		const now = Date.now();
		const diff = competitionEndTime.getTime() - now;
		if (diff > 0) {
			const hours = Math.floor(diff / 3600000);
			const minutes = Math.floor((diff % 3600000) / 60000);
			const seconds = Math.floor((diff % 60000) / 1000);
			timeRemaining = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
		} else {
			timeRemaining = 'ENDED';
		}
	}

	async function fetchNews() {
		newsLoading = true;
		try {
			const response = await fetch(`${ENV.NEWS_API_URL}?lang=EN&categories=BTC,ETH,SOL`);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const data = await response.json();

			if (data.Data && data.Data.length > 0) {
				news = data.Data.slice(0, 30);
			} else {
			}
		} catch (error) {
			news = [];
		} finally {
			newsLoading = false;
		}
	}

	async function fetchBusinessNews() {
		try {
			const rssUrl = 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en';
			const response = await fetch(`${ENV.RSS2JSON_API_URL}?rss_url=${encodeURIComponent(rssUrl)}`);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const data = await response.json();

			if (data.items && data.items.length > 0) {
				businessNews = data.items.map((item: any) => ({
					title: item.title,
					url: item.link,
					imageurl: item.enclosure?.link || item.thumbnail || null,
					source: item.author || 'Google News'
				}));
			}
		} catch (error) {
			console.error('Failed to fetch business news:', error);
			businessNews = [];
		}
	}

	async function fetchPythPrices() {
		try {
			const startTime = Date.now();

			const priceIds = Object.values(PYTH_FEEDS).map(f => f.id);

			const priceUpdates = await hermesClient.getLatestPriceUpdates(priceIds);


			if (priceUpdates?.parsed) {

				for (const priceData of priceUpdates.parsed) {
					const symbol = Object.keys(PYTH_FEEDS).find(
						key => PYTH_FEEDS[key as keyof typeof PYTH_FEEDS].id === '0x' + priceData.id
					);

					if (symbol) {
						const price = parseFloat(priceData.price.price) * Math.pow(10, priceData.price.expo);
						const confidence = parseFloat(priceData.price.conf) * Math.pow(10, priceData.price.expo);
						const emaPrice = parseFloat(priceData.ema_price.price) * Math.pow(10, priceData.ema_price.expo);
						const publishTime = priceData.price.publish_time;

						const prevPrice = previousPrices[symbol] || price;
						const change = prevPrice !== 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;

						const spread = price !== 0 ? (confidence / price) * 100 : 0;

						prices[symbol] = {
							price,
							change,
							confidence,
							emaPrice,
							publishTime,
							spread
						};

						previousPrices[symbol] = price;

					}
				}

				prices = prices;
				pythStatus = `Updated ${Object.keys(prices).length} assets`;
				pythLastUpdate = Date.now();
			} else {
				pythStatus = 'No parsed data';
			}
		} catch (error: any) {
			pythStatus = `Error: ${error.message}`;
		}
	}

	function startPythPriceUpdates() {
		fetchPythPrices(); // Initial fetch
		pythUpdateInterval = setInterval(fetchPythPrices, 2000); // Update every 2 seconds
	}

	function executeCommand() {
		const cmd = command.toUpperCase();
		if (cmd.includes('SOL')) switchTab('SOL');
		else if (cmd.includes('BTC')) switchTab('BTC');
		else if (cmd.includes('ETH')) switchTab('ETH');
		else if (cmd.includes('AVAX')) switchTab('AVAX');
		else if (cmd.includes('LINK')) switchTab('LINK');
		command = '';
	}

	async function switchTab(newTab: string) {
		selectedTab = newTab;
		
		// Update available balance for the new pair
		updateAvailableBalance();
		
		// Refresh account data for the new pair
		if (connectedWallet?.connected) {
			await updateWalletStatus();
			await fetchOnChainPositions();
		}
	}

	function updateAvailableBalance() {
		if (!connectedWallet?.connected) {
			availableBalance = { tokenIn: 0, tokenOut: 0 };
			return;
		}

		// Tournament mode - use tournament participant balances
		if (tradingContext.mode === 'tournament' && tournamentParticipantData) {
			const tokenBalanceMap: Record<string, number> = {
				'SOL': tournamentParticipantData.solBalance,
				'BTC': tournamentParticipantData.btcBalance,
				'ETH': tournamentParticipantData.ethBalance,
				'AVAX': tournamentParticipantData.avaxBalance,
				'LINK': tournamentParticipantData.linkBalance
			};

			availableBalance = {
				tokenIn: tournamentParticipantData.usdtBalance,
				tokenOut: tokenBalanceMap[selectedTab] || 0
			};
			console.log('[TRADING] Tournament balance updated:', availableBalance);
			return;
		}

		// Regular mode - existing logic
		const currentPairIndex = TRADING_PAIRS[selectedTab];
		if (mockTokenBalances[currentPairIndex]) {
			const lockedUSDT = onChainPositions
				.filter(p => p.pairIndex === currentPairIndex && p.status === 'ACTIVE')
				.reduce((total, p) => {
					const positionValue = p.amountTokenOut * p.entryPrice;
					return total + positionValue;
				}, 0);

			availableBalance = {
				tokenIn: Math.max(0, mockTokenBalances[currentPairIndex].tokenInBalance - lockedUSDT),
				tokenOut: mockTokenBalances[currentPairIndex].tokenOutBalance
			};
		} else {
			availableBalance = { tokenIn: 0, tokenOut: 0 };
		}
	}

	function setPercentageSize(percentage: number, type: 'buy' | 'sell' | 'long' | 'short') {
		selectedPercentage = percentage;
		tradingMode = 'percentage';
		
		let calculatedSize = 0;
		const currentPrice = prices[selectedTab].price;
		
		// Don't calculate if price is not loaded yet
		if (!currentPrice || currentPrice <= 0) {
			return;
		}
		
		if (type === 'buy' || type === 'long') {
			// For buying/long: use percentage of USDT balance and convert to token amount
			const usdtAmount = (availableBalance.tokenIn * percentage) / 100;
			calculatedSize = usdtAmount / currentPrice; // Convert USDT to token amount
		} else {
			// For selling/short: use percentage of token balance
			calculatedSize = (availableBalance.tokenOut * percentage) / 100;
		}
		
		// Use appropriate decimal places based on token
		const decimals = selectedTab === 'BTC' ? 6 : selectedTab === 'SOL' ? 4 : 6;
		const sizeValue = Math.max(0.0001, calculatedSize).toFixed(decimals);
		
		// Update the appropriate size variable based on type
		switch(type) {
			case 'buy':
				buySize = sizeValue;
				break;
			case 'sell':
				sellSize = sizeValue;
				break;
			case 'long':
				longSize = sizeValue;
				break;
			case 'short':
				shortSize = sizeValue;
				break;
		}
	}

	function resetToManualMode() {
		tradingMode = 'manual';
		selectedPercentage = 0;
	}

	function openTradingPanel(panel: 'buy' | 'sell' | 'long' | 'short') {
		activeTradingPanel = activeTradingPanel === panel ? '' : panel;
		resetToManualMode();
	}

	function closeTradingPanel() {
		activeTradingPanel = '';
		resetToManualMode();
	}

	// Reactive variable for current size input
	$: currentSize = activeTradingPanel === 'buy' ? buySize : 
					activeTradingPanel === 'sell' ? sellSize : 
					activeTradingPanel === 'long' ? longSize : 
					activeTradingPanel === 'short' ? shortSize : '';

	// Function to update the current size
	function updateCurrentSize(value: string) {
		switch(activeTradingPanel) {
			case 'buy':
				buySize = value;
				break;
			case 'sell':
				sellSize = value;
				break;
			case 'long':
				longSize = value;
				break;
			case 'short':
				shortSize = value;
				break;
		}
		resetToManualMode();
	}

	async function executeSpotTrade(action: 'BUY' | 'SELL') {

		if (!connectedWallet?.connected) {
			return;
		}

		const currentPrice = prices[selectedTab].price;
		const sizeInput = action === 'BUY' ? buySize : sellSize;
		const tokenAmount = parseFloat(sizeInput);

		if (tokenAmount <= 0 || !currentPrice || currentPrice <= 0) {
			magicBlockStatus = 'Price not loaded. Please wait...';
			return;
		}

		if (isOnChainMode && connectedWallet?.connected) {
			try {
				magicBlockStatus = `${action}...`;

				let txSig: string;

				// Tournament mode - use tournament trading instructions
				if (tradingContext.mode === 'tournament' && tradingContext.tournamentId) {
					console.log('[TRADING] Executing tournament', action, 'for', selectedTab);
					const pairIndex = TRADING_PAIRS[selectedTab];

					if (action === 'BUY') {
						txSig = await magicBlockClient.tournamentBuy(
							tradingContext.tournamentId,
							pairIndex,
							tokenAmount,
							currentPrice
						);
					} else {
						txSig = await magicBlockClient.tournamentSell(
							tradingContext.tournamentId,
							pairIndex,
							tokenAmount,
							currentPrice
						);
					}

					magicBlockStatus = `Tournament ${action} complete`;
				} else {
					// Regular mode - use regular spot trading
					txSig = await magicBlockClient.executeSpotTrade(
						selectedTab,
						action,
						currentPrice,
						tokenAmount
					);

					magicBlockStatus = `${action} complete`;
				}

				// Show success toast
				toastStore.success(
					`${action} Order Executed`,
					`Successfully ${action === 'BUY' ? 'bought' : 'sold'} ${tokenAmount} ${selectedTab} at $${currentPrice.toFixed(2)}`
				);

				// Refresh data based on mode
				if (tradingContext.mode === 'tournament' && tradingContext.tournamentId) {
					// Refresh tournament participant data
					await refreshTradingData();
				} else {
					// Refresh regular wallet status
					await updateWalletStatus();
					updateAvailableBalance();
				}

				// Additional refresh after delay
				setTimeout(async () => {
					if (tradingContext.mode === 'tournament') {
						await refreshTradingData();
					} else {
						await updateWalletStatus();
						updateAvailableBalance();
					}
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

		// Reset the appropriate size variable
		if (action === 'BUY') {
			buySize = '';
		} else {
			sellSize = '';
		}
		resetToManualMode();
		closeTradingPanel();
	}

	async function openPosition(direction: 'LONG' | 'SHORT') {
		if (!connectedWallet?.connected) {
			return;
		}

		const currentPrice = prices[selectedTab].price;
		const sizeInput = direction === 'LONG' ? longSize : shortSize;
		const tokenAmount = parseFloat(sizeInput);

		if (!tokenAmount || tokenAmount <= 0 || !currentPrice || currentPrice <= 0) {
			magicBlockStatus = 'Price not loaded. Please wait...';
			return;
		}

		if (isOnChainMode) {
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
					sl
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
		
		// Reset the appropriate size variable
		if (direction === 'LONG') {
			longSize = '';
		} else {
			shortSize = '';
		}
		takeProfit = '';
		stopLoss = '';
		resetToManualMode();
		closeTradingPanel();
	}

	async function closePosition(id: number | string) {
		if (isOnChainMode && connectedWallet?.connected) {
			try {
				magicBlockStatus = 'Closing position on-chain...';

				// Check if this is a direct contract position (has pubkey) or traditional position
				const onChainPos = onChainPositions.find(p => p.pubkey === id);
				let txSig: string;

				if (onChainPos) {
					// This is a direct contract position - use closeDirectPosition
					const currentPrice = prices[onChainPos.pairSymbol]?.price || onChainPos.entryPrice;
					txSig = await magicBlockClient.closeDirectPosition(id.toString(), currentPrice);
				} else {
					// This is a traditional MagicBlock/Bolt position
					txSig = await magicBlockClient.closePosition(id.toString());
				}

				magicBlockStatus = `Position closed: ${txSig.substring(0, 8)}...`;

				// Show success toast
				if (onChainPos) {
					const pnlDisplay = onChainPos.pnl >= 0 ? `+$${onChainPos.pnl.toFixed(2)}` : `-$${Math.abs(onChainPos.pnl).toFixed(2)}`;
					toastStore.success(
						'Position Closed',
						`Closed ${onChainPos.direction} ${onChainPos.pairSymbol} position. P&L: ${pnlDisplay}`
					);
				} else {
					toastStore.success('Position Closed', 'Your position has been closed successfully.');
				}

				// Refresh positions immediately and again after a delay
				await fetchOnChainPositions();
				setTimeout(async () => {
					await fetchOnChainPositions();
				}, 1000);

			} catch (error: any) {
				if (error.message?.includes('This transaction has already been processed') ||
					error.message?.includes('Transaction already processed')) {
					magicBlockStatus = 'Position closed';
					toastStore.success('Position Closed', 'Your position has been closed successfully.');

					await fetchOnChainPositions();
					setTimeout(async () => {
						await fetchOnChainPositions();
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

		// Real leaderboard updates would be handled by the competition contract

		activePositions = activePositions.filter(p => p.id !== id);
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
			await fetchOnChainPositions();
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
		fetchNews();
		fetchBusinessNews();
		startPythPriceUpdates();
		updateTime();

		setInterval(fetchNews, 300000);
		setInterval(updateTime, 1000);

		// Fetch positions regularly (every 5 seconds for better responsiveness)
		setInterval(async () => {
			if (connectedWallet?.connected) {
				await fetchOnChainPositions();
			}
		}, 5000);

		// Initial position fetch when page loads (after wallet might be connected)
		setTimeout(async () => {
			if (connectedWallet?.connected) {
				await fetchOnChainPositions();
			}
		}, 3000);


		return () => {
			if (pythUpdateInterval) {
				clearInterval(pythUpdateInterval);
			}
		};
	});
</script>

<div class="bloomberg">
	<div class="command-bar">
		<a href="/landing" class="logo">BLOCKBERG</a>
		<div class="nav-links">
			<a href="/terminal" class="nav-link active">TERMINAL</a>
			<a href="/dashboard" class="nav-link">DASHBOARD</a>
			<a href="/competition" class="nav-link">COMPETITION</a>
		</div>
		<input
			type="text"
			bind:value={command}
			on:keydown={(e) => e.key === 'Enter' && executeCommand()}
			placeholder="Type command and press GO"
			class="command-input"
		/>
		<button class="go-button" on:click={executeCommand}>GO</button>
		<div class="pyth-status">
			<span class="status-label">PYTH:</span>
			<span class="status-value">{pythStatus}</span>
			{#if pythLastUpdate > 0}
				<span class="status-age">{Math.floor((Date.now() - pythLastUpdate) / 1000)}s ago</span>
			{/if}
		</div>
		<div class="magicblock-status">
			<span class="status-label">MAGICBLOCK:</span>
			<span class="status-value">{magicBlockStatus}</span>
			{#if connectedWallet?.connected}
				<span class="wallet-addr">{walletAddress.substring(0, 4)}...{walletAddress.substring(walletAddress.length - 4)}</span>
				<span class="wallet-balance">{walletBalance.toFixed(4)} SOL</span>
				{#if walletBalance < 0.1}
					<button class="airdrop-btn" on:click={requestAirdrop}>AIRDROP</button>
				{/if}
				{#if tradingContext.mode !== 'tournament' && (Object.keys(accountsInitialized).length === 0 || Object.values(accountsInitialized).some(initialized => !initialized))}
					<button class="initialize-btn" on:click={initializeAllAccounts}>INITIALIZE</button>
				{/if}
			{/if}
		</div>
		<div class="trading-mode-indicator" class:tournament={tradingContext.mode === 'tournament'} class:regular={tradingContext.mode === 'regular'}>
			<span class="mode-label">MODE:</span>
			{#if tradingContext.mode === 'tournament'}
				<span class="mode-value">TOURNAMENT #{tradingContext.tournamentId}</span>
				<button class="mode-switch-btn" on:click={() => tradingModeStore.setRegularMode()}>
					SWITCH TO REGULAR
				</button>
			{:else}
				<span class="mode-value">REGULAR TRADING</span>
				<a href="/competition" class="mode-switch-btn">VIEW TOURNAMENTS</a>
			{/if}
		</div>
		<div class="wallet-section">
			<WalletButton />
		</div>
	</div>

	<div class="ticker-bar">
		<div class="ticker-item">
			SOL/USD <span class="price">{prices.SOL.price.toFixed(2)}</span>
			<span class={prices.SOL.change >= 0 ? 'change-up' : 'change-down'}>
				{prices.SOL.change >= 0 ? '▲' : '▼'} {Math.abs(prices.SOL.change).toFixed(2)}%
			</span>
			<span class="confidence" title="Confidence Interval">±{prices.SOL.confidence.toFixed(4)}</span>
		</div>
		<div class="ticker-item">
			BTC/USD <span class="price">{prices.BTC.price.toFixed(2)}</span>
			<span class={prices.BTC.change >= 0 ? 'change-up' : 'change-down'}>
				{prices.BTC.change >= 0 ? '▲' : '▼'} {Math.abs(prices.BTC.change).toFixed(2)}%
			</span>
			<span class="confidence" title="Confidence Interval">±{prices.BTC.confidence.toFixed(2)}</span>
		</div>
		<div class="ticker-item">
			ETH/USD <span class="price">{prices.ETH.price.toFixed(2)}</span>
			<span class={prices.ETH.change >= 0 ? 'change-up' : 'change-down'}>
				{prices.ETH.change >= 0 ? '▲' : '▼'} {Math.abs(prices.ETH.change).toFixed(2)}%
			</span>
			<span class="confidence" title="Confidence Interval">±{prices.ETH.confidence.toFixed(3)}</span>
		</div>
		<div class="ticker-item">
			AVAX/USD <span class="price">{prices.AVAX.price.toFixed(2)}</span>
			<span class={prices.AVAX.change >= 0 ? 'change-up' : 'change-down'}>
				{prices.AVAX.change >= 0 ? '▲' : '▼'} {Math.abs(prices.AVAX.change).toFixed(2)}%
			</span>
			<span class="confidence" title="Confidence Interval">±{prices.AVAX.confidence.toFixed(4)}</span>
		</div>
		<div class="ticker-item">
			LINK/USD <span class="price">{prices.LINK.price.toFixed(3)}</span>
			<span class={prices.LINK.change >= 0 ? 'change-up' : 'change-down'}>
				{prices.LINK.change >= 0 ? '▲' : '▼'} {Math.abs(prices.LINK.change).toFixed(2)}%
			</span>
			<span class="confidence" title="Confidence Interval">±{prices.LINK.confidence.toFixed(5)}</span>
		</div>
	</div>

	<div class="tabs">
		<button class="tab" class:active={selectedTab === 'SOL'} on:click={() => switchTab('SOL')}>SOL EQUITY</button>
		<button class="tab" class:active={selectedTab === 'BTC'} on:click={() => switchTab('BTC')}>BTC EQUITY</button>
		<button class="tab" class:active={selectedTab === 'ETH'} on:click={() => switchTab('ETH')}>ETH EQUITY</button>
		<button class="tab" class:active={selectedTab === 'AVAX'} on:click={() => switchTab('AVAX')}>AVAX EQUITY</button>
		<button class="tab" class:active={selectedTab === 'LINK'} on:click={() => switchTab('LINK')}>LINK EQUITY</button>
		<div class="news-ticker-container">
			<div class="news-ticker">
				{#if businessNews.length > 0}
					{#each [...businessNews, ...businessNews] as article, i}
						<a href={article.url} target="_blank" rel="noopener noreferrer" class="ticker-news-item">
							{#if article.imageurl}
								<img src={article.imageurl} alt="" class="ticker-news-img" />
							{/if}
							<span class="ticker-news-text">{article.title}</span>
						</a>
					{/each}
				{:else}
					<span class="ticker-loading">Loading business news...</span>
				{/if}
			</div>
		</div>
	</div>

	<div class="main-grid">
		<div class="panel news-panel">
			<div class="panel-header">
				TOP NEWS - CRYPTO
				{#if !newsLoading && news.length > 5}
					<span class="news-toggle" on:click={() => showAllNews = !showAllNews}>
						{showAllNews ? '▲ COLLAPSE' : '▼ SHOW ALL'}
					</span>
				{/if}
			</div>
			<div class="news-list" class:expanded={showAllNews}>
				{#if newsLoading}
					<div class="loading-state">Loading news from CryptoCompare API...</div>
				{:else if news.length === 0}
					<div class="error-state">Failed to load news. Check console for details.</div>
				{:else}
					{@const displayedNews = showAllNews ? news : news.slice(0, 5)}
					{#each displayedNews as article, i}
						<a href={article.url} target="_blank" rel="noopener noreferrer" class="news-item">
							<div class="news-meta">
								<span class="news-number">{i + 1}</span>
								<span class="news-time">{new Date(article.published_on * 1000).toLocaleTimeString()}</span>
								<span class="news-source">{article.source}</span>
							</div>
							<div class="news-title">{article.title}</div>
						</a>
					{/each}
					{#if !showAllNews && news.length > 5}
						<div class="news-more">
							<button class="show-more-btn" on:click={() => showAllNews = true}>
								Show {news.length - 5} more articles ▼
							</button>
						</div>
					{/if}
					{#if showAllNews && news.length > 5}
						<div class="news-more">
							<button class="show-more-btn" on:click={() => showAllNews = false}>
								▲ Show less
							</button>
						</div>
					{/if}
				{/if}
			</div>
		</div>

		<div class="panel chart-panel">
			<div class="panel-header">
				<span class="chart-title">{selectedTab}/USD PRICE CHART • PYTH NETWORK</span>
				<div class="chart-stats">
					<div class="stat-box">
						<span class="stat-label">SPOT</span>
						<span class="stat-value price-value">${prices[selectedTab].price.toFixed(2)}</span>
						<span class={prices[selectedTab].change >= 0 ? 'change-up' : 'change-down'}>
							{prices[selectedTab].change >= 0 ? '▲' : '▼'} {Math.abs(prices[selectedTab].change).toFixed(2)}%
						</span>
					</div>
					<div class="stat-box">
						<span class="stat-label">EMA</span>
						<span class="stat-value ema-value">${prices[selectedTab].emaPrice.toFixed(2)}</span>
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
				<iframe
					src="https://www.tradingview.com/widgetembed/?symbol=BINANCE:{selectedTab}USDT&interval=15&theme=dark&style=1&locale=en&allow_symbol_change=0"
					style="width: 100%; height: 100%; border: none;"
					title="{selectedTab} Chart"
					allow="fullscreen"
				></iframe>
			</div>

		</div>

		<div class="panel leaderboard-panel">
			<div class="panel-header">
				{selectedTab}/USDT BALANCE
				<span class="balance-refresh" on:click={updateWalletStatus}>
					↻ REFRESH
				</span>
			</div>
			{#if connectedWallet?.connected}
				{@const currentPairIndex = TRADING_PAIRS[selectedTab]}
				<div class="token-balances">
					{#if tradingContext.mode === 'tournament' && tournamentParticipantData}
						{@const currentPrice = prices[selectedTab]?.price || 0}
						{@const tokenBalanceMap = {
							'SOL': tournamentParticipantData.solBalance,
							'BTC': tournamentParticipantData.btcBalance,
							'ETH': tournamentParticipantData.ethBalance,
							'AVAX': tournamentParticipantData.avaxBalance,
							'LINK': tournamentParticipantData.linkBalance
						}}
						{@const tokenBalance = tokenBalanceMap[selectedTab] || 0}
						{@const totalValue = tournamentParticipantData.usdtBalance + (tokenBalance * currentPrice)}
						{@const pnl = totalValue - 10000}
						<div class="balance-row">
							<div class="pair-info">
								<span class="pair-name">{selectedTab}/USDT</span>
								<span class="pair-status">TOURNAMENT</span>
							</div>
							<div class="balance-amounts">
								<div class="token-balance">
									<span class="token-label">USDT:</span>
									<span class="token-amount">{tournamentParticipantData.usdtBalance.toFixed(2)}</span>
								</div>
								<div class="token-balance">
									<span class="token-label">{selectedTab}:</span>
									<span class="token-amount">{tokenBalance.toFixed(4)}</span>
								</div>
							</div>
						</div>
					{:else if tradingContext.mode === 'tournament' && !tournamentParticipantData}
						<div class="balance-row not-initialized">
							<div class="pair-info">
								<span class="pair-name">{selectedTab}/USDT</span>
								<span class="pair-status">NOT JOINED</span>
							</div>
							<div class="initialize-hint">
								<span class="hint-text">Visit COMPETITION page to join this tournament</span>
							</div>
						</div>
					{:else if mockTokenBalances[currentPairIndex]}
						{@const currentPrice = prices[selectedTab]?.price || 0}
					{@const totalValue = mockTokenBalances[currentPairIndex].tokenInBalance + (mockTokenBalances[currentPairIndex].tokenOutBalance * currentPrice)}
					{@const pnl = totalValue - 10000}
						<div class="balance-row">
							<div class="pair-info">
								<span class="pair-name">{selectedTab}/USDT</span>
								<span class="pair-status">INITIALIZED</span>
							</div>
							<div class="balance-amounts">
								<div class="token-balance">
									<span class="token-label">USDT:</span>
									<span class="token-amount">{mockTokenBalances[currentPairIndex].tokenInBalance.toFixed(2)}</span>
								</div>
								<div class="token-balance">
									<span class="token-label">{selectedTab}:</span>
									<span class="token-amount">{mockTokenBalances[currentPairIndex].tokenOutBalance.toFixed(4)}</span>
								</div>
							</div>
						</div>
					{:else if accountsInitialized[currentPairIndex]}
						<div class="balance-row loading">
							<div class="pair-info">
								<span class="pair-name">{selectedTab}/USDT</span>
								<span class="pair-status">LOADING...</span>
							</div>
						</div>
					{:else}
						<div class="balance-row not-initialized">
							<div class="pair-info">
								<span class="pair-name">{selectedTab}/USDT</span>
								<span class="pair-status">NOT INITIALIZED</span>
							</div>
							<div class="initialize-hint">
								<span class="hint-text">Click "INITIALIZE" button above to set up trading account</span>
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div class="no-wallet">
					<div class="no-wallet-message">Connect wallet to view mock token balances</div>
				</div>
			{/if}

			<!-- Trading Panel -->
			<div class="trading-panel-right">
				{#if !activeTradingPanel}
					<!-- Main Trading Buttons View -->
					<div class="panel-subheader">TRADE {selectedTab}/USDT</div>
					<div class="trading-sections">
						<!-- BUY/LONG Section -->
						<div class="trading-section buy-section">
							<div class="section-header">
								<div class="section-title">BUY / LONG</div>
								<div class="section-price">@${prices[selectedTab].price.toFixed(2)}</div>
							</div>
							<div class="section-buttons">
								<button
									class="action-btn buy-btn"
									on:click={() => openTradingPanel('buy')}
									disabled={!connectedWallet?.connected}
								>
									<div class="btn-text">BUY SPOT</div>
								</button>
								<button
									class="action-btn long-btn"
									on:click={() => openTradingPanel('long')}
									disabled={!connectedWallet?.connected}
								>
									<div class="btn-text">LONG</div>
								</button>
							</div>
						</div>

						<!-- SELL/SHORT Section -->
						<div class="trading-section sell-section">
							<div class="section-header">
								<div class="section-title">SELL / SHORT</div>
								<div class="section-price">@${prices[selectedTab].price.toFixed(2)}</div>
							</div>
							<div class="section-buttons">
								<button
									class="action-btn sell-btn"
									on:click={() => openTradingPanel('sell')}
									disabled={!connectedWallet?.connected}
								>
									<div class="btn-text">SELL SPOT</div>
								</button>
								<button
									class="action-btn short-btn"
									on:click={() => openTradingPanel('short')}
									disabled={!connectedWallet?.connected}
								>
									<div class="btn-text">SHORT</div>
								</button>
							</div>
						</div>

						<!-- Quick Stats -->
						<div class="trading-quick-stats">
							<div class="quick-stat">
								<span class="stat-label">24h Change</span>
								<span class={prices[selectedTab].change >= 0 ? 'stat-value-up' : 'stat-value-down'}>
									{prices[selectedTab].change >= 0 ? '+' : ''}{prices[selectedTab].change.toFixed(2)}%
								</span>
							</div>
							<div class="quick-stat">
								<span class="stat-label">EMA Price</span>
								<span class="stat-value">${prices[selectedTab].emaPrice.toFixed(2)}</span>
							</div>
							<div class="quick-stat">
								<span class="stat-label">Confidence</span>
								<span class="stat-value">±{prices[selectedTab].spread.toFixed(3)}%</span>
							</div>
						</div>
					</div>
				{:else}
					<!-- Trading Form View (replaces buttons) -->
					<div class="panel-subheader trading-form-header">
						<button class="back-btn" on:click={closeTradingPanel}>
							<span class="back-arrow">←</span>
						</button>
						<span class="form-title"
							class:buy-title={activeTradingPanel === 'buy' || activeTradingPanel === 'long'}
							class:sell-title={activeTradingPanel === 'sell' || activeTradingPanel === 'short'}
						>
							{activeTradingPanel.toUpperCase()} {selectedTab}/USDT
						</span>
						<span class="form-price">@${prices[selectedTab].price.toFixed(2)}</span>
					</div>

					<div class="trading-form-content">
						<!-- Trading Mode Toggle -->
						<div class="trading-mode-toggle">
							<button
								class="mode-toggle-btn"
								class:active={tradingMode === 'manual'}
								on:click={resetToManualMode}
							>
								MANUAL
							</button>
							<button
								class="mode-toggle-btn"
								class:active={tradingMode === 'percentage'}
								on:click={() => tradingMode = 'percentage'}
							>
								PERCENTAGE
							</button>
						</div>

						<!-- Percentage Controls -->
						{#if tradingMode === 'percentage'}
							<div class="percentage-buttons-grid">
								<button
									class="percentage-btn-advanced"
									class:active={selectedPercentage === 25}
									on:click={() => setPercentageSize(25, activeTradingPanel)}
								>
									25%
								</button>
								<button
									class="percentage-btn-advanced"
									class:active={selectedPercentage === 50}
									on:click={() => setPercentageSize(50, activeTradingPanel)}
								>
									50%
								</button>
								<button
									class="percentage-btn-advanced"
									class:active={selectedPercentage === 75}
									on:click={() => setPercentageSize(75, activeTradingPanel)}
								>
									75%
								</button>
								<button
									class="percentage-btn-advanced"
									class:active={selectedPercentage === 100}
									on:click={() => setPercentageSize(100, activeTradingPanel)}
								>
									100%
								</button>
							</div>
						{/if}

						<!-- Input Controls -->
						<div class="input-controls-grid">
							<div class="input-control">
								<label class="input-label">SIZE ({selectedTab})</label>
								<input
									type="number"
									class="trading-input"
									value={currentSize}
									on:input={(e) => updateCurrentSize(e.target.value)}
									placeholder="0.00"
								/>
							</div>
							{#if activeTradingPanel === 'long' || activeTradingPanel === 'short'}
								<div class="input-control">
									<label class="input-label">TAKE PROFIT (USDT)</label>
									<input
										type="number"
										class="trading-input"
										bind:value={takeProfit}
										placeholder="0.00"
									/>
								</div>
								<div class="input-control">
									<label class="input-label">STOP LOSS (USDT)</label>
									<input
										type="number"
										class="trading-input"
										bind:value={stopLoss}
										placeholder="0.00"
									/>
								</div>
							{/if}
						</div>

						<!-- Trade Summary -->
						<div class="trade-summary">
							<div class="summary-row">
								<span>Available:</span>
								<span class="summary-value">
									{activeTradingPanel === 'buy' || activeTradingPanel === 'long'
										? availableBalance.tokenIn.toFixed(2) + ' USDT'
										: availableBalance.tokenOut.toFixed(4) + ' ' + selectedTab
									}
								</span>
							</div>
							{#if currentSize}
								<div class="summary-row">
									<span>Est. Cost:</span>
									<span class="summary-value">
										{prices[selectedTab].price > 0
											? ((parseFloat(currentSize) || 0) * prices[selectedTab].price).toFixed(2) + ' USDT'
											: 'Loading...'
										}
									</span>
								</div>
							{/if}
						</div>

						<!-- Execute Button -->
						<button
							class="execute-btn"
							class:buy-execute={activeTradingPanel === 'buy' || activeTradingPanel === 'long'}
							class:sell-execute={activeTradingPanel === 'sell' || activeTradingPanel === 'short'}
							on:click={() => {
								if (activeTradingPanel === 'buy') executeSpotTrade('BUY');
								else if (activeTradingPanel === 'sell') executeSpotTrade('SELL');
								else if (activeTradingPanel === 'long') openPosition('LONG');
								else if (activeTradingPanel === 'short') openPosition('SHORT');
							}}
							disabled={!connectedWallet?.connected ||
								!currentSize ||
								parseFloat(currentSize) <= 0
							}
						>
							{activeTradingPanel.toUpperCase()} {selectedTab}
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>

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

	.command-bar {
		background: #1a1a1a;
		padding: 8px 15px;
		display: flex;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid #333;
		flex-wrap: nowrap;
		overflow-x: auto;
		overflow-y: hidden;
		min-height: 50px;
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
		font-size: 18px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 2px;
		text-decoration: none;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.nav-links {
		display: flex;
		gap: 15px;
		flex-shrink: 0;
	}

	.nav-link {
		color: #666;
		text-decoration: none;
		font-size: 13px;
		padding: 4px 10px;
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

	.command-input {
		min-width: 200px;
		background: #000;
		border: 1px solid #ff9500;
		color: #ff9500;
		padding: 6px 12px;
		font-family: 'Courier New', monospace;
		font-size: 13px;
		flex-shrink: 1;
	}

	.command-input::placeholder {
		color: #664000;
	}

	.go-button {
		background: #00cc00;
		color: #000;
		border: none;
		padding: 6px 20px;
		font-weight: bold;
		font-size: 14px;
		cursor: pointer;
		font-family: inherit;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.go-button:hover {
		background: #00ff00;
	}

	.pyth-status {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #ff9500;
		font-size: 10px;
		padding: 4px 8px;
		background: #000;
		border: 1px solid #333;
		flex-shrink: 0;
		min-width: 120px;
	}

	.status-label {
		color: #666;
		font-size: 10px;
		letter-spacing: 0.5px;
	}

	.status-value {
		color: #00ff00;
		font-weight: bold;
	}

	.status-age {
		color: #999;
		font-size: 9px;
	}

	.magicblock-status {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #ff9500;
		font-size: 10px;
		padding: 4px 8px;
		background: #000;
		border: 1px solid #333;
		flex-shrink: 0;
		min-width: 150px;
	}

	.wallet-addr {
		color: #00aaff;
		font-size: 10px;
		font-family: 'Courier New', monospace;
	}

	.wallet-balance {
		color: #00ff00;
		font-weight: bold;
		margin-left: 8px;
		font-size: 10px;
	}

	.airdrop-btn {
		background: #ff9500;
		color: #000;
		border: none;
		padding: 4px 12px;
		font-size: 10px;
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
		padding: 4px 12px;
		font-size: 10px;
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

	.trading-mode-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		padding: 4px 8px;
		border: 1px solid #333;
		flex-shrink: 0;
	}

	.trading-mode-indicator.regular {
		background: #000;
		color: #666;
	}

	.trading-mode-indicator.tournament {
		background: #1a1a00;
		color: #ff9500;
		border-color: #ff9500;
		animation: pulse-border 2s infinite;
	}

	@keyframes pulse-border {
		0%, 100% { border-color: #ff9500; }
		50% { border-color: #ffaa00; }
	}

	.mode-label {
		color: #999;
		font-weight: bold;
	}

	.mode-value {
		color: inherit;
		font-weight: bold;
	}

	.mode-switch-btn {
		background: #333;
		color: #fff;
		border: 1px solid #666;
		padding: 3px 8px;
		font-size: 9px;
		font-weight: bold;
		cursor: pointer;
		margin-left: 6px;
		font-family: 'Courier New', monospace;
		letter-spacing: 1px;
		text-decoration: none;
		display: inline-block;
		transition: all 0.2s ease;
	}

	.mode-switch-btn:hover {
		background: #444;
	}

	.competition-timer {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #ff9500;
		font-size: 11px;
		padding: 4px 8px;
		background: #000;
		border: 1px solid #333;
		flex-shrink: 0;
		min-width: 100px;
	}

	.timer-label {
		color: #666;
		font-size: 10px;
		letter-spacing: 0.5px;
	}

	.timer-value {
		color: #00ff00;
		font-weight: bold;
		font-family: 'Courier New', monospace;
	}

	.wallet-section {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	.clock {
		color: #ff9500;
		font-size: 12px;
		min-width: 80px;
		text-align: right;
		flex-shrink: 0;
	}

	.ticker-bar {
		background: #0a0a0a;
		padding: 8px 15px;
		display: flex;
		gap: 40px;
		border-bottom: 1px solid #333;
	}

	.ticker-item {
		font-size: 13px;
		color: #ff9500;
		display: flex;
		gap: 10px;
		align-items: center;
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

	.confidence {
		color: #666;
		font-size: 10px;
		font-style: italic;
	}

	.ema-price {
		color: #00ccff;
		font-weight: normal;
	}

	.confidence-stat {
		color: #ffaa00;
		font-size: 11px;
	}

	.freshness {
		color: #00ff00;
		font-size: 11px;
	}

	.tabs {
		background: #0a0a0a;
		display: flex;
		gap: 2px;
		padding: 0 15px;
		border-bottom: 1px solid #333;
		overflow-x: auto;
		flex-wrap: nowrap;
		scrollbar-width: thin;
		scrollbar-color: #ff9500 #1a1a1a;
	}

	.tabs::-webkit-scrollbar {
		height: 6px;
	}

	.tabs::-webkit-scrollbar-track {
		background: #1a1a1a;
	}

	.tabs::-webkit-scrollbar-thumb {
		background: #ff9500;
		border-radius: 3px;
	}

	.tab {
		background: #1a1a1a;
		color: #ff9500;
		border: none;
		padding: 8px 20px;
		font-family: 'Courier New', monospace;
		font-size: 12px;
		cursor: pointer;
		border-top: 2px solid transparent;
		transition: all 0.2s ease;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.tab.active {
		background: #000;
		border-top-color: #ff9500;
		color: #fff;
	}

	.tab:hover {
		background: #000;
	}

	/* News Ticker */
	.news-ticker-container {
		min-width: 200px;
		flex-shrink: 1;
		overflow: hidden;
		position: relative;
		background: #0a0a0a;
		border-left: 1px solid #333;
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

	.main-grid {
		display: grid;
		grid-template-columns: 280px 1fr 340px;
		gap: 2px;
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

	.news-panel {
		display: flex;
		flex-direction: column;
		height: 485px;
	}

	.chart-panel {
		display: flex;
		flex-direction: column;
		height: 485px;
	}

	.leaderboard-panel {
		display: flex;
		flex-direction: column;
		overflow-x: hidden;
		overflow-y: hidden;
		height: 485px;
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

	.news-list {
		padding: 10px;
		flex: 1;
		overflow: hidden;
	}

	.news-list.expanded {
		overflow-y: auto;
	}

	.loading-state,
	.error-state {
		padding: 20px;
		text-align: center;
		color: #666;
		font-size: 12px;
	}

	.error-state {
		color: #ff0000;
	}

	.news-item {
		display: block;
		padding: 10px 0;
		border-bottom: 1px solid #1a1a1a;
		transition: background 0.2s ease;
		cursor: pointer;
		text-decoration: none;
		color: inherit;
	}

	.news-item:hover {
		background: #0a0a0a;
		padding-left: 8px;
	}

	.news-meta {
		display: flex;
		gap: 10px;
		margin-bottom: 5px;
		font-size: 10px;
		color: #666;
	}

	.news-number {
		color: #ff9500;
		font-weight: bold;
	}

	.news-title {
		color: #fff;
		font-size: 12px;
		line-height: 1.5;
	}

	.news-toggle {
		color: #00ff00;
		cursor: pointer;
		font-size: 9px;
		font-weight: bold;
		transition: all 0.2s ease;
		padding: 2px 6px;
		border: 1px solid #00ff00;
		background: rgba(0, 255, 0, 0.1);
	}

	.news-toggle:hover {
		background: #00ff00;
		color: #000;
		transform: scale(1.05);
	}

	.news-more {
		text-align: center;
		padding: 15px;
		border-top: 1px solid #333;
		margin-top: 10px;
	}

	.show-more-btn {
		background: #1a1a1a;
		color: #ff9500;
		border: 1px solid #ff9500;
		padding: 8px 16px;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		font-weight: bold;
		cursor: pointer;
		transition: all 0.2s ease;
		letter-spacing: 0.5px;
	}

	.show-more-btn:hover {
		background: #ff9500;
		color: #000;
		transform: scale(1.05);
	}

	.chart-container {
		background: #0a0a0a;
		flex: 1;
		width: 100%;
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
		border-color: #00ff00;
		color: #00ff00;
	}

	.buy-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #00ff00, #00cc00);
		color: #000;
		border-color: #00ff00;
	}

	.buy-btn.active {
		background: rgba(0, 255, 0, 0.1);
		box-shadow: 0 0 15px rgba(0, 255, 0, 0.4);
		border-color: #00ff00;
	}

	.sell-btn {
		border-color: #ff4444;
		color: #ff4444;
	}

	.sell-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #ff4444, #cc3333);
		color: #fff;
		border-color: #ff4444;
	}

	.sell-btn.active {
		background: rgba(255, 68, 68, 0.1);
		box-shadow: 0 0 15px rgba(255, 68, 68, 0.4);
		border-color: #ff4444;
	}

	.long-btn {
		border-color: #00ff00;
		color: #00ff00;
	}

	.long-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #00ff00, #00cc00);
		color: #000;
		border-color: #00ff00;
	}

	.long-btn.active {
		background: rgba(0, 255, 0, 0.1);
		box-shadow: 0 0 15px rgba(0, 255, 0, 0.4);
		border-color: #00ff00;
	}

	.short-btn {
		border-color: #ff4444;
		color: #ff4444;
	}

	.short-btn:hover:not(:disabled) {
		background: linear-gradient(145deg, #ff4444, #cc3333);
		color: #fff;
		border-color: #ff4444;
	}

	.short-btn.active {
		background: rgba(255, 68, 68, 0.1);
		box-shadow: 0 0 15px rgba(255, 68, 68, 0.4);
		border-color: #ff4444;
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


	.chart-title {
		color: #ff9500;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 1px;
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
		color: #00aaff;
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
		color: #00aaff;
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
		max-width: 100%;
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
