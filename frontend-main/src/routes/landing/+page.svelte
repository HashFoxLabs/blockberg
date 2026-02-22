<script lang="ts">
	import logo from '$lib/assets/Logo_Blockberk.png';
	import iconConnectWallet from '$lib/assets/Icon_connect_your_wallet-removebg-preview.png';
	import iconMoneybag from '$lib/assets/moneybag-removebg-preview.png';
	import iconUptrend from '$lib/assets/uptrend-price-line-removebg-preview.png';
	import iconTrophy from '$lib/assets/trophey-removebg-preview.png';
	import { supabase } from '$lib/supabase';
	import { convertCommentFromDB, type TradeComment, type TradeCommentDB } from '$lib/types';
	import { walletStore } from '$lib/wallet/stores';
	import WalletButton from '$lib/wallet/WalletButton.svelte';
	import type { PageData } from './$types';
	import { onMount } from 'svelte';
	import { magicBlockClient, TournamentStatus, type Tournament } from '$lib/magicblock';
	import { goto } from '$app/navigation';

	// Get data from the load function
	let { data }: { data: PageData } = $props();
	
	// Trade posts from database
	let tradePosts = $state(data.tradePosts);

	// Wallet state
	let userId = $state('');
	let walletConnected = $state(false);
	let likedPosts = $state(new Set<string>());

	// Comments modal state
	let showCommentsModal = $state(false);
	let selectedPostId = $state<string | null>(null);
	let comments = $state<TradeComment[]>([]);
	let newCommentText = $state('');
	let isLoadingComments = $state(false);
	let isPostingComment = $state(false);

	// Competitions state
	let upcomingCompetitions = $state<Tournament[]>([]);
	let isLoadingCompetitions = $state(true);

	// Subscribe to wallet changes
	walletStore.subscribe(wallet => {
		if (wallet.connected && wallet.publicKey) {
			userId = wallet.publicKey.toBase58();
			walletConnected = true;
			fetchUserLikes();
		} else {
			userId = '';
			walletConnected = false;
			likedPosts = new Set();
		}
	});

	// Fetch upcoming competitions on mount
	onMount(() => {
		fetchCompetitions();
	});

	async function fetchCompetitions() {
		try {
			isLoadingCompetitions = true;
			const allTournaments = await magicBlockClient.fetchTournaments();
			// Filter for tournaments with at least 1 participant (not Settled)
			upcomingCompetitions = allTournaments.filter(t => 
				t.participantCount >= 1 && t.status !== TournamentStatus.Settled
			).slice(0, 3); // Limit to 3 competitions
		} catch (error) {
			console.error('Failed to fetch competitions:', error);
			upcomingCompetitions = [];
		} finally {
			isLoadingCompetitions = false;
		}
	}

	function formatDate(date: Date): string {
		return date.toLocaleDateString('en-US', { 
			month: 'short', 
			day: 'numeric', 
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function getCompetitionStatus(competition: Tournament): string {
		if (competition.status === TournamentStatus.Pending) {
			return 'Registration Open';
		} else if (competition.status === TournamentStatus.Active) {
			return 'Live Now';
		} else if (competition.status === TournamentStatus.Ended) {
			return 'Ended';
		}
		return 'Upcoming';
	}

	async function fetchUserLikes() {
		if (!supabase || !userId) return;
		
		try {
			const { data, error } = await supabase
				.from('trade_likes')
				.select('trade_post_id')
				.eq('liker_pubkey', userId);
			
			if (!error && data) {
				likedPosts = new Set(data.map(like => like.trade_post_id));
			}
		} catch (error) {
			console.error('Error fetching user likes:', error);
		}
	}

	async function toggleLike(postId: string) {
		if (!walletConnected) {
			alert('Please connect your wallet to like posts');
			return;
		}
		
		if (!supabase || !userId) {
			console.error('Supabase not configured or user ID missing');
			return;
		}

		const isLiked = likedPosts.has(postId);
		
		try {
			if (isLiked) {
				// Unlike: Remove from database
				const { error } = await supabase
					.from('trade_likes')
					.delete()
					.eq('trade_post_id', postId)
					.eq('liker_pubkey', userId);
				
				if (!error) {
					// Update local state
					likedPosts.delete(postId);
					// Update post likes count
					tradePosts = tradePosts.map(post => 
						post.id === postId ? { ...post, likes: post.likes - 1 } : post
					);
				} else {
					console.error('Error unliking post:', error);
				}
			} else {
				// Like: Add to database
				const { error } = await supabase
					.from('trade_likes')
					.insert({
						trade_post_id: postId,
						liker_pubkey: userId,
						liker_username: null
					});
				
				if (!error) {
					// Update local state
					likedPosts.add(postId);
					// Update post likes count
					tradePosts = tradePosts.map(post => 
						post.id === postId ? { ...post, likes: post.likes + 1 } : post
					);
				} else {
					console.error('Error liking post:', error);
				}
			}
		} catch (error) {
			console.error('Error toggling like:', error);
		}
	}

	// Comments functions
	async function openCommentsModal(postId: string) {
		selectedPostId = postId;
		showCommentsModal = true;
		newCommentText = '';
		await fetchComments(postId);
	}

	function closeCommentsModal() {
		showCommentsModal = false;
		selectedPostId = null;
		comments = [];
		newCommentText = '';
	}

	async function fetchComments(postId: string) {
		if (!supabase) return;
		
		isLoadingComments = true;
		try {
			const { data, error } = await supabase
				.from('trade_comments')
				.select('*')
				.eq('trade_post_id', postId)
				.order('created_at', { ascending: false });
			
			if (!error && data) {
				comments = (data as TradeCommentDB[]).map(convertCommentFromDB);
			} else if (error) {
				console.error('Error fetching comments:', error);
			}
		} catch (error) {
			console.error('Error fetching comments:', error);
		} finally {
			isLoadingComments = false;
		}
	}

	async function postComment() {
		if (!walletConnected) {
			alert('Please connect your wallet to post comments');
			return;
		}
		
		if (!supabase || !userId || !selectedPostId || !newCommentText.trim()) {
			return;
		}

		isPostingComment = true;
		try {
			const { error } = await supabase
				.from('trade_comments')
				.insert({
					trade_post_id: selectedPostId,
					author_pubkey: userId,
					author_username: null,
					content: newCommentText.trim()
				});
			
			if (!error) {
				// Refresh comments
				await fetchComments(selectedPostId);
				// Update post comments count
				tradePosts = tradePosts.map(post => 
					post.id === selectedPostId ? { ...post, comments: post.comments + 1 } : post
				);
				// Clear input
				newCommentText = '';
			} else {
				console.error('Error posting comment:', error);
			}
		} catch (error) {
			console.error('Error posting comment:', error);
		} finally {
			isPostingComment = false;
		}
	}

	let selectedCategory = $state('all'); // 'all', 'long', 'short'
	let selectedPair = $state('all'); // 'all', 'SOL/USDT', 'BTC/USDT', etc.
	let sortBy = $state('date'); // 'date', 'entry', 'exit', 'pnl', 'likes', 'comments'

	function filterPosts(category: string) {
		selectedCategory = category;
	}

	function filterByPair(pair: string) {
		selectedPair = pair;
	}

	function setSortBy(sort: string) {
		sortBy = sort;
	}

	// Calculate P&L based on entry, exit, and direction
	function calculatePnL(entry: number, exit: number, direction: string): number {
		if (direction === 'LONG') {
			return ((exit - entry) / entry) * 100;
		} else {
			return ((entry - exit) / entry) * 100;
		}
	}

	// Get unique pairs from trade posts
	let uniquePairs = $derived([...new Set(tradePosts.map(post => post.symbol))]);

	// Filter and sort trade posts
	let filteredPosts = $derived.by(() => {
		let filtered = tradePosts;
		
		// Filter by direction
		if (selectedCategory !== 'all') {
			filtered = filtered.filter(post => post.direction === selectedCategory.toUpperCase());
		}
		
		// Filter by pair
		if (selectedPair !== 'all') {
			filtered = filtered.filter(post => post.symbol === selectedPair);
		}
		
		// Sort
		filtered = [...filtered].sort((a, b) => {
			if (sortBy === 'date') {
				// Default: most recent first (by ID or creation order)
				return 0; // Keep original order from database (already sorted by closed_at DESC)
			} else if (sortBy === 'entry') {
				return b.entry - a.entry;
			} else if (sortBy === 'exit') {
				return b.exit - a.exit;
			} else if (sortBy === 'pnl') {
				const pnlA = calculatePnL(a.entry, a.exit, a.direction);
				const pnlB = calculatePnL(b.entry, b.exit, b.direction);
				return pnlB - pnlA;
			} else if (sortBy === 'likes') {
				return b.likes - a.likes;
			} else if (sortBy === 'comments') {
				return b.comments - a.comments;
			}
			return 0;
		});
		
		return filtered;
	});

</script>

<div class="landing-container">
	<!-- Navigation -->
	<nav class="navbar">
		<div class="nav-content">
			<div class="logo">
				<img src={logo} alt="Blockberg" class="logo-icon" />
				<span class="logo-text">BLOCKBERG</span>
			</div>
			<div class="nav-links">
				<a href="/landing" class="nav-link active">Home</a>
				<a href="#trading" class="nav-link">Trading</a>
				<a href="#competitions" class="nav-link">Competition</a>
				<a href="/" class="nav-link">Terminal</a>
				<a href="/dashboard" class="nav-link">Dashboard</a>
			</div>
			<div class="nav-wallet">
				<WalletButton />
			</div>
		</div>
	</nav>

	<!-- Hero Section -->
	<section class="hero">
		<div class="hero-content">
			<h1 class="hero-title">
				Master Paper Trading<br/>
				<span class="gradient-text">Without the Risk</span>
			</h1>
			<p class="hero-description">
				Practice trading strategies, compete with others, and learn from the community's best trades—all without risking real capital.
			</p>
			<div class="hero-buttons">
				<a href="/" class="cta-button primary">Start Trading</a>
				<a href="#trading" class="cta-button secondary">Learn More</a>
			</div>
		</div>
	</section>

	<!-- Trade Posts Section (Homepage) -->
	<section id="homepage" class="trade-posts-section">
		<div class="section-content">
			<div class="section-header">
				<h2 class="section-title">Latest Trade Ideas</h2>
				<p class="section-subtitle">Learn from the community's trading strategies and analysis</p>
			</div>

			<div class="controls-container">
				<div class="filter-buttons">
					<button 
						class="filter-btn {selectedCategory === 'all' ? 'active' : ''}"
						onclick={() => filterPosts('all')}
					>
						All Trades
					</button>
					<button 
						class="filter-btn {selectedCategory === 'long' ? 'active' : ''}"
						onclick={() => filterPosts('long')}
					>
						🟢 Long Positions
					</button>
					<button 
						class="filter-btn {selectedCategory === 'short' ? 'active' : ''}"
						onclick={() => filterPosts('short')}
					>
						🔴 Short Positions
					</button>
				</div>

				<div class="filter-sort-row">
					<div class="filter-group">
						<label class="filter-label">Filter by Pair:</label>
						<select class="select-dropdown" bind:value={selectedPair} onchange={() => filterByPair(selectedPair)}>
							<option value="all">All Pairs</option>
							{#each uniquePairs as pair}
								<option value={pair}>{pair}</option>
							{/each}
						</select>
					</div>

					<div class="filter-group">
						<label class="filter-label">Sort by:</label>
						<select class="select-dropdown" bind:value={sortBy} onchange={() => setSortBy(sortBy)}>
							<option value="date">Date (Most Recent)</option>
							<option value="entry">Entry Price (High to Low)</option>
							<option value="exit">Exit Price (High to Low)</option>
							<option value="pnl">P&L (High to Low)</option>
							<option value="likes">Likes (High to Low)</option>
							<option value="comments">Comments (High to Low)</option>
						</select>
					</div>
				</div>
			</div>

			<div class="posts-grid">
				{#each filteredPosts as post}
				{@const pnl = calculatePnL(post.entry, post.exit, post.direction)}
					<div class="trade-post">
						<div class="post-header">
							<div class="post-author">
								<div class="author-info">
									<div class="author-name">{post.author}</div>
						</div>
					</div>
					<div class="post-direction {post.direction.toLowerCase()}">
						{post.direction}
					</div>
				</div>

				<div class="post-symbol">{post.symbol}</div>

				<div class="post-prices">
					<div class="price-item">
						<span class="price-label">Entry Price:</span>
						<span class="price-value">${post.entry.toLocaleString()}</span>
						<span class="price-timestamp">{post.entryTimestamp}</span>
					</div>
					<div class="price-item">
						<span class="price-label">Exit Price:</span>
						<span class="price-value">${post.exit.toLocaleString()}</span>
						<span class="price-timestamp">{post.exitTimestamp}</span>
					</div>
					<div class="price-item">
						<span class="price-label">P&L:</span>
						<span class="price-value {pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">
							{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%
						</span>
					</div>
				</div>

						<div class="post-analysis">
							{post.analysis}
						</div>

						<div class="post-footer">
						<button 
							class="action-btn like-btn {likedPosts.has(post.id) ? 'liked' : ''}"
							onclick={() => toggleLike(post.id)}
						>
							<span>{likedPosts.has(post.id) ? '❤️' : '🤍'}</span> {post.likes}
						</button>
						<button 
							class="action-btn comment-btn"
							onclick={() => openCommentsModal(post.id)}
						>
							<span>💬</span> {post.comments}
						</button>
					</div>
					</div>
				{/each}
			</div>

			<div class="view-more">
				<a href="/" class="view-more-link">
					Start Your Own Trades →
				</a>
			</div>
		</div>
	</section>

	<!-- Trading Explanation Section -->
	<section id="trading" class="trading-section">
		<div class="section-content">
			<div class="section-header">
				<h2 class="section-title">How to Paper Trade on <span style="color: #ff9500;">BLOCKBERG</span></h2>
				<p class="section-subtitle">Follow these steps and start trading without risk</p>
			</div>

			<div class="trading-grid">
				<!-- Step 1 -->
				<div class="trading-card">
					<div class="card-number">01</div>
				<div class="card-icon"><img src={iconConnectWallet} alt="Connect Wallet" /></div>
					<h3 class="card-title">Connect Your Wallet</h3>
					<p class="card-description">
						Connect your Solana wallet to get started. We'll provide you with virtual tokens to trade with—no real funds needed.
					</p>
				</div>

				<!-- Step 2 -->
				<div class="trading-card">
					<div class="card-number">02</div>
				<div class="card-icon"><img src={iconMoneybag} alt="Virtual Capital" /></div>
					<h3 class="card-title">Get Virtual Capital</h3>
					<p class="card-description">
						Start with $10,000 in virtual capital across multiple trading pairs: SOL, BTC, ETH, AVAX, and LINK.
					</p>
				</div>

				<!-- Step 3 -->
				<div class="trading-card">
					<div class="card-number">03</div>
				<div class="card-icon"><img src={iconUptrend} alt="Open Positions" /></div>
					<h3 class="card-title">Open Positions</h3>
					<p class="card-description">
						Go long or short on real-time market prices from Pyth Network. Practice your strategies with live market data.
					</p>
				</div>

				<!-- Step 4 -->
				<div class="trading-card">
					<div class="card-number">04</div>
				<div class="card-icon"><img src={iconTrophy} alt="Track & Compete" /></div>
					<h3 class="card-title">Track & Compete</h3>
					<p class="card-description">
						Monitor your P&L in real-time, join competitions, and climb the leaderboard to prove your trading skills.
					</p>
				</div>
			</div>

			<!-- Competitions Section -->
			<div id="competitions" class="competitions-section">
				<h3 class="section-subtitle competitions-title">Latest Upcoming Competitions</h3>
				<p class="competitions-description">Join live competitions and compete with traders worldwide</p>
				
				{#if isLoadingCompetitions}
					<div class="competitions-loading">
						<p>Loading competitions...</p>
					</div>
				{:else if upcomingCompetitions.length === 0}
					<div class="competitions-empty">
						<p>No upcoming competitions at the moment. Check back soon!</p>
						<a href="/competition" class="view-all-btn">View All Competitions</a>
					</div>
				{:else}
					<div class="competitions-grid">
						{#each upcomingCompetitions as competition}
							<div class="competition-card">
								<div class="competition-status {competition.status === TournamentStatus.Active ? 'live' : competition.status === TournamentStatus.Ended ? 'ended' : 'pending'}">
									{getCompetitionStatus(competition)}
								</div>
								<h4 class="competition-title">Competition #{competition.id}</h4>
								<div class="competition-details">
									<div class="detail-item">
										<span class="detail-label">Prize Pool</span>
										<span class="detail-value">{competition.prizePool.toFixed(2)} SOL</span>
									</div>
									<div class="detail-item">
										<span class="detail-label">Entry Fee</span>
										<span class="detail-value">{competition.entryFee.toFixed(2)} SOL</span>
									</div>
									<div class="detail-item">
										<span class="detail-label">Participants</span>
										<span class="detail-value">{competition.participantCount}</span>
									</div>
									<div class="detail-item">
										<span class="detail-label">Ends</span>
										<span class="detail-value">{formatDate(competition.endTime)}</span>
									</div>
								</div>
								<button 
									class="join-competition-btn"
									onclick={() => goto('/competition')}
								>
									{competition.status === TournamentStatus.Active ? 'Join Now' : 'View Details'}
								</button>
							</div>
						{/each}
					</div>
					<div class="view-all-competitions">
						<a href="/competition" class="view-all-btn">View All Competitions →</a>
					</div>
				{/if}
			</div>

			<!-- Features -->
			<div class="features-section">
				<h3 class="features-title">Platform Features</h3>
				<div class="features-grid">
					<div class="feature">
					<div class="feature-text">
						<h4>Real-Time Prices</h4>
						<p>Live market data from Pyth Network oracle</p>
					</div>
				</div>
				<div class="feature">
					<div class="feature-text">
						<h4>Risk Management</h4>
						<p>Set take-profit and stop-loss levels</p>
					</div>
				</div>
				<div class="feature">
					<div class="feature-text">
						<h4>Portfolio Tracking</h4>
						<p>Monitor all positions and performance</p>
					</div>
				</div>
				<div class="feature">
					<div class="feature-text">
						<h4>On-Chain Verified</h4>
						<p>Built on Solana with MagicBlock ephemeral rollups</p>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- CTA -->
	<div class="trading-cta">
		<h3 class="cta-title">Ready to Start Trading?</h3>
		<p class="cta-description">
			Access the full trading terminal with charts, positions, and leaderboards.
		</p>
		<a href="/" class="cta-button large">
			Go to Trading Terminal →
		</a>
	</div>
</section>

	<!-- Footer -->
	<footer class="footer">
		<div class="footer-content">
			<div class="footer-section">
				<div class="footer-logo">
					<img src={logo} alt="Blockberg" class="logo-icon" />
					<span class="logo-text">BLOCKBERG</span>
				</div>
				<p class="footer-description">
					Practice trading without risk. Built on Solana.
				</p>
			</div>
			<div class="footer-section">
				<h4 class="footer-title">Platform</h4>
				<a href="/" class="footer-link">Terminal</a>
				<a href="/competition" class="footer-link">Competitions</a>
				<a href="#trading" class="footer-link">How it Works</a>
			</div>
			<div class="footer-section">
				<h4 class="footer-title">Community</h4>
				<a href="#" class="footer-link">Discord</a>
				<a href="#" class="footer-link">Twitter</a>
				<a href="#" class="footer-link">Documentation</a>
			</div>
		</div>
		<div class="footer-bottom">
			<p>© 2026 Blockberg. Built with Solana & MagicBlock.</p>
		</div>
	</footer>
</div>

<!-- Comments Modal -->
{#if showCommentsModal}
	<div class="modal-overlay" onclick={closeCommentsModal}>
		<div class="modal-content" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Comments</h3>
				<button class="close-btn" onclick={closeCommentsModal}>✕</button>
			</div>
			
			<div class="modal-body">
				{#if isLoadingComments}
					<div class="loading">Loading comments...</div>
				{:else if comments.length === 0}
					<div class="no-comments">No comments yet. Be the first to comment!</div>
				{:else}
					<div class="comments-list">
						{#each comments as comment}
							<div class="comment">
								<div class="comment-header">
									<span class="comment-author">{comment.author}</span>
									<span class="comment-date">{comment.createdAt}</span>
								</div>
								<div class="comment-content">{comment.content}</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
			
			<div class="modal-footer">
				<textarea 
					bind:value={newCommentText}
					placeholder="Write your comment..."
					class="comment-input"
					rows="3"
				></textarea>
				<button 
					class="post-comment-btn"
					onclick={postComment}
					disabled={!newCommentText.trim() || isPostingComment}
				>
					{isPostingComment ? 'Posting...' : 'Post Comment'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	* {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	html {
		scroll-behavior: smooth;
		scroll-padding-top: 80px; /* Account for fixed navbar */
	}

	.landing-container {
		background: #fff;
		color: #000;
		min-height: 100vh;
	}

	/* Navigation */
	.navbar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		background: rgba(255, 255, 255, 0.95);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid #e0e0e0;
		z-index: 1000;
	}

	.nav-content {
		max-width: 1400px;
		margin: 0 auto;
		padding: 1rem 2rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: bold;
		font-size: 1.2rem;
	}

	.logo-icon {
		width: 48px;
		height: 48px;
	}

	.logo-text {
		color: #ff9500;
		letter-spacing: 2px;
	}

	.nav-links {
		display: flex;
		align-items: center;
		gap: 2rem;
	}

	.nav-link {
		color: #666;
		text-decoration: none;
		font-size: 0.95rem;
		transition: color 0.2s;
		font-weight: 500;
	}

	.nav-link:hover {
		color: #000;
	}

	.nav-link.active {
		color: #ff9500;
	}

	.nav-wallet {
		display: flex;
		align-items: center;
	}

	/* Hero Section */
	.hero {
		padding: 8rem 2rem 6rem;
		text-align: center;
		background: linear-gradient(180deg, #fff 0%, #f9f9f9 100%);
		border-bottom: 1px solid #e0e0e0;
	}

	.hero-content {
		max-width: 1200px;
		margin: 0 auto;
	}

	.hero-title {
		font-size: 4rem;
		font-weight: 800;
		line-height: 1.2;
		margin-bottom: 1.5rem;
	}

	.gradient-text {
		background: linear-gradient(135deg, #ff9500 0%, #ffb733 100%);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.hero-description {
		font-size: 1.3rem;
		color: #666;
		max-width: 700px;
		margin: 0 auto 2.5rem;
		line-height: 1.6;
	}

	.hero-buttons {
		display: flex;
		gap: 1rem;
		justify-content: center;
		margin-bottom: 4rem;
	}

	.cta-button {
		padding: 1rem 2.5rem;
		border-radius: 8px;
		font-size: 1.1rem;
		font-weight: bold;
		text-decoration: none;
		transition: all 0.3s;
		display: inline-block;
	}

	.cta-button.primary {
		background: #ff9500;
		color: #000;
	}

	.cta-button.primary:hover {
		background: #ffb733;
		transform: translateY(-2px);
		box-shadow: 0 10px 30px rgba(255, 149, 0, 0.3);
	}

	.cta-button.secondary {
		background: transparent;
		color: #000;
		border: 2px solid #e0e0e0;
	}

	.cta-button.secondary:hover {
		border-color: #ff9500;
		color: #ff9500;
	}

	/* Trade Posts Section */
	.trade-posts-section {
		padding: 6rem 2rem;
		background: #f9f9f9;
	}

	.section-content {
		max-width: 1400px;
		margin: 0 auto;
	}

	.section-header {
		text-align: center;
		margin-bottom: 3rem;
	}

	.section-title {
		font-size: 2.5rem;
		font-weight: bold;
		margin-bottom: 1rem;
	}

	.section-subtitle {
		color: #666;
		font-size: 1.1rem;
	}

	.filter-buttons {
		display: flex;
		gap: 1rem;
		justify-content: center;
		margin-bottom: 3rem;
	}

	.filter-btn {
		padding: 0.75rem 1.5rem;
		background: #fff;
		border: 1px solid #e0e0e0;
		color: #000;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.95rem;
		font-weight: 500;
		transition: all 0.2s;
	}

	.filter-btn:hover {
		border-color: #ff9500;
	}

	.filter-btn.active {
		background: #ff9500;
		color: #000;
		border-color: #ff9500;
	}

	.controls-container {
		margin-bottom: 3rem;
	}

	.filter-sort-row {
		display: flex;
		gap: 2rem;
		justify-content: center;
		align-items: center;
		margin-top: 1.5rem;
		flex-wrap: wrap;
	}

	.filter-group {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.filter-label {
		font-size: 0.95rem;
		font-weight: 500;
		color: #000;
	}

	.select-dropdown {
		padding: 0.6rem 1rem;
		background: #fff;
		border: 1px solid #e0e0e0;
		color: #000;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.95rem;
		font-weight: 500;
		transition: all 0.2s;
		min-width: 180px;
	}

	.select-dropdown:hover {
		border-color: #ff9500;
	}

	.select-dropdown:focus {
		outline: none;
		border-color: #ff9500;
		box-shadow: 0 0 0 3px rgba(255, 149, 0, 0.1);
	}

	.posts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
		gap: 2rem;
		margin-bottom: 3rem;
	}

	.trade-post {
		background: #fff;
		border: 1px solid #e0e0e0;
		border-radius: 12px;
		padding: 1.5rem;
		transition: all 0.3s;
	}

	.trade-post:hover {
		border-color: #ff9500;
		transform: translateY(-4px);
		box-shadow: 0 10px 30px rgba(255, 149, 0, 0.2);
	}

	.post-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.post-author {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.author-info {
		display: flex;
		flex-direction: column;
	}

	.author-name {
		font-weight: 600;
		font-size: 0.95rem;
	}

	.post-direction {
		padding: 0.4rem 0.8rem;
		border-radius: 6px;
		font-size: 0.85rem;
		font-weight: bold;
	}

	.post-direction.long {
		background: rgba(0, 255, 0, 0.1);
		color: #00ff00;
		border: 1px solid #00ff00;
	}

	.post-direction.short {
		background: rgba(255, 0, 0, 0.1);
		color: #ff0000;
		border: 1px solid #ff0000;
	}

	.post-symbol {
		font-size: 1.5rem;
		font-weight: bold;
		margin-bottom: 1rem;
		color: #ff9500;
	}

	.post-prices {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		margin-bottom: 1rem;
		padding: 1rem;
		background: #f5f5f5;
		border-radius: 8px;
	}

	.price-item {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
	}

	.price-label {
		color: #999;
		font-size: 0.85rem;
		display: block;
	}

	.price-value {
		font-weight: bold;
		font-size: 1.1rem;
		color: #000;
		display: block;
	}

	.price-timestamp {
		color: #999;
		font-size: 0.75rem;
		margin-top: 0.25rem;
		display: block;
	}

	.pnl-positive {
		color: #00c853 !important;
	}

	.pnl-negative {
		color: #ff0000 !important;
	}

	.post-analysis {
		color: #333;
		line-height: 1.6;
		margin-bottom: 1rem;
		font-size: 0.95rem;
	}

	.post-footer {
		display: flex;
		gap: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid #e0e0e0;
	}

	.action-btn {
		padding: 0.5rem 1rem;
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		color: #000;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.action-btn:hover {
		border-color: #ff9500;
	}

	.action-btn.liked {
		background: #ffebe0;
		border-color: #ff9500;
		color: #ff9500;
	}

	.action-btn.like-btn:active {
		transform: scale(0.95);
	}

	.view-more {
		text-align: center;
		padding-top: 2rem;
	}

	.view-more-link {
		color: #ff9500;
		text-decoration: none;
		font-size: 1.1rem;
		font-weight: 600;
		transition: all 0.2s;
	}

	.view-more-link:hover {
		color: #ffb733;
	}

	/* Trading Section */
	.trading-section {
		padding: 6rem 2rem;
		background: #fff;
	}

	.trading-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 2rem;
		margin-bottom: 4rem;
	}

	.trading-card {
		background: #f9f9f9;
		border: 1px solid #e0e0e0;
		border-radius: 12px;
		padding: 2rem;
		position: relative;
		transition: all 0.3s;
	}

	.trading-card:hover {
		border-color: #ff9500;
		transform: translateY(-4px);
	}

	.card-number {
		position: absolute;
		top: 1rem;
		right: 1rem;
		color: #e0e0e0;
		font-size: 3rem;
		font-weight: bold;
	}

	.card-icon {
		font-size: 3rem;
		margin-bottom: 1rem;
	}

	.card-icon img {
		width: 120px;
		height: 120px;
		object-fit: contain;
	}

	.card-title {
		font-size: 1.3rem;
		margin-bottom: 1rem;
		color: #000;
	}

	.card-description {
		color: #666;
		line-height: 1.6;
	}

	/* Competitions Section */
	.competitions-section {
		margin: 3rem 0;
		padding: 2rem 0;
		border-top: 1px solid #e0e0e0;
		border-bottom: 1px solid #e0e0e0;
	}

	.competitions-title {
		font-size: 2rem;
		text-align: center;
		margin-bottom: 0.5rem;
		color: #000;
	}

	.competitions-description {
		text-align: center;
		color: #666;
		margin-bottom: 2rem;
		font-size: 1.1rem;
	}

	.competitions-loading,
	.competitions-empty {
		text-align: center;
		padding: 2rem;
		color: #666;
	}

	.competitions-empty p {
		margin-bottom: 1rem;
	}

	.competitions-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 2rem;
		margin-bottom: 2rem;
	}

	.competition-card {
		background: #fff;
		border: 1px solid #e0e0e0;
		border-radius: 12px;
		padding: 1.5rem;
		transition: all 0.3s ease;
		position: relative;
		overflow: hidden;
	}

	.competition-card:hover {
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		transform: translateY(-4px);
		border-color: #ff9500;
	}

	.competition-status {
		position: absolute;
		top: 1rem;
		right: 1rem;
		padding: 0.4rem 0.8rem;
		border-radius: 20px;
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	.competition-status.live {
		background: #ff9500;
		color: #fff;
		animation: pulse 2s infinite;
	}

	.competition-status.pending {
		background: #4CAF50;
		color: #fff;
	}

	.competition-status.ended {
		background: #9E9E9E;
		color: #fff;
	}

	@keyframes pulse {
		0%, 100% {
			opacity: 1;
		}
		50% {
			opacity: 0.7;
		}
	}

	.competition-title {
		font-size: 1.5rem;
		font-weight: 700;
		margin-bottom: 1.5rem;
		color: #000;
		padding-right: 6rem;
	}

	.competition-details {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.detail-item {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.detail-label {
		font-size: 0.875rem;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.detail-value {
		font-size: 1.1rem;
		font-weight: 600;
		color: #000;
	}

	.join-competition-btn {
		width: 100%;
		padding: 0.875rem 1.5rem;
		background: linear-gradient(135deg, #ff9500 0%, #ff7700 100%);
		color: #fff;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.3s ease;
	}

	.join-competition-btn:hover {
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(255, 149, 0, 0.4);
	}

	.view-all-competitions {
		text-align: center;
		margin-top: 2rem;
	}

	.view-all-btn {
		display: inline-block;
		padding: 0.875rem 2rem;
		background: #fff;
		color: #ff9500;
		border: 2px solid #ff9500;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 600;
		text-decoration: none;
		transition: all 0.3s ease;
	}

	.view-all-btn:hover {
		background: #ff9500;
		color: #fff;
		transform: translateY(-2px);
	}

	/* Features Section */
	.features-section {
		margin-bottom: 4rem;
	}

	.features-title {
		font-size: 2rem;
		text-align: center;
		margin-bottom: 2rem;
	}

	.features-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 2rem;
	}

	.feature {
		display: flex;
		gap: 1rem;
		padding: 1.5rem;
		background: #f9f9f9;
		border: 1px solid #e0e0e0;
		border-radius: 12px;
		transition: all 0.2s;
	}

	.feature:hover {
		border-color: #ff9500;
	}

	.feature-text h4 {
		margin-bottom: 0.5rem;
		color: #ff9500;
	}

	.feature-text p {
		color: #666;
		font-size: 0.95rem;
	}

	/* Trading CTA */
	.trading-cta {
		text-align: center;
		padding: 3rem 2rem;
		background: #f9f9f9;
		border: 1px solid #e0e0e0;
		border-radius: 0;
		width: 100%;
	}

	.cta-title {
		font-size: 2rem;
		margin-bottom: 1rem;
	}

	.cta-description {
		color: #666;
		font-size: 1.1rem;
		margin-bottom: 2rem;
	}

	.cta-button.large {
		padding: 1.25rem 3rem;
		font-size: 1.2rem;
	}

	/* Footer */
	.footer {
		background: #f9f9f9;
		border-top: 1px solid #e0e0e0;
		padding: 3rem 2rem 1rem;
	}

	.footer-content {
		max-width: 1400px;
		margin: 0 auto;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 3rem;
		margin-bottom: 2rem;
	}

	.footer-logo {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: bold;
		font-size: 1.2rem;
		margin-bottom: 1rem;
	}

	.footer-description {
		color: #999;
		line-height: 1.6;
	}

	.footer-title {
		color: #ff9500;
		margin-bottom: 1rem;
		font-size: 1.1rem;
	}

	.footer-link {
		display: block;
		color: #666;
		text-decoration: none;
		margin-bottom: 0.75rem;
		transition: color 0.2s;
	}

	.footer-link:hover {
		color: #000;
	}

	.footer-bottom {
		text-align: center;
		padding-top: 2rem;
		border-top: 1px solid #e0e0e0;
		color: #999;
		font-size: 0.9rem;
	}

	/* Responsive */
	@media (max-width: 768px) {
		.nav-content {
			flex-wrap: wrap;
			gap: 1rem;
		}

		.nav-links {
			order: 3;
			width: 100%;
			justify-content: center;
			gap: 1rem;
			font-size: 0.85rem;
		}

		.nav-wallet {
			order: 2;
		}

		.hero-title {
			font-size: 2.5rem;
		}

		.hero-description {
			font-size: 1.1rem;
		}

		.filter-buttons {
			flex-direction: column;
			align-items: stretch;
		}

		.filter-sort-row {
			flex-direction: column;
			gap: 1rem;
			align-items: stretch;
		}

		.filter-group {
			flex-direction: column;
			align-items: stretch;
			gap: 0.5rem;
		}

		.select-dropdown {
			width: 100%;
		}

		.posts-grid {
			grid-template-columns: 1fr;
		}

		.trading-grid {
			grid-template-columns: 1fr;
		}

		.competitions-grid {
			grid-template-columns: 1fr;
		}

		.competition-title {
			font-size: 1.3rem;
			padding-right: 5rem;
		}

		.competition-details {
			grid-template-columns: 1fr;
		}
	}

	/* Comments Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
		padding: 1rem;
	}

	.modal-content {
		background: white;
		border-radius: 12px;
		width: 100%;
		max-width: 600px;
		max-height: 85vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		margin: auto;
	}

	.modal-header {
		padding: 1.5rem;
		border-bottom: 1px solid #e0e0e0;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.modal-header h3 {
		font-size: 1.5rem;
		color: #000;
		margin: 0;
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		padding: 0.25rem;
		color: #666;
		transition: color 0.2s;
	}

	.close-btn:hover {
		color: #ff9500;
	}

	.modal-body {
		padding: 1.5rem;
		overflow-y: auto;
		flex: 1;
	}

	.loading,
	.no-comments {
		text-align: center;
		color: #666;
		padding: 2rem;
	}

	.comments-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.comment {
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 1rem;
		background: #f9f9f9;
	}

	.comment-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.comment-author {
		font-weight: 600;
		color: #ff9500;
	}

	.comment-date {
		font-size: 0.85rem;
		color: #666;
	}

	.comment-content {
		color: #333;
		line-height: 1.5;
	}

	.modal-footer {
		padding: 1.5rem;
		border-top: 1px solid #e0e0e0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.comment-input {
		width: 100%;
		padding: 0.75rem;
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.95rem;
		resize: vertical;
		min-height: 80px;
	}

	.comment-input:focus {
		outline: none;
		border-color: #ff9500;
	}

	.post-comment-btn {
		align-self: flex-end;
		padding: 0.75rem 1.5rem;
		background: #ff9500;
		color: white;
		border: none;
		border-radius: 6px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s;
	}

	.post-comment-btn:hover:not(:disabled) {
		background: #e68600;
	}

	.post-comment-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.comment-btn:hover {
		border-color: #ff9500;
	}
</style>
