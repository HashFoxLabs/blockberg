<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { magicBlockClient, TournamentStatus, type Tournament } from '$lib/magicblock';
	import { walletStore } from '$lib/wallet/stores';
	import { tradingModeStore } from '$lib/stores/tradingMode';
	import WalletButton from '$lib/wallet/WalletButton.svelte';
	import * as ENV from '$lib/env';

	// Tournament state
	let tournaments: Tournament[] = [];
	let selectedTournament: Tournament | null = null;
	let selectedTournamentId: number | null = null;
	let participantData: any = null;
	let leaderboard: any[] = [];
	let hasJoined = false;

	// Tournament IDs to hide from display
	const HIDDEN_TOURNAMENT_IDS = new Set(['7414763778215203000', '4327537319689978400', '12206805485679546000', '7562650077706697000']);

	// Filter out hidden tournaments
	$: visibleTournaments = tournaments.filter(t => !HIDDEN_TOURNAMENT_IDS.has(String(t.id)));

	// Active tournaments: Pending or Active, excluding Ended/Settled
	$: activeTournaments = visibleTournaments.filter(t => {
		if (t.status === TournamentStatus.Ended || t.status === TournamentStatus.Settled) return false;
		return true;
	});

	// Past tournaments: Ended or Settled only
	$: pastTournaments = visibleTournaments.filter(t =>
		t.status === TournamentStatus.Ended || t.status === TournamentStatus.Settled
	);

	// Debug logging
	$: if (tournaments.length > 0) {
		console.log('[TOURNAMENTS] Total:', tournaments.length);
		console.log('[TOURNAMENTS] Active:', activeTournaments.length);
		console.log('[TOURNAMENTS] Past:', pastTournaments.length);
	}

	// Force reactivity for countdown by creating a derived value
	$: timeDisplay = selectedTournament ? getTimeRemaining(selectedTournament) : '00:00:00';

	// Trigger update when currentTime changes
	$: if (currentTime && selectedTournament) {
		timeDisplay = getTimeRemaining(selectedTournament);
	}

	// Auto-close tournaments that have passed their end time
	$: if (currentTime && tournaments.length > 0) {
		checkAndEndTournaments();
	}

	// Create tournament modal
	let showCreateModal = false;
	let createForm = {
		tournamentId: Math.floor(Date.now() / 1000),
		entryFee: 0.1,
		durationMinutes: 60,
		cooldownMinutes: 5,
		durationUnit: 'minutes' as 'minutes' | 'days',
		cooldownUnit: 'minutes' as 'minutes' | 'days'
	};

	let prices: Record<string, { price: number; change: number }> = {
		'SOL': { price: 0, change: 0 },
		'BTC': { price: 0, change: 0 },
		'ETH': { price: 0, change: 0 },
		'AVAX': { price: 0, change: 0 },
		'LINK': { price: 0, change: 0 }
	};

	let connectedWallet: any = null;
	let walletAddress = '';
	let isProcessing = false;
	let statusMessage = '';
	let currentTime = Date.now(); // For live countdown updates
	let showHowItWorks = false;

	// Subscribe to wallet changes
	walletStore.subscribe(wallet => {
		connectedWallet = wallet;
		if (wallet.connected && wallet.publicKey) {
			walletAddress = wallet.publicKey.toBase58();
			magicBlockClient.setConnectedWallet(wallet.adapter);
			refreshData();
		} else {
			walletAddress = '';
			hasJoined = false;
			participantData = null;
		}
	});

	async function checkAndEndTournaments() {
		const now = Date.now();
		const activeTournaments = tournaments.filter(t => t.status === TournamentStatus.Active);
		for (const tournament of activeTournaments) {
			// If tournament has passed its end time and is still Active
			if (now >= tournament.endTime.getTime()) {
				try {
					console.log(`[AUTO-CLOSE] Tournament #${tournament.id} has ended, closing...`);
					const signature = await magicBlockClient.endTournament(tournament.id);
					console.log(`[AUTO-CLOSE] Tournament #${tournament.id} ended:`, signature);
					// Refresh tournaments after closing
					await fetchTournaments();
					if (selectedTournamentId === tournament.id) {
						await selectTournament(tournament.id);
					}
				} catch (error) {
					console.error(`[AUTO-CLOSE] Failed to end tournament #${tournament.id}:`, error);
				}
			}
		}
	}

	async function fetchTournaments() {
		try {
			tournaments = await magicBlockClient.fetchTournaments();

			// Filter to active list (exclude hidden, ended/settled)
			const active = tournaments.filter(t => {
				if (HIDDEN_TOURNAMENT_IDS.has(String(t.id))) return false;
				if (t.status === TournamentStatus.Ended || t.status === TournamentStatus.Settled) return false;
				return true;
			});
			// Auto-select: keep current if still in active list, else select first active/pending
			const currentStillActive = selectedTournamentId && active.some(t => t.id === selectedTournamentId);
			if (active.length > 0 && !currentStillActive) {
				const toSelect = active.find(t => t.status === TournamentStatus.Active || t.status === TournamentStatus.Pending) ||
					active[0];
				if (toSelect) await selectTournament(toSelect.id);
			} else if (active.length === 0) {
				selectedTournamentId = null;
				selectedTournament = null;
			}
		} catch (error) {
			console.error('Failed to fetch tournaments:', error);
		}
	}

	async function selectTournament(tournamentId: number) {
		try {
			selectedTournamentId = tournamentId;
			selectedTournament = await magicBlockClient.fetchTournamentById(tournamentId);

			if (connectedWallet?.connected) {
				participantData = await magicBlockClient.fetchTournamentParticipant(tournamentId);
				hasJoined = participantData !== null;
				console.log('[TOURNAMENT SELECT] Participant data:', participantData);
				console.log('[TOURNAMENT SELECT] Has joined:', hasJoined);
			}

			await fetchTournamentLeaderboard();
			console.log('[TOURNAMENT SELECT] Leaderboard:', leaderboard);
		} catch (error) {
			console.error('Failed to select tournament:', error);
		}
	}

	async function fetchTournamentLeaderboard() {
		if (!selectedTournamentId) return;

		try {
			const currentPrices: Record<string, number> = {};
			for (const [symbol, priceData] of Object.entries(prices)) {
				currentPrices[symbol] = priceData.price;
			}

			leaderboard = await magicBlockClient.fetchTournamentLeaderboard(selectedTournamentId, currentPrices);
		} catch (error) {
			console.error('Failed to fetch leaderboard:', error);
		}
	}

	async function createTournament() {
		if (!connectedWallet?.connected) {
			alert('Please connect your wallet first');
			return;
		}

		if (isProcessing) return;

		try {
			isProcessing = true;
			statusMessage = 'Creating tournament...';

			// Convert duration and cooldown to minutes based on selected unit
			const durationInMinutes = createForm.durationUnit === 'days'
				? createForm.durationMinutes * 1440
				: createForm.durationMinutes;
			const cooldownInMinutes = createForm.cooldownUnit === 'days'
				? createForm.cooldownMinutes * 1440
				: createForm.cooldownMinutes;

			const signature = await magicBlockClient.createTournament(
				createForm.tournamentId,
				createForm.entryFee,
				durationInMinutes,
				cooldownInMinutes
			);

			console.log('[CREATE] Tournament created, signature:', signature);
			statusMessage = `Tournament created! Refreshing...`;

			const createdTournamentId = createForm.tournamentId;
			showCreateModal = false;

			// Wait a bit for RPC to index the new account
			await new Promise(resolve => setTimeout(resolve, 2000));

			// Verify tournament was created
			const verifyTournament = await magicBlockClient.fetchTournamentById(createdTournamentId);
			console.log('[CREATE] Verification - tournament exists:', verifyTournament);

			// Reset form
			createForm.tournamentId = Math.floor(Date.now() / 1000);

			// Fetch all tournaments
			await fetchTournaments();

			if (verifyTournament) {
				// Auto-select the newly created tournament
				await selectTournament(createdTournamentId);
			}

			statusMessage = `Tournament #${createdTournamentId} created! ${signature.substring(0, 8)}...`;
		} catch (error: any) {
			console.error('Failed to create tournament:', error);
			statusMessage = `Create failed: ${error.message}`;
		} finally {
			isProcessing = false;
			setTimeout(() => statusMessage = '', 5000);
		}
	}

	async function enterTournament() {
		if (!connectedWallet?.connected || !selectedTournamentId) {
			alert('Please connect your wallet first');
			return;
		}

		if (isProcessing) return;

		try {
			isProcessing = true;
			statusMessage = 'Entering tournament...';

			const signature = await magicBlockClient.enterTournament(selectedTournamentId);

			statusMessage = `Entered tournament! ${signature.substring(0, 8)}...`;
			hasJoined = true;

			await refreshData();
		} catch (error: any) {
			console.error('Failed to enter tournament:', error);
			statusMessage = `Entry failed: ${error.message}`;
		} finally {
			isProcessing = false;
			setTimeout(() => statusMessage = '', 5000);
		}
	}

	async function startTournament() {
		if (!connectedWallet?.connected || !selectedTournamentId) {
			alert('Please connect your wallet first');
			return;
		}

		if (isProcessing) return;

		try {
			isProcessing = true;
			statusMessage = 'Starting tournament...';

			const signature = await magicBlockClient.startTournament(selectedTournamentId);

			statusMessage = `Tournament started! ${signature.substring(0, 8)}...`;

			await refreshData();
		} catch (error: any) {
			console.error('Failed to start tournament:', error);
			statusMessage = `Start failed: ${error.message}`;
		} finally {
			isProcessing = false;
			setTimeout(() => statusMessage = '', 5000);
		}
	}

	async function refreshData() {
		await fetchTournaments();
		if (selectedTournamentId) {
			await selectTournament(selectedTournamentId);
		}
	}

	async function fetchPrices() {
		try {
			const priceIds = {
				'SOL': ENV.PYTH_FEEDS.SOL,
				'BTC': ENV.PYTH_FEEDS.BTC,
				'ETH': ENV.PYTH_FEEDS.ETH,
				'AVAX': ENV.PYTH_FEEDS.AVAX,
				'LINK': ENV.PYTH_FEEDS.LINK
			};

			for (const [symbol, priceId] of Object.entries(priceIds)) {
				const response = await fetch(`${ENV.HERMES_URL}/v2/updates/price/latest?ids[]=${priceId}`);
				const data = await response.json();
				if (data.parsed && data.parsed[0]) {
					const priceData = data.parsed[0].price;
					const newPrice = parseFloat(priceData.price) * Math.pow(10, priceData.expo);
					prices[symbol].price = newPrice;
				}
			}
		} catch (error) {
			console.error('Failed to fetch prices:', error);
		}
	}

	function getStatusText(status: TournamentStatus): string {
		switch (status) {
			case TournamentStatus.Pending: return 'REGISTRATION';
			case TournamentStatus.Active: return 'LIVE';
			case TournamentStatus.Ended: return 'ENDED';
			case TournamentStatus.Settled: return 'SETTLED';
			default: return 'UNKNOWN';
		}
	}

	function getStatusClass(status: TournamentStatus): string {
		switch (status) {
			case TournamentStatus.Pending: return 'status-pending';
			case TournamentStatus.Active: return 'status-active';
			case TournamentStatus.Ended: return 'status-ended';
			case TournamentStatus.Settled: return 'status-settled';
			default: return '';
		}
	}

	function getTimeRemaining(tournament: Tournament): string {
		// Explicitly use currentTime to ensure Svelte tracks this dependency
		const now = currentTime;
		const targetTime = tournament.status === TournamentStatus.Pending
			? tournament.cooldownEnd.getTime()
			: tournament.endTime.getTime();

		const diff = targetTime - now;
		if (diff <= 0) return '00:00:00';

		const hours = Math.floor(diff / 3600000);
		const minutes = Math.floor((diff % 3600000) / 60000);
		const seconds = Math.floor((diff % 60000) / 1000);
		return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
	}

	function getTotalValue(): number {
		if (!participantData) return 0;
		return participantData.usdtBalance +
			participantData.solBalance * prices.SOL.price +
			participantData.btcBalance * prices.BTC.price +
			participantData.ethBalance * prices.ETH.price +
			participantData.avaxBalance * prices.AVAX.price +
			participantData.linkBalance * prices.LINK.price;
	}

	onMount(() => {
		console.log('[COMPETITION] Initializing competition page...');

		// Initial fetch
		fetchPrices();
		fetchTournaments();

		const priceInterval = setInterval(async () => {
			await fetchPrices();
			if (selectedTournamentId) {
				await fetchTournamentLeaderboard();
			}
		}, 5000);

		const dataInterval = setInterval(async () => {
			await refreshData();
		}, 10000); // Refresh every 10 seconds for more frequent updates

		// Update countdown every second
		const countdownInterval = setInterval(() => {
			currentTime = Date.now();
		}, 1000);

		return () => {
			clearInterval(priceInterval);
			clearInterval(dataInterval);
			clearInterval(countdownInterval);
		};
	});
</script>

<div class="bloomberg">
	<div class="command-bar">
		<a href="/" class="logo">BLOCKBERG</a>
		<div class="nav-links">
			<a href="/terminal" class="nav-link">TERMINAL</a>
			<a href="/competition" class="nav-link active">TOURNAMENTS</a>
		</div>
		<div class="status-bar">
			{#if selectedTournament}
				<span class="status-item">#{selectedTournament.id}</span>
				<span class="status-item {getStatusClass(selectedTournament.status)}">
					{getStatusText(selectedTournament.status)}
				</span>
				<span class="status-item">TIME: {timeDisplay}</span>
				<span class="status-item">POOL: {selectedTournament.prizePool.toFixed(2)} SOL</span>
				<span class="status-item">PLAYERS: {selectedTournament.participantCount}</span>
			{:else}
				<span class="status-item">NO TOURNAMENT SELECTED</span>
			{/if}
			{#if statusMessage}
				<span class="status-item status-message">{statusMessage}</span>
			{/if}
		</div>
		<div class="wallet-section">
			<WalletButton />
		</div>
	</div>

	<div class="main-content">
		<!-- Header with Create Button -->
		<div class="content-header">
			<div class="header-title">AVAILABLE TOURNAMENTS</div>
			{#if connectedWallet?.connected}
				<button class="create-tournament-btn" on:click={() => showCreateModal = true}>
					+ CREATE TOURNAMENT
				</button>
			{/if}
		</div>

		<!-- How it Works Section -->
		<div class="how-it-works">
			<button
				class="how-it-works-toggle"
				on:click={() => showHowItWorks = !showHowItWorks}
				aria-expanded={showHowItWorks}
			>
				<span class="toggle-icon">{showHowItWorks ? '▼' : '▶'}</span>
				HOW TOURNAMENTS WORK
			</button>
			{#if showHowItWorks}
				<div class="how-it-works-content">
					<div class="how-section">
						<h4>1. Registration Phase</h4>
						<p>When a tournament is created, it enters <strong>REGISTRATION</strong> status. During this phase, players can join by clicking "ENTER TOURNAMENT" and paying the entry fee (in SOL). Entry fees go to the prize pool.</p>
					</div>
					<div class="how-section">
						<h4>2. Cooldown Period</h4>
						<p>The <strong>cooldown</strong> is set when creating a tournament (e.g. 5 minutes or 1 day). It's the waiting period before the tournament can start. The countdown shows "STARTS IN" during registration. No one can start the tournament until the cooldown has fully elapsed.</p>
					</div>
					<div class="how-section">
						<h4>3. Starting the Tournament</h4>
						<p>Once the cooldown ends, <strong>anyone</strong> (including the creator) can click "START TOURNAMENT (Admin)" to begin. The tournament then moves to <strong>LIVE</strong> status and trading begins. All participants start with $10,000 USDT and can trade SOL, BTC, ETH, AVAX, and LINK.</p>
					</div>
					<div class="how-section">
						<h4>4. Live Trading</h4>
						<p>During the <strong>LIVE</strong> phase, the countdown shows "ENDS IN". Compete for the highest portfolio value. The leaderboard updates in real time.</p>
					</div>
					<div class="how-section">
						<h4>5. Ending & Prizes</h4>
						<p>When the duration ends, the tournament automatically closes. Prizes: <strong>1st</strong> 50%, <strong>2nd</strong> 30%, <strong>3rd</strong> 15%, <strong>Treasury</strong> 5%.</p>
					</div>
				</div>
			{/if}
		</div>

		<!-- Main Grid Layout -->
		<div class="tournament-grid">
			<!-- Tournament Cards (Active & Pending only - Ended/Settled show in Past section) -->
			<div class="tournaments-section">
				{#each activeTournaments as tournament (tournament.id)}
					<div
						class="tournament-card"
						class:selected={selectedTournamentId === tournament.id}
						on:click={() => selectTournament(tournament.id)}
					>
						<div class="card-header">
							<div class="tournament-id">TOURNAMENT #{tournament.id}</div>
							<div class="tournament-status {getStatusClass(tournament.status)}">
								{getStatusText(tournament.status)}
							</div>
						</div>
						<div class="card-body">
							<div class="card-stat">
								<span class="stat-label">ENTRY FEE</span>
								<span class="stat-value">{tournament.entryFee} SOL</span>
							</div>
							<div class="card-stat">
								<span class="stat-label">PRIZE POOL</span>
								<span class="stat-value green">{tournament.prizePool.toFixed(3)} SOL</span>
							</div>
							<div class="card-stat">
								<span class="stat-label">PARTICIPANTS</span>
								<span class="stat-value">{tournament.participantCount}</span>
							</div>
							<div class="card-stat">
								<span class="stat-label">{tournament.status === TournamentStatus.Pending ? 'STARTS IN' : 'ENDS IN'}</span>
								<span class="stat-value orange">{getTimeRemaining(tournament)}</span>
							</div>
						</div>
						{#if selectedTournamentId === tournament.id && connectedWallet?.connected}
							{@const userInLeaderboard = leaderboard.some(entry => entry.user === connectedWallet.publicKey?.toBase58())}
							{@const userJoined = hasJoined || userInLeaderboard || participantData !== null}

							{#if !userJoined && tournament.status === TournamentStatus.Pending}
								<button class="join-tournament-btn" on:click|stopPropagation={enterTournament} disabled={isProcessing}>
									{isProcessing ? 'ENTERING...' : 'ENTER TOURNAMENT'}
								</button>
							{/if}

							{#if userJoined}
								<div class="joined-badge">✓ JOINED</div>
								{#if tournament.status === TournamentStatus.Active}
									<button class="go-terminal-btn" on:click|stopPropagation={() => {
										tradingModeStore.setTournamentMode(tournament.id);
										goto('/terminal');
									}}>
										→ GO TO TERMINAL
									</button>
								{/if}
							{/if}
						{/if}
					</div>
				{:else}
					<div class="no-tournaments">
						<div class="empty-icon">◇</div>
						<p class="empty-title">NO TOURNAMENTS AVAILABLE</p>
						{#if connectedWallet?.connected}
							<p class="empty-hint">Create your first tournament to get started</p>
						{:else}
							<p class="empty-hint">Connect wallet to create a tournament</p>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Stats and Leaderboard -->
			<div class="info-section">
				{#if selectedTournament}
					<!-- Your Stats -->
					{#if hasJoined && participantData}
						<div class="stats-panel">
							<div class="panel-header">YOUR PORTFOLIO</div>
							<div class="stats-grid">
								<div class="stat-box">
									<div class="stat-label">TOTAL VALUE</div>
									<div class="stat-value large green">${getTotalValue().toLocaleString(undefined, {maximumFractionDigits: 2})}</div>
									<div class="stat-sublabel">P&L: {getTotalValue() > 10000 ? '+' : ''}${(getTotalValue() - 10000).toFixed(2)}</div>
								</div>
								<div class="stat-box">
									<div class="stat-label">POSITIONS</div>
									<div class="stat-value large">{participantData.totalPositions}</div>
								</div>
							</div>
							<div class="balances-grid">
								<div class="balance-item">
									<span>USDT</span>
									<span class="balance-value">${participantData.usdtBalance.toLocaleString()}</span>
								</div>
								<div class="balance-item">
									<span>SOL</span>
									<span class="balance-value">{participantData.solBalance.toFixed(4)}</span>
								</div>
								<div class="balance-item">
									<span>BTC</span>
									<span class="balance-value">{participantData.btcBalance.toFixed(6)}</span>
								</div>
								<div class="balance-item">
									<span>ETH</span>
									<span class="balance-value">{participantData.ethBalance.toFixed(4)}</span>
								</div>
								<div class="balance-item">
									<span>AVAX</span>
									<span class="balance-value">{participantData.avaxBalance.toFixed(2)}</span>
								</div>
								<div class="balance-item">
									<span>LINK</span>
									<span class="balance-value">{participantData.linkBalance.toFixed(2)}</span>
								</div>
							</div>
							<button class="trade-link" on:click={() => {
								if (selectedTournamentId) {
									tradingModeStore.setTournamentMode(selectedTournamentId);
									goto('/terminal');
								}
							}}>→ GO TO TERMINAL TO TRADE</button>
						</div>
					{/if}

					<!-- Leaderboard -->
					<div class="leaderboard-panel">
						<div class="panel-header">LIVE LEADERBOARD • TOP 10</div>
						<div class="leaderboard-table">
							<div class="table-header">
								<div class="col-rank">RNK</div>
								<div class="col-player">PLAYER</div>
								<div class="col-pnl">P&L</div>
								<div class="col-balance">BALANCE</div>
								<div class="col-trades">TRADES</div>
							</div>
							{#each leaderboard.slice(0, 10) as entry}
								<div class="table-row" class:highlight={entry.rank <= 3}>
									<div class="col-rank rank-{entry.rank}">{entry.rank}</div>
									<div class="col-player">{entry.address}</div>
									<div class="col-pnl" class:green={entry.pnl > 0} class:red={entry.pnl < 0}>
										{entry.pnl > 0 ? '+' : ''}${entry.pnl.toFixed(2)}
									</div>
									<div class="col-balance">${entry.balance.toLocaleString()}</div>
									<div class="col-trades">{entry.trades}</div>
								</div>
							{:else}
								<div class="no-data">No participants yet</div>
							{/each}
						</div>
					</div>

					<!-- Admin Actions -->
					{#if selectedTournament.status === TournamentStatus.Pending && connectedWallet?.connected}
						<button class="admin-btn" on:click={startTournament} disabled={isProcessing}>
							START TOURNAMENT (Admin)
						</button>
					{/if}
				{:else}
					<div class="no-selection">
						<div class="empty-icon">→</div>
						<p class="empty-title">SELECT A TOURNAMENT</p>
						<p class="empty-hint">Click on a tournament card to view details and leaderboard</p>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Past Tournaments Section -->
	<div class="past-tournaments-section">
		<div class="section-header">
			<div class="header-title">PAST TOURNAMENTS</div>
		</div>
		{#if pastTournaments.length > 0}
			<div class="past-tournaments-grid">
				{#each pastTournaments as tournament (tournament.id)}
					<div class="past-tournament-card">
						<div class="past-card-header">
							<div class="tournament-id">#{tournament.id}</div>
							<div class="tournament-status {getStatusClass(tournament.status)}">
								{getStatusText(tournament.status)}
							</div>
						</div>
						<div class="past-card-body">
							<div class="past-stat">
								<span class="stat-label">PRIZE POOL</span>
								<span class="stat-value">{tournament.prizePool.toFixed(3)} SOL</span>
							</div>
							<div class="past-stat">
								<span class="stat-label">PARTICIPANTS</span>
								<span class="stat-value">{tournament.participantCount}</span>
							</div>
							<div class="past-stat">
								<span class="stat-label">ENDED</span>
								<span class="stat-value">{new Date(tournament.endTime).toLocaleDateString()}</span>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="no-past-tournaments">
				<p class="empty-hint">No completed tournaments yet</p>
			</div>
		{/if}
	</div>

	<!-- Prize Distribution Footer -->
	<div class="prize-footer">
		<div class="prize-header">PRIZE DISTRIBUTION</div>
		<div class="prize-grid">
			<div class="prize-box gold">
				<div class="prize-rank">1ST</div>
				<div class="prize-percent">50%</div>
				<div class="prize-amount">{selectedTournament ? `${(selectedTournament.prizePool * 0.5).toFixed(3)} SOL` : '—'}</div>
			</div>
			<div class="prize-box silver">
				<div class="prize-rank">2ND</div>
				<div class="prize-percent">30%</div>
				<div class="prize-amount">{selectedTournament ? `${(selectedTournament.prizePool * 0.3).toFixed(3)} SOL` : '—'}</div>
			</div>
			<div class="prize-box bronze">
				<div class="prize-rank">3RD</div>
				<div class="prize-percent">15%</div>
				<div class="prize-amount">{selectedTournament ? `${(selectedTournament.prizePool * 0.15).toFixed(3)} SOL` : '—'}</div>
			</div>
			<div class="prize-box treasury">
				<div class="prize-rank">TREASURY</div>
				<div class="prize-percent">5%</div>
				<div class="prize-amount">{selectedTournament ? `${(selectedTournament.prizePool * 0.05).toFixed(3)} SOL` : '—'}</div>
			</div>
		</div>
		<div class="prize-info">
			All participants start with $10,000 USDT • Trade SOL, BTC, ETH, AVAX, LINK • Top 3 win prizes
		</div>
	</div>
</div>

<!-- Create Tournament Modal -->
{#if showCreateModal}
	<div class="modal-overlay" on:click={() => showCreateModal = false}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>CREATE TOURNAMENT</h2>
				<button class="modal-close" on:click={() => showCreateModal = false}>×</button>
			</div>
			<div class="modal-body">
				<div class="form-group">
					<label>TOURNAMENT ID</label>
					<input type="number" bind:value={createForm.tournamentId} />
					<span class="form-hint">Unique identifier for this tournament</span>
				</div>
				<div class="form-group">
					<label>ENTRY FEE (SOL)</label>
					<input type="number" step="0.01" bind:value={createForm.entryFee} />
					<span class="form-hint">Minimum: 0.01 SOL</span>
				</div>
				<div class="form-group">
					<label>DURATION</label>
					<div class="input-group">
						<input type="number" bind:value={createForm.durationMinutes} />
						<select bind:value={createForm.durationUnit}>
							<option value="minutes">Minutes</option>
							<option value="days">Days</option>
						</select>
					</div>
					<span class="form-hint">How long the tournament lasts (min: 5 min)</span>
				</div>
				<div class="form-group">
					<label>REGISTRATION PERIOD</label>
					<div class="input-group">
						<input type="number" bind:value={createForm.cooldownMinutes} />
						<select bind:value={createForm.cooldownUnit}>
							<option value="minutes">Minutes</option>
							<option value="days">Days</option>
						</select>
					</div>
					<span class="form-hint">Time before tournament starts (min: 1 min)</span>
				</div>
			</div>
			<div class="modal-footer">
				<button class="modal-cancel" on:click={() => showCreateModal = false}>CANCEL</button>
				<button class="modal-submit" on:click={createTournament} disabled={isProcessing}>
					{isProcessing ? 'CREATING...' : 'CREATE TOURNAMENT'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.bloomberg {
		min-height: 100vh;
		background: #000;
		color: #fff;
		font-family: 'Courier New', monospace;
		display: flex;
		flex-direction: column;
	}

	.command-bar {
		background: #1a1a1a;
		padding: 8px 15px;
		display: flex;
		align-items: center;
		gap: 15px;
		border-bottom: 1px solid #333;
	}

	.logo {
		font-size: 18px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 2px;
		text-decoration: none;
	}

	.nav-links {
		display: flex;
		gap: 15px;
	}

	.nav-link {
		color: #666;
		text-decoration: none;
		font-size: 13px;
		padding: 4px 10px;
		border: 1px solid transparent;
		transition: all 0.2s;
	}

	.nav-link:hover {
		color: #fff;
		border-color: #333;
	}

	.nav-link.active {
		color: #ff9500;
		border-color: #ff9500;
	}

	.status-bar {
		display: flex;
		gap: 12px;
		margin-left: auto;
		font-size: 11px;
		flex-wrap: wrap;
	}

	.status-item {
		color: #ff9500;
		padding: 3px 8px;
		background: #000;
		border: 1px solid #333;
		white-space: nowrap;
	}

	.status-pending { background: #ff9500; color: #000; }
	.status-active { background: #00ff00; color: #000; }
	.status-ended { background: #ff0000; color: #fff; }
	.status-settled { background: #666; color: #fff; }

	.status-message {
		background: #1a1a00;
		color: #ffaa00;
	}

	.wallet-section {
		display: flex;
		align-items: center;
	}

	.main-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.content-header {
		background: #1a1a1a;
		padding: 12px 20px;
		border-bottom: 2px solid #ff9500;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.header-title {
		font-size: 14px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 2px;
	}

	.create-tournament-btn {
		background: #00ff00;
		color: #000;
		border: none;
		padding: 8px 16px;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		font-weight: bold;
		cursor: pointer;
		letter-spacing: 1px;
		transition: all 0.2s;
	}

	.create-tournament-btn:hover {
		background: #33ff33;
		transform: scale(1.05);
	}

	/* How it Works Section */
	.how-it-works {
		margin-bottom: 20px;
		border: 1px solid #333;
		background: #0a0a0a;
	}

	.how-it-works-toggle {
		width: 100%;
		padding: 12px 15px;
		background: transparent;
		border: none;
		color: #ff9500;
		font-size: 12px;
		font-weight: bold;
		letter-spacing: 1px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 10px;
		font-family: 'Courier New', monospace;
		transition: background 0.2s;
	}

	.how-it-works-toggle:hover {
		background: #111;
	}

	.toggle-icon {
		font-size: 10px;
		color: #666;
	}

	.how-it-works-content {
		padding: 15px 20px 20px;
		border-top: 1px solid #222;
	}

	.how-section {
		margin-bottom: 16px;
	}

	.how-section:last-child {
		margin-bottom: 0;
	}

	.how-section h4 {
		color: #ff9500;
		font-size: 11px;
		font-weight: bold;
		letter-spacing: 1px;
		margin: 0 0 8px 0;
	}

	.how-section p {
		color: #999;
		font-size: 11px;
		line-height: 1.6;
		margin: 0;
	}

	.how-section p strong {
		color: #ccc;
	}

	.tournament-grid {
		display: grid;
		grid-template-columns: 1fr 400px;
		gap: 1px;
		background: #111;
		flex: 1;
		overflow: hidden;
	}

	.tournaments-section {
		background: #000;
		padding: 20px;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 15px;
		align-content: start;
	}

	.tournament-card {
		background: #0a0a0a;
		border: 2px solid #222;
		padding: 15px;
		cursor: pointer;
		transition: all 0.3s;
		position: relative;
	}

	.tournament-card:hover {
		border-color: #ff9500;
		background: #111;
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(255, 149, 0, 0.2);
	}

	.tournament-card.selected {
		border-color: #ff9500;
		background: #1a1a00;
		box-shadow: 0 0 20px rgba(255, 149, 0, 0.3);
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 15px;
		padding-bottom: 10px;
		border-bottom: 1px solid #333;
	}

	.tournament-id {
		font-size: 13px;
		font-weight: bold;
		color: #ff9500;
	}

	.tournament-status {
		font-size: 9px;
		padding: 3px 8px;
		font-weight: bold;
	}

	.card-body {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-bottom: 12px;
	}

	.card-stat {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.stat-label {
		font-size: 9px;
		color: #666;
	}

	.stat-value {
		font-size: 13px;
		color: #fff;
		font-weight: bold;
	}

	.stat-value.green { color: #00ff00; }
	.stat-value.orange { color: #ff9500; }

	.join-tournament-btn {
		width: 100%;
		background: #00ff00;
		color: #000;
		border: none;
		padding: 10px;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		font-weight: bold;
		cursor: pointer;
		margin-top: 8px;
		transition: all 0.2s;
	}

	.join-tournament-btn:hover:not(:disabled) {
		background: #33ff33;
	}

	.join-tournament-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.joined-badge {
		background: #00ff00;
		color: #000;
		text-align: center;
		padding: 8px;
		font-size: 11px;
		font-weight: bold;
		margin-top: 8px;
	}

	.go-terminal-btn {
		width: 100%;
		background: #ff9500;
		color: #000;
		border: none;
		padding: 10px;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		font-weight: bold;
		cursor: pointer;
		margin-top: 8px;
		transition: all 0.2s;
	}

	.go-terminal-btn:hover {
		background: #ffaa33;
		transform: translateX(2px);
	}

	.no-tournaments {
		grid-column: 1 / -1;
		text-align: center;
		padding: 80px 20px;
		background: linear-gradient(180deg, #000 0%, #0a0a0a 100%);
		border: 1px dashed #333;
		margin: 20px;
	}

	.empty-icon {
		font-size: 48px;
		color: #333;
		margin-bottom: 20px;
		opacity: 0.5;
	}

	.empty-title {
		color: #ff9500;
		font-size: 14px;
		font-weight: bold;
		letter-spacing: 2px;
		margin-bottom: 12px;
	}

	.empty-hint {
		font-size: 11px;
		color: #666;
		margin: 0;
	}

	.info-section {
		background: #000;
		overflow-y: auto;
		overflow-x: hidden;
		display: flex;
		flex-direction: column;
		gap: 1px;
		max-width: 400px;
		width: 100%;
	}

	.stats-panel {
		background: #0a0a0a;
		border-left: 1px solid #333;
		overflow-x: hidden;
		max-width: 100%;
	}

	.panel-header {
		background: #1a1a1a;
		padding: 10px 15px;
		border-bottom: 2px solid #ff9500;
		font-size: 11px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 1px;
	}

	.stats-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1px;
		background: #111;
		margin: 1px;
	}

	.stat-box {
		background: #000;
		padding: 15px;
		text-align: center;
	}

	.stat-label {
		font-size: 9px;
		color: #666;
		margin-bottom: 6px;
	}

	.stat-value {
		font-size: 16px;
		color: #fff;
		font-weight: bold;
	}

	.stat-value.large {
		font-size: 20px;
	}

	.stat-sublabel {
		font-size: 10px;
		color: #999;
		margin-top: 4px;
	}

	.balances-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1px;
		background: #111;
		margin: 1px;
	}

	.balance-item {
		background: #000;
		padding: 10px 15px;
		display: flex;
		justify-content: space-between;
		font-size: 11px;
	}

	.balance-item span:first-child {
		color: #666;
	}

	.balance-value {
		color: #fff;
		font-weight: bold;
	}

	.trade-link {
		display: block;
		width: 100%;
		text-align: center;
		padding: 12px;
		background: #1a1a00;
		color: #ff9500;
		text-decoration: none;
		font-size: 11px;
		font-weight: bold;
		border: none;
		border-top: 1px solid #333;
		font-family: 'Courier New', monospace;
		cursor: pointer;
		transition: all 0.2s;
	}

	.trade-link:hover {
		background: #2a2a00;
	}

	.leaderboard-panel {
		background: #0a0a0a;
		border-left: 1px solid #333;
		flex: 1;
		overflow-x: hidden;
		max-width: 100%;
	}

	.leaderboard-table {
		font-size: 11px;
	}

	.table-header {
		display: grid;
		grid-template-columns: 40px 100px 90px 100px 60px;
		gap: 8px;
		padding: 8px 12px;
		background: #1a1a1a;
		color: #666;
		font-weight: bold;
		border-bottom: 1px solid #ff9500;
	}

	.table-row {
		display: grid;
		grid-template-columns: 40px 100px 90px 100px 60px;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid #111;
		transition: background 0.2s;
	}

	.table-row:hover {
		background: #0f0f0f;
	}

	.table-row.highlight {
		background: #1a1a00;
	}

	.col-rank {
		color: #ff9500;
		font-weight: bold;
	}

	.col-rank.rank-1 { color: #ffaa00; }
	.col-rank.rank-2 { color: #aaa; }
	.col-rank.rank-3 { color: #cd7f32; }

	.col-player {
		color: #00ccff;
	}

	.green { color: #00ff00; }
	.red { color: #ff0000; }

	.no-data {
		padding: 40px 20px;
		text-align: center;
		color: #666;
		font-size: 11px;
	}

	.no-selection {
		padding: 80px 20px;
		text-align: center;
		background: linear-gradient(180deg, #000 0%, #0a0a0a 100%);
		border: 1px dashed #333;
		margin: 20px;
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}

	.no-selection .empty-icon {
		font-size: 48px;
		color: #333;
		margin-bottom: 20px;
		opacity: 0.5;
	}

	.no-selection .empty-title {
		color: #ff9500;
		font-size: 14px;
		font-weight: bold;
		letter-spacing: 2px;
		margin-bottom: 12px;
	}

	.no-selection .empty-hint {
		font-size: 11px;
		color: #666;
		margin: 0;
	}

	.admin-btn {
		width: calc(100% - 2px);
		margin: 1px;
		background: #333;
		color: #fff;
		border: 1px solid #666;
		padding: 10px;
		font-family: 'Courier New', monospace;
		font-size: 10px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.admin-btn:hover:not(:disabled) {
		background: #444;
	}

	/* Past Tournaments Section */
	.past-tournaments-section {
		background: #000;
		padding: 20px;
		border-top: 1px solid #333;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 10px;
	}

	.section-header .header-title {
		font-size: 14px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 2px;
	}

	.past-tournaments-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 12px;
		margin-top: 15px;
	}

	.past-tournament-card {
		background: #0a0a0a;
		border: 1px solid #333;
		padding: 12px;
		transition: all 0.2s;
	}

	.past-tournament-card:hover {
		border-color: #666;
		background: #111;
	}

	.past-card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 10px;
		padding-bottom: 8px;
		border-bottom: 1px solid #222;
	}

	.past-card-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.past-stat {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 10px;
	}

	.past-stat .stat-label {
		color: #666;
	}

	.past-stat .stat-value {
		color: #ff9500;
		font-weight: bold;
	}

	.no-past-tournaments {
		text-align: center;
		padding: 40px 20px;
		color: #666;
		font-size: 11px;
	}

	.prize-footer {
		background: #0a0a0a;
		border-top: 2px solid #ff9500;
		padding: 15px 20px;
	}

	.prize-header {
		font-size: 11px;
		font-weight: bold;
		color: #ff9500;
		letter-spacing: 1px;
		margin-bottom: 12px;
	}

	.prize-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 10px;
		margin-bottom: 10px;
	}

	.prize-box {
		background: #000;
		border: 1px solid #333;
		padding: 12px;
		text-align: center;
	}

	.prize-rank {
		font-size: 10px;
		font-weight: bold;
		margin-bottom: 6px;
	}

	.prize-box.gold .prize-rank { color: #ffaa00; }
	.prize-box.silver .prize-rank { color: #aaa; }
	.prize-box.bronze .prize-rank { color: #cd7f32; }
	.prize-box.treasury .prize-rank { color: #666; }

	.prize-percent {
		font-size: 16px;
		font-weight: bold;
		color: #fff;
		margin-bottom: 4px;
	}

	.prize-amount {
		font-size: 11px;
		color: #999;
	}

	.prize-info {
		text-align: center;
		font-size: 9px;
		color: #666;
		padding-top: 10px;
		border-top: 1px solid #222;
	}

	/* Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal-content {
		background: #1a1a1a;
		border: 2px solid #ff9500;
		width: 90%;
		max-width: 500px;
		box-shadow: 0 0 40px rgba(255, 149, 0, 0.3);
	}

	.modal-header {
		background: #000;
		padding: 15px 20px;
		border-bottom: 2px solid #ff9500;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.modal-header h2 {
		color: #ff9500;
		font-size: 14px;
		letter-spacing: 2px;
		margin: 0;
	}

	.modal-close {
		background: none;
		border: none;
		color: #fff;
		font-size: 24px;
		cursor: pointer;
		padding: 0;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.modal-close:hover {
		color: #ff9500;
	}

	.modal-body {
		padding: 20px;
	}

	.form-group {
		margin-bottom: 20px;
	}

	.form-group label {
		display: block;
		color: #ff9500;
		font-size: 10px;
		margin-bottom: 6px;
		letter-spacing: 1px;
	}

	.form-group input {
		width: 100%;
		background: #000;
		border: 1px solid #333;
		color: #fff;
		padding: 10px;
		font-family: 'Courier New', monospace;
		font-size: 13px;
	}

	.form-group input:focus {
		outline: none;
		border-color: #ff9500;
	}

	.form-hint {
		display: block;
		color: #666;
		font-size: 9px;
		margin-top: 4px;
	}

	.input-group {
		display: flex;
		gap: 8px;
	}

	.input-group input {
		flex: 1;
		min-width: 0;
	}

	.input-group select {
		background: #000;
		border: 1px solid #333;
		color: #ff9500;
		padding: 10px;
		font-family: 'Courier New', monospace;
		font-size: 13px;
		cursor: pointer;
		min-width: 110px;
	}

	.input-group select:focus {
		outline: none;
		border-color: #ff9500;
	}

	.input-group select option {
		background: #000;
		color: #fff;
	}

	.modal-footer {
		background: #000;
		padding: 15px 20px;
		border-top: 1px solid #333;
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}

	.modal-cancel {
		background: #333;
		color: #fff;
		border: 1px solid #666;
		padding: 10px 20px;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		cursor: pointer;
	}

	.modal-cancel:hover {
		background: #444;
	}

	.modal-submit {
		background: #00ff00;
		color: #000;
		border: none;
		padding: 10px 20px;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		font-weight: bold;
		cursor: pointer;
	}

	.modal-submit:hover:not(:disabled) {
		background: #33ff33;
	}

	.modal-submit:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
