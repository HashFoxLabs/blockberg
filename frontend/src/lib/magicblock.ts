import {
	Connection,
	PublicKey,
	Keypair,
	LAMPORTS_PER_SOL,
	Transaction,
	TransactionInstruction,
	SystemProgram,
	type AccountMeta,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter, SignerWalletAdapter } from '@solana/wallet-adapter-base';
import * as ENV from './env';
import paperTradingIdl from './idl/paper_trading.json';
import { derivePaperSessionTokenPda, sessionKeyManager } from './solana/session-keys';

/** Unified on-chain `Position` account discriminator (Anchor IDL). */
const POSITION_ACCOUNT_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);
/** Unified on-chain `UserAccount` account discriminator. */
const USER_ACCOUNT_DISCRIMINATOR = Buffer.from([211, 33, 136, 16, 186, 110, 242, 127]);
const UNIFIED_USER_DATA_LEN = 73;
const DEFAULT_PERP_LEVERAGE = 10;

/** Must match on-chain `validate_leverage` for perps. */
export const PERP_LEVERAGE_TIERS = [2, 3, 5, 10, 15, 20, 25, 50] as const;
export type PaperSurface = 'spot' | 'perp';
export type PaperExecution = 'market' | 'limit';

export type PlacePaperOrderOpts = {
	pairSymbol: string;
	side: 'long' | 'short';
	surface: PaperSurface;
	execution: PaperExecution;
	/** Position notional in USD (margin = notional / leverage; spot uses leverage 1). */
	notionalUsd: number;
	/** Required for perp; ignored for spot (always 1x). */
	leverage?: number;
	limitPriceUsd?: number;
	takeProfitUsd?: number;
	stopLossUsd?: number;
	/** Mark / index price for market orders and balance checks. */
	marketPriceUsd: number;
};

export const MAGICBLOCK_RPC = ENV.MAGICBLOCK_RPC;
export const SOLANA_RPC = ENV.SOLANA_RPC;

// Paper Trading Program ID from the contract
export const PAPER_TRADING_PROGRAM_ID = new PublicKey(ENV.PAPER_TRADING_PROGRAM_ID);

export const TRADING_PAIRS = {
	SOL: 0,
	BTC: 1,
	ETH: 2,
	AVAX: 3,
	LINK: 4,
};

export const TOKEN_DECIMALS = {
	// token_in (quote tokens - typically USDT)
	USDT: 6,
	// token_out (base tokens) - using 8-9 decimals to avoid u64 overflow
	SOL: 9,
	BTC: 8,
	ETH: 8,
	AVAX: 8,
	LINK: 8,
};

export const PAIR_DECIMALS = {
	0: { tokenIn: TOKEN_DECIMALS.USDT, tokenOut: TOKEN_DECIMALS.SOL },   // SOL/USDT
	1: { tokenIn: TOKEN_DECIMALS.USDT, tokenOut: TOKEN_DECIMALS.BTC },   // BTC/USDT
	2: { tokenIn: TOKEN_DECIMALS.USDT, tokenOut: TOKEN_DECIMALS.ETH },   // ETH/USDT
	3: { tokenIn: TOKEN_DECIMALS.USDT, tokenOut: TOKEN_DECIMALS.AVAX },  // AVAX/USDT
	4: { tokenIn: TOKEN_DECIMALS.USDT, tokenOut: TOKEN_DECIMALS.LINK },  // LINK/USDT
};

export enum PositionDirection {
	Long = 'LONG',
	Short = 'SHORT',
}

/**
 * Explicit account metas for session-signed paper ixs — matches on-chain account order for
 * `OpenPositionCtx` (opens) and `UserPositionAction` (close / cancel). Anchor’s
 * `accountsArray()` optional-account handling was producing a message where `user` was not a required
 * signer at runtime (3010).
 */
function paperSessionTradingAccountMetas(
	methodName: string,
	m: Record<string, PublicKey>
): AccountMeta[] {
	const userAccount = m.userAccount;
	const position = m.position;
	const sessionToken = m.sessionToken;
	const user = m.user;
	const systemProgram = m.systemProgram;
	switch (methodName) {
		case 'openMarketPosition':
		case 'openLimitOrder':
			return [
				{ pubkey: userAccount, isSigner: false, isWritable: true },
				{ pubkey: position, isSigner: false, isWritable: true },
				{ pubkey: sessionToken, isSigner: false, isWritable: false },
				{ pubkey: user, isSigner: true, isWritable: true },
				{ pubkey: systemProgram, isSigner: false, isWritable: false },
			];
		case 'closePosition':
		case 'cancelLimitOrder':
			return [
				{ pubkey: userAccount, isSigner: false, isWritable: true },
				{ pubkey: position, isSigner: false, isWritable: true },
				{ pubkey: user, isSigner: true, isWritable: false },
				{ pubkey: sessionToken, isSigner: false, isWritable: false },
			];
		default:
			throw new Error(`Unknown paper session instruction: ${methodName}`);
	}
}

function encodePaperTradingIxData(prog: Program<Idl>, methodName: string, args: unknown[]): Buffer {
	const idlIx = prog.idl.instructions.find((i) => i.name === methodName);
	if (!idlIx) {
		throw new Error(`IDL has no instruction named ${methodName}`);
	}
	const fields: Record<string, unknown> = {};
	idlIx.args.forEach((arg, idx) => {
		fields[arg.name] = args[idx];
	});
	return prog.coder.instruction.encode(methodName, fields);
}

export class MagicBlockClient {
	connection: Connection;
	wallet: Keypair | null = null;
	sessionWallet: Keypair | null = null;
	connectedWallet: Adapter | null = null;
	/** Anchor client for unified paper-trading program (wallet signer). */
	private paperProgram: Program | null = null;

	constructor() {
		this.connection = new Connection(MAGICBLOCK_RPC, 'confirmed');
	}

	// Set connected wallet adapter
	async setConnectedWallet(wallet: Adapter | null) {
		this.connectedWallet = wallet;
		this.paperProgram = null;

		if (wallet?.connected && wallet.publicKey) {
			await this.initializeEntity();
			try {
				this.paperProgram = new Program(paperTradingIdl as Idl, this.getWalletAdapterProvider(wallet));
			} catch {
				this.paperProgram = null;
			}
		}
	}

	private getWalletAdapterProvider(adapter: Adapter): anchor.AnchorProvider {
		const signer = adapter as SignerWalletAdapter;
		if (!adapter.publicKey || !signer.signTransaction) {
			throw new Error('Wallet cannot sign transactions');
		}
		const w = {
			publicKey: adapter.publicKey,
			signTransaction: signer.signTransaction.bind(signer),
			signAllTransactions: signer.signAllTransactions?.bind(signer),
		};
		return new anchor.AnchorProvider(this.connection, w as any, {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		});
	}

	private getPaperTradingAuth(): PublicKey {
		if (!this.connectedWallet?.connected || !this.connectedWallet.publicKey) {
			throw new Error('Wallet not connected');
		}
		return this.connectedWallet.publicKey;
	}

	private getPaperTradingSignerContext():
		| { mode: 'session'; sessionKeypair: Keypair; sessionToken: PublicKey; authority: PublicKey }
		| { mode: 'wallet'; authority: PublicKey } {
		const authority = this.getPaperTradingAuth();
		if (
			sessionKeyManager.isSessionActive() &&
			sessionKeyManager.isSessionForWallet(authority)
		) {
			const sessionKeypair = sessionKeyManager.getSessionKeypair();
			const sessionToken = sessionKeyManager.getSessionTokenPDA();
			if (sessionKeypair && sessionToken) {
				return { mode: 'session', sessionKeypair, sessionToken, authority };
			}
		}
		return { mode: 'wallet', authority };
	}

	/**
	 * Polymock-style: **session only** for paper opens/closes. Single instruction, session key signs,
	 * `sendRawTransaction` + `skipPreflight`. Wallet `.rpc()` often prepends compute-budget ixs →
	 * `InstructionError` index 2 (third instruction) while the program expects a fixed layout.
	 */
	private async invokePaperTrading(
		methodName: string,
		args: unknown[],
		accounts: Record<string, PublicKey>
	): Promise<string> {
		const ctx = this.getPaperTradingSignerContext();
		if (ctx.mode !== 'session') {
			throw new Error(
				'Paper trading session required. Create a MagicBlock session for this wallet first (same idea as Polymock).'
			);
		}

		const kp = ctx.sessionKeypair;
		const sessionTokenPda = derivePaperSessionTokenPda(kp.publicKey, ctx.authority);
		if (!sessionTokenPda.equals(ctx.sessionToken)) {
			console.warn(
				'[Session] Session token PDA differs from stored value; using derived PDA (revoke + new session if trades fail).'
			);
		}

		const merged: Record<string, PublicKey> = {
			...accounts,
			sessionToken: sessionTokenPda,
			user: kp.publicKey,
			systemProgram: SystemProgram.programId,
		};

		// `Program` is only used for the instruction coder; account metas are built manually above.
		const noopWallet = Keypair.generate();
		const prov = new anchor.AnchorProvider(this.connection, {
			publicKey: noopWallet.publicKey,
			signTransaction: async (t: Transaction) => t,
			signAllTransactions: async (ts: Transaction[]) => ts,
		} as any);
		const prog = new Program(paperTradingIdl as Idl, prov);
		const keys = paperSessionTradingAccountMetas(methodName, merged);
		const data = encodePaperTradingIxData(prog, methodName, args);
		const ix = new TransactionInstruction({
			keys,
			programId: PAPER_TRADING_PROGRAM_ID,
			data,
		});
		const tx = new Transaction().add(ix);
		// Session key IS the fee payer (funded with SOL at session creation).
		// Only the session key signs — no wallet adapter, no popup, no compute-budget
		// instructions injected by the wallet. This matches how Polymock handles it.
		tx.feePayer = kp.publicKey;
		const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
		tx.recentBlockhash = blockhash;
		tx.sign(kp);
		const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
		const confirmation = await this.connection.confirmTransaction(
			{ signature: sig, blockhash, lastValidBlockHeight },
			'confirmed'
		);
		if (confirmation.value.err) {
			const txDetails = await this.connection.getTransaction(sig, {
				commitment: 'confirmed',
				maxSupportedTransactionVersion: 0,
			});
			const logs = txDetails?.meta?.logMessages?.join('\n') || 'No logs';
			console.error('[Session] TX failed:', sig, '\nLogs:\n', logs);
			throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
		}
		return sig;
	}

	/** MagicBlock session keys: one wallet signature funds the session signer (SOL top-up) + delegates trading. */
	async createPaperTradingSession(opts?: {
		topUpSol?: number;
		expiryMinutes?: number;
	}): Promise<void> {
		const adapter = this.connectedWallet as SignerWalletAdapter | null;
		if (!adapter?.connected || !adapter.publicKey || !adapter.signTransaction) {
			throw new Error('Connect a signing wallet first');
		}
		await sessionKeyManager.createSession(
			{
				publicKey: adapter.publicKey,
				signTransaction: adapter.signTransaction.bind(adapter),
			},
			opts?.expiryMinutes ?? 60 * 24,
			opts?.topUpSol ?? 0.05
		);
	}

	/** Seconds until stored session expires (0 if inactive / wrong wallet). */
	getPaperSessionTimeRemainingSeconds(): number {
		try {
			const a = this.getPaperTradingAuth();
			if (!sessionKeyManager.isSessionActive() || !sessionKeyManager.isSessionForWallet(a)) {
				return 0;
			}
			return sessionKeyManager.getSessionTimeRemaining();
		} catch {
			return 0;
		}
	}

	async revokePaperTradingSession(): Promise<void> {
		const adapter = this.connectedWallet as SignerWalletAdapter | null;
		if (!adapter?.connected || !adapter.publicKey || !adapter.signTransaction) {
			sessionKeyManager.clearSession();
			return;
		}
		await sessionKeyManager.revokeSession({
			publicKey: adapter.publicKey,
			signTransaction: adapter.signTransaction.bind(adapter),
		});
	}

	isPaperTradingSessionActive(): boolean {
		try {
			const a = this.getPaperTradingAuth();
			return sessionKeyManager.isSessionActive() && sessionKeyManager.isSessionForWallet(a);
		} catch {
			return false;
		}
	}

	// Get current wallet (prioritize connected wallet over session wallet)
	getCurrentWallet(): { publicKey: PublicKey; signTransaction?: (tx: Transaction) => Promise<Transaction>; signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]> } | null {
		if (this.connectedWallet?.connected && this.connectedWallet.publicKey) {
			const signerWallet = this.connectedWallet as SignerWalletAdapter;
			return {
				publicKey: this.connectedWallet.publicKey,
				signTransaction: signerWallet.signTransaction?.bind(signerWallet),
				signAllTransactions: signerWallet.signAllTransactions?.bind(signerWallet)
			};
		}
		
		if (this.sessionWallet) {
			return {
				publicKey: this.sessionWallet.publicKey,
				signTransaction: async (tx: Transaction) => {
					tx.partialSign(this.sessionWallet!);
					return tx;
				},
				signAllTransactions: async (txs: Transaction[]) => {
					return txs.map((tx) => {
						tx.partialSign(this.sessionWallet!);
						return tx;
					});
				}
			};
		}

		return null;
	}

	// Check if we have a connected wallet
	isWalletConnected(): boolean {
		return !!(this.connectedWallet?.connected || this.sessionWallet);
	}

	/** Unified paper user PDA — one account per wallet (`pairIndex` ignored for API compatibility). */
	getUserAccountPDA(userPubkey: PublicKey, _pairIndex?: number): [PublicKey, number] {
		return PublicKey.findProgramAddressSync(
			[Buffer.from('user'), userPubkey.toBuffer()],
			PAPER_TRADING_PROGRAM_ID
		);
	}

	// Get config PDA
	getConfigPDA(): [PublicKey, number] {
		return PublicKey.findProgramAddressSync(
			[Buffer.from('config')],
			PAPER_TRADING_PROGRAM_ID
		);
	}

	// Check if user has initialized their trading account for a specific pair
	async checkAccountInitialized(userPubkey: PublicKey, pairIndex: number): Promise<boolean> {
		try {
			const [userAccountPDA] = this.getUserAccountPDA(userPubkey, pairIndex);
			const accountInfo = await this.connection.getAccountInfo(userAccountPDA);
			return accountInfo !== null;
		} catch (error) {
			return false;
		}
	}

	/** Creates the unified paper account once (real-wallet signature; `pairIndex` ignored). */
	async initializeAccount(pairIndex: number, entryFee: number = 0.1, _initialTokenIn: number = 10000): Promise<string> {
		const adapter = this.connectedWallet as SignerWalletAdapter | null;
		if (!adapter?.connected || !adapter.publicKey || !adapter.signTransaction) {
			throw new Error('Wallet not connected');
		}

		const solanaConnection = new Connection(SOLANA_RPC, 'confirmed');
		const balance = await solanaConnection.getBalance(adapter.publicKey);
		if (balance < 50_000_000) {
			throw new Error('Insufficient SOL balance');
		}

		const [userAccountPDA] = this.getUserAccountPDA(adapter.publicKey, pairIndex);
		const existingAccount = await this.connection.getAccountInfo(userAccountPDA);
		if (existingAccount) {
			return 'account_already_exists';
		}

		const [configPDA] = this.getConfigPDA();
		const configAccountInfo = await this.connection.getAccountInfo(configPDA);
		if (!configAccountInfo) {
			throw new Error('Config account not initialized. Contact admin.');
		}

		const treasuryPubkey = new PublicKey(configAccountInfo.data.subarray(40, 72));

		if (!this.paperProgram) {
			this.paperProgram = new Program(paperTradingIdl as Idl, this.getWalletAdapterProvider(adapter));
		}

		const entryFeeLamports = new anchor.BN(Math.floor(entryFee * LAMPORTS_PER_SOL));
		return await this.paperProgram.methods
			.initializeUserAccount(entryFeeLamports)
			.accounts({
				userAccount: userAccountPDA,
				config: configPDA,
				user: adapter.publicKey,
				treasury: treasuryPubkey,
				systemProgram: SystemProgram.programId,
			})
			.rpc();
	}

	// Get account status for all pairs
	async getAccountStatus(): Promise<{ [pairIndex: number]: boolean }> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return {};
		}

		const status: { [pairIndex: number]: boolean } = {};
		
		// Check initialization status for all trading pairs
		for (const [, pairIndex] of Object.entries(TRADING_PAIRS)) {
			status[pairIndex] = await this.checkAccountInitialized(currentWallet.publicKey, pairIndex);
		}

		return status;
	}

	async initializeSessionWallet(): Promise<Keypair> {

		const stored = localStorage.getItem('magicblock_session_wallet');
		if (stored) {
			try {
				const secretKey = Uint8Array.from(JSON.parse(stored));
				this.sessionWallet = Keypair.fromSecretKey(secretKey);
				await this.initializeEntity();
				this.setupProvider();
				return this.sessionWallet;
			} catch (e) {
			}
		}

		this.sessionWallet = Keypair.generate();
		localStorage.setItem(
			'magicblock_session_wallet',
			JSON.stringify(Array.from(this.sessionWallet.secretKey))
		);

		await this.initializeEntity();
		this.setupProvider();
		return this.sessionWallet;
	}

	async initializeEntity(): Promise<void> {
		// Legacy no-op: trading uses only the unified `paper_trading` Anchor program.
	}

	setAdminWallet(secretKeyBase58: string): void {
		try {
			const secretKey = Keypair.fromSecretKey(
				Uint8Array.from(Buffer.from(secretKeyBase58, 'base64'))
			);
			this.wallet = secretKey;
		} catch (e) {
		}
	}

	getProvider(): anchor.AnchorProvider {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('No wallet available');
		}

		const wallet = {
			publicKey: currentWallet.publicKey,
			signTransaction: currentWallet.signTransaction || (async (tx: Transaction) => {
				throw new Error('Wallet does not support transaction signing');
			}),
			signAllTransactions: currentWallet.signAllTransactions || (async (txs: Transaction[]) => {
				throw new Error('Wallet does not support multiple transaction signing');
			}),
		};

		return new anchor.AnchorProvider(this.connection, wallet as any, {
			commitment: 'confirmed',
		});
	}

	setupProvider(): void {
		const provider = this.getProvider();
		anchor.setProvider(provider);
	}

	async buySpot(pairIndex: number, usdtAmount: number, currentPrice: number): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const costInTokenIn = Math.floor(usdtAmount * 1e6);
		const priceScaled = Math.floor(currentPrice * 1e6);

		const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);

		const methodName = "global:buy";
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		const instructionData = Buffer.alloc(8 + 16);
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(costInTokenIn), 8);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 16);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false },
			],
			programId: PAPER_TRADING_PROGRAM_ID,
			data: instructionData
		});

		const transaction = new Transaction().add(instruction);
		const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
		transaction.recentBlockhash = latestBlockhash.blockhash;
		transaction.feePayer = currentWallet.publicKey;

		const signedTx = await currentWallet.signTransaction!(transaction);
		const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
			skipPreflight: false,
			preflightCommitment: 'confirmed'
		});

		await this.connection.confirmTransaction({
			signature,
			blockhash: latestBlockhash.blockhash,
			lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
		}, 'confirmed');

		return signature;
	}

	async sellSpot(pairIndex: number, tokenAmount: number, currentPrice: number): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const valueInTokenIn = Math.floor(tokenAmount * currentPrice * 1e6);
		const priceScaled = Math.floor(currentPrice * 1e6);

		const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);

		const methodName = "global:sell";
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		const instructionData = Buffer.alloc(8 + 16);
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(valueInTokenIn), 8);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 16);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false },
			],
			programId: PAPER_TRADING_PROGRAM_ID,
			data: instructionData
		});

		const transaction = new Transaction().add(instruction);
		const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
		transaction.recentBlockhash = latestBlockhash.blockhash;
		transaction.feePayer = currentWallet.publicKey;

		const signedTx = await currentWallet.signTransaction!(transaction);
		const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
			skipPreflight: false,
			preflightCommitment: 'confirmed'
		});

		await this.connection.confirmTransaction({
			signature,
			blockhash: latestBlockhash.blockhash,
			lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
		}, 'confirmed');

		return signature;
	}

	private isValidPerpLeverage(lev: number): lev is (typeof PERP_LEVERAGE_TIERS)[number] {
		return (PERP_LEVERAGE_TIERS as readonly number[]).includes(lev);
	}

	/** Spot / perp, market / limit, with TP & SL — unified paper program API. */
	async placePaperOrder(opts: PlacePaperOrderOpts): Promise<string> {
		const authority = this.getPaperTradingAuth();
		const pairIndex = TRADING_PAIRS[opts.pairSymbol as keyof typeof TRADING_PAIRS];
		if (pairIndex === undefined) {
			throw new Error(`Unknown trading pair: ${opts.pairSymbol}`);
		}

		let leverageU8 = 1;
		if (opts.surface === 'perp') {
			const lev = opts.leverage ?? DEFAULT_PERP_LEVERAGE;
			if (!this.isValidPerpLeverage(lev)) {
				throw new Error(`Invalid perp leverage. Allowed: ${PERP_LEVERAGE_TIERS.join(', ')}`);
			}
			leverageU8 = lev;
		}

		const [userAccountPDA] = this.getUserAccountPDA(authority, pairIndex);
		const uaInfo = await this.connection.getAccountInfo(userAccountPDA);
		if (!uaInfo || uaInfo.data.length < UNIFIED_USER_DATA_LEN) {
			throw new Error('Trading account not initialized. Use Initialize first.');
		}

		const usdtRaw = uaInfo.data.readBigUInt64LE(40);
		const lockedRaw = uaInfo.data.readBigUInt64LE(48);
		const available = usdtRaw - lockedRaw;

		const marginUsd = BigInt(
			Math.floor((opts.notionalUsd / leverageU8) * 1_000_000)
		);
		if (marginUsd <= 0n) {
			throw new Error('Position size too small');
		}
		if (available < marginUsd) {
			const need = Number(marginUsd) / 1e6;
			const have = Number(available) / 1e6;
			throw new Error(
				`Insufficient balance. Required margin: ${need.toFixed(2)} USDT, Available: ${have.toFixed(2)} USDT`
			);
		}

		const totalPositions = uaInfo.data.readBigUInt64LE(56);
		const idxBuf = Buffer.allocUnsafe(8);
		idxBuf.writeBigUInt64LE(totalPositions, 0);
		const [positionPDA] = PublicKey.findProgramAddressSync(
			[Buffer.from('position'), authority.toBuffer(), idxBuf],
			PAPER_TRADING_PROGRAM_ID
		);

		const dirArg = opts.side === 'long' ? { long: {} } : { short: {} };
		const modeArg = opts.surface === 'perp' ? { perp: {} } : { spot: {} };
		const tpScaled = Math.floor((opts.takeProfitUsd ?? 0) * 1e6);
		const slScaled = Math.floor((opts.stopLossUsd ?? 0) * 1e6);

		const accounts = {
			userAccount: userAccountPDA,
			position: positionPDA,
			systemProgram: SystemProgram.programId,
		};

		if (opts.execution === 'limit') {
			if (!opts.limitPriceUsd || opts.limitPriceUsd <= 0) {
				throw new Error('Limit price required for limit orders');
			}
			const limitScaled = Math.floor(opts.limitPriceUsd * 1e6);
			return await this.invokePaperTrading(
				'openLimitOrder',
				[
					pairIndex,
					modeArg,
					dirArg,
					new anchor.BN(marginUsd.toString()),
					leverageU8,
					new anchor.BN(limitScaled.toString()),
					new anchor.BN(tpScaled.toString()),
					new anchor.BN(slScaled.toString()),
				],
				accounts
			);
		}

		const priceScaled = Math.floor(opts.marketPriceUsd * 1e6);
		if (priceScaled <= 0) {
			throw new Error('Invalid market price');
		}

		return await this.invokePaperTrading(
			'openMarketPosition',
			[
				pairIndex,
				modeArg,
				dirArg,
				new anchor.BN(marginUsd.toString()),
				leverageU8,
				new anchor.BN(tpScaled.toString()),
				new anchor.BN(slScaled.toString()),
				new anchor.BN(priceScaled.toString()),
			],
			accounts
		);
	}

	async cancelLimitOrder(positionPubkey: string): Promise<string> {
		const authority = this.getPaperTradingAuth();
		const positionPk = new PublicKey(positionPubkey);
		const positionAccount = await this.connection.getAccountInfo(positionPk);
		if (!positionAccount) {
			throw new Error('Position account not found');
		}
		const data = positionAccount.data;
		if (data.length < 48 || !data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) {
			throw new Error('Invalid position account');
		}
		const ownerPk = new PublicKey(data.subarray(8, 40));
		if (!ownerPk.equals(authority)) {
			throw new Error('Position does not belong to this wallet');
		}
		if (data[51] !== 1) {
			throw new Error('Not a limit order');
		}
		if (data[109] !== 0) {
			throw new Error('Order is not pending');
		}

		const [userAccountPDA] = this.getUserAccountPDA(authority, 0);
		return await this.invokePaperTrading('cancelLimitOrder', [], {
			userAccount: userAccountPDA,
			position: positionPk,
		});
	}

	async openPosition(
		pairSymbol: string,
		direction: PositionDirection,
		currentPrice: number,
		size: number,
		takeProfit?: number,
		stopLoss?: number,
		perpLeverage: number = DEFAULT_PERP_LEVERAGE
	): Promise<string> {
		return await this.placePaperOrder({
			pairSymbol,
			side: direction === PositionDirection.Long ? 'long' : 'short',
			surface: 'perp',
			execution: 'market',
			notionalUsd: size,
			leverage: perpLeverage,
			takeProfitUsd: takeProfit,
			stopLossUsd: stopLoss,
			marketPriceUsd: currentPrice,
		});
	}

	async closeDirectPosition(positionPubkey: string, currentPrice: number): Promise<string> {
		const authority = this.getPaperTradingAuth();

		const positionPk = new PublicKey(positionPubkey);
		const positionAccount = await this.connection.getAccountInfo(positionPk);
		if (!positionAccount) {
			throw new Error('Position account not found');
		}

		const data = positionAccount.data;
		if (data.length < 48 || !data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) {
			throw new Error('Invalid position account');
		}

		const ownerPk = new PublicKey(data.subarray(8, 40));
		if (!ownerPk.equals(authority)) {
			throw new Error('Position does not belong to this wallet');
		}

		const [userAccountPDA] = this.getUserAccountPDA(authority, 0);
		const priceBn = new anchor.BN(Math.floor(currentPrice * 1e6).toString());

		return await this.invokePaperTrading(
			'closePosition',
			[priceBn],
			{
				userAccount: userAccountPDA,
				position: positionPk,
			}
		);
	}

	/** Spot market leg: `notionalUsd` is USDT notional (or pass `opts.notionalUsd`). */
	async executeSpotTrade(
		pairSymbol: string,
		action: 'BUY' | 'SELL',
		currentPrice: number,
		tokenAmount: number,
		opts?: { notionalUsd?: number; takeProfitPrice?: number; stopLossPrice?: number }
	): Promise<string> {
		const notional =
			opts?.notionalUsd != null ? opts.notionalUsd : tokenAmount * currentPrice;
		return this.placePaperOrder({
			pairSymbol,
			side: action === 'BUY' ? 'long' : 'short',
			surface: 'spot',
			execution: 'market',
			notionalUsd: notional,
			takeProfitUsd: opts?.takeProfitPrice,
			stopLossUsd: opts?.stopLossPrice,
			marketPriceUsd: currentPrice,
		});
	}

	async fetchSpotTradeHistory(): Promise<any[]> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return [];
		}

		const spotTrades: any[] = [];

		try {
			// Fetch transaction history for each trading pair's user account
			for (const [symbol, pairIndex] of Object.entries(TRADING_PAIRS)) {
				try {
					const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);

					// Get recent transactions for this account
					const signatures = await this.connection.getSignaturesForAddress(userAccountPDA, {
						limit: 50 // Limit to last 50 transactions per pair
					});

					for (const sigInfo of signatures) {
						try {
							const tx = await this.connection.getTransaction(sigInfo.signature, {
								maxSupportedTransactionVersion: 0
							});

							if (!tx || !tx.meta || tx.meta.err) continue;

							// Parse the transaction to determine if it's a buy or sell
							const message = tx.transaction.message;
							const instructions = message.compiledInstructions || [];

							for (const ix of instructions) {
								// Check if this instruction is for our program
								const programIdIndex = ix.programIdIndex;
								const accountKeys = message.staticAccountKeys || message.accountKeys || [];

								if (accountKeys[programIdIndex]?.toBase58() !== PAPER_TRADING_PROGRAM_ID.toBase58()) continue;

								// Parse instruction data to determine type
								const data = Buffer.from(ix.data);
								if (data.length < 8) continue;

								const discriminator = data.slice(0, 8);

								// Calculate buy/sell discriminators
								const buyDiscriminator = await this.getMethodDiscriminator('global:buy');
								const sellDiscriminator = await this.getMethodDiscriminator('global:sell');

								let tradeType: 'BUY' | 'SELL' | null = null;

								if (discriminator.equals(buyDiscriminator)) {
									tradeType = 'BUY';
								} else if (discriminator.equals(sellDiscriminator)) {
									tradeType = 'SELL';
								}

								if (tradeType && data.length >= 24) {
									// Parse amount and price from instruction data
									const amountTokenOut = data.readBigUInt64LE(8);
									const priceScaled = data.readBigUInt64LE(16);

									const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
									const amount = Number(amountTokenOut) / Math.pow(10, pairDecimals.tokenOut);
									const price = Number(priceScaled) / 1e6;
									const value = amount * price;

									spotTrades.push({
										signature: sigInfo.signature,
										tradeType,
										pairIndex,
										pairSymbol: symbol,
										pair: `${symbol}/USDT`,
										size: amount,
										price,
										value,
										sizeUSDT: value,
										date: new Date((tx.blockTime || 0) * 1000).toLocaleDateString(),
										timestamp: new Date((tx.blockTime || 0) * 1000),
										status: 'COMPLETED',
										pnl: null // Spot trades don't have direct P&L
									});
								}
							}
						} catch (txError) {
							// Skip failed transaction parsing
						}
					}
				} catch (pairError) {
					// Skip failed pair
				}
			}

			// Sort by timestamp descending
			spotTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

		} catch (error) {
			console.error('Error fetching spot trade history:', error);
		}

		return spotTrades;
	}

	private async getMethodDiscriminator(methodName: string): Promise<Buffer> {
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		return Buffer.from(new Uint8Array(hash).slice(0, 8));
	}

	async fetchTradeHistory(): Promise<any[]> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return [];
		}

		const tradeHistory: any[] = [];

		try {
			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [{ memcmp: { offset: 8, bytes: currentWallet.publicKey.toBase58() } }],
			});

			for (const accountInfo of allAccounts) {
				try {
					const data = accountInfo.account.data;
					if (data.length < 152) continue;
					if (!data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) continue;

					const pairIndex = data[48];
					const positionId = data.readBigUInt64LE(40);
					const directionByte = data[50];
					const sizeUsd = data.readBigUInt64LE(52);
					const entryPrice = data.readBigUInt64LE(69);
					const takeProfitPrice = data.readBigUInt64LE(85);
					const stopLossPrice = data.readBigUInt64LE(93);
					const status = data[109];
					const openedAt = data.readBigInt64LE(110);
					const closedAt = data.readBigInt64LE(126);
					const closePrice = data.readBigUInt64LE(134);
					const realizedPnl = data.readBigInt64LE(142);

					const pairSymbols = ['SOL', 'BTC', 'ETH', 'AVAX', 'LINK'];
					const pairSymbol = pairSymbols[pairIndex] || 'UNKNOWN';
					const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
					if (!pairDecimals) continue;

					const entryPriceNum = Number(entryPrice) / 1e6;
					const notionalUsd = Number(sizeUsd) / 1e6;
					const amountNum =
						entryPriceNum > 0 ? notionalUsd / entryPriceNum : 0;
					const sizeUSDT = notionalUsd;
					const isClosed = status >= 2;
					const exitPriceNum = isClosed ? Number(closePrice) / 1e6 : entryPriceNum;
					const pnlUsd = isClosed ? Number(realizedPnl) / 1e6 : 0;

					tradeHistory.push({
						pubkey: accountInfo.pubkey.toBase58(),
						positionId: positionId.toString(),
						direction: directionByte === 0 ? 'LONG' : 'SHORT',
						tradeType: directionByte === 0 ? 'LONG' : 'SHORT',
						pairIndex,
						pairSymbol,
						pair: `${pairSymbol}/USDT`,
						type: isClosed ? 'CLOSED' : 'OPEN',
						size: amountNum,
						sizeUSDT,
						entryPrice: entryPriceNum,
						exitPrice: isClosed ? exitPriceNum : null,
						takeProfitPrice: takeProfitPrice > 0 ? Number(takeProfitPrice) / 1e6 : null,
						stopLossPrice: stopLossPrice > 0 ? Number(stopLossPrice) / 1e6 : null,
						status: isClosed ? 'CLOSED' : 'ACTIVE',
						openedAt: new Date(Number(openedAt) * 1000),
						closedAt: isClosed ? new Date(Number(closedAt) * 1000) : null,
						timestamp: isClosed
							? new Date(Number(closedAt) * 1000)
							: new Date(Number(openedAt) * 1000),
						pnl: pnlUsd,
					});
				} catch (parseError) {
					console.error('Error parsing position for history:', parseError);
				}
			}

			// Also fetch spot trades
			try {
				const spotTrades = await this.fetchSpotTradeHistory();
				tradeHistory.push(...spotTrades);
			} catch (spotError) {
				console.error('Error fetching spot trades:', spotError);
			}

			// Sort all trades by timestamp (most recent first)
			tradeHistory.sort((a, b) => {
				const dateA = a.timestamp || a.closedAt || a.openedAt;
				const dateB = b.timestamp || b.closedAt || b.openedAt;
				return dateB.getTime() - dateA.getTime();
			});

		} catch (error) {
			console.error('Error fetching trade history:', error);
		}

		return tradeHistory;
	}

	async fetchPositions(): Promise<any[]> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return [];
		}

		/** Position.owner matches the user PDA owner (main wallet), not the session key. */
		const paperPositionOwner =
			this.connectedWallet?.connected && this.connectedWallet.publicKey
				? this.connectedWallet.publicKey
				: currentWallet.publicKey;

		let positions: any[] = [];

		// Unified on-chain paper positions (Anchor `Position` account)
		try {
			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [{ memcmp: { offset: 8, bytes: paperPositionOwner.toBase58() } }],
			});

			for (const accountInfo of allAccounts) {
				try {
					const data = accountInfo.account.data;
					if (data.length < 152) continue;
					if (!data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) continue;

					const pairIndex = data[48];
					const tradeModeByte = data[49];
					const directionByte = data[50];
					const orderTypeByte = data[51];
					const sizeUsd = data.readBigUInt64LE(52);
					const marginUsd = data.readBigUInt64LE(60);
					const leverage = data[68];
					const entryPrice = data.readBigUInt64LE(69);
					const limitPriceRaw = data.readBigUInt64LE(77);
					const takeProfitPrice = data.readBigUInt64LE(85);
					const stopLossPrice = data.readBigUInt64LE(93);
					const liquidationPriceRaw = data.readBigUInt64LE(101);
					const status = data[109];
					const openedAt = data.readBigInt64LE(110);

					const pairSymbols = ['SOL', 'BTC', 'ETH', 'AVAX', 'LINK'];
					const pairSymbol = pairSymbols[pairIndex] || 'UNKNOWN';
					const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
					if (!pairDecimals) continue;

					// PendingFill === 0, Active === 1
					if (status !== 0 && status !== 1) continue;

					const limitF = Number(limitPriceRaw) / 1e6;
					const entryF = Number(entryPrice) / 1e6;
					const notionalUsd = Number(sizeUsd) / 1e6;
					const refPrice =
						status === 0 && orderTypeByte === 1 && limitF > 0 ? limitF : entryF;
					const pseudoTokenAmount =
						refPrice > 0 ? notionalUsd / refPrice : 0;

					const liqF = Number(liquidationPriceRaw) / 1e6;

					positions.push({
						type: 'direct',
						pubkey: accountInfo.pubkey.toBase58(),
						positionId: data.readBigUInt64LE(40).toString(),
						direction: directionByte === 0 ? 'LONG' : 'SHORT',
						pairIndex,
						pairSymbol,
						tradeMode: tradeModeByte === 1 ? 'perp' : 'spot',
						orderType: orderTypeByte === 1 ? 'limit' : 'market',
						amountTokenOut: pseudoTokenAmount,
						entryPrice: entryF,
						limitPrice: limitF > 0 ? limitF : null,
						notionalUsd,
						marginUsd: Number(marginUsd) / 1e6,
						leverage,
						takeProfitPrice: takeProfitPrice > 0 ? Number(takeProfitPrice) / 1e6 : null,
						stopLossPrice: stopLossPrice > 0 ? Number(stopLossPrice) / 1e6 : null,
						liquidationPrice: liqF > 0 ? liqF : null,
						openedAt: new Date(Number(openedAt) * 1000),
						status: status === 0 ? 'PENDING' : 'ACTIVE',
					});
				} catch {
					//
				}
			}
		} catch {
			//
		}

		return positions;
	}

	async requestAirdrop(amount: number = 1): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const signature = await this.connection.requestAirdrop(
			currentWallet.publicKey,
			amount * LAMPORTS_PER_SOL
		);

		return signature;
	}

	async getBalance(): Promise<number> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return 0;
		}

		try {
			const solanaConnection = new Connection(SOLANA_RPC, 'confirmed');
			const balance = await solanaConnection.getBalance(currentWallet.publicKey);
			return balance / LAMPORTS_PER_SOL;
		} catch (error) {
			const balance = await this.connection.getBalance(currentWallet.publicKey);
			return balance / LAMPORTS_PER_SOL;
		}
	}

	/**
	 * Sum of open spot LONG base size per pair (from `Position` accounts).
	 * Unified `UserAccount` only stores USDT; synthetic "SOL/BTC…" balance in the UI comes from here.
	 */
	private async fetchSpotLongBaseHeldByPair(owner: PublicKey): Promise<Record<number, number>> {
		const held: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
		try {
			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
			});

			for (const accountInfo of allAccounts) {
				const data = accountInfo.account.data;
				if (data.length < 152) continue;
				if (!data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) continue;

				const pairIndex = data[48];
				const tradeModeByte = data[49];
				const directionByte = data[50];
				const orderTypeByte = data[51];
				const status = data[109];

				if (tradeModeByte !== 0 || directionByte !== 0) continue;
				if (status !== 0 && status !== 1) continue;

				const sizeUsd = data.readBigUInt64LE(52);
				const entryPrice = data.readBigUInt64LE(69);
				const limitPriceRaw = data.readBigUInt64LE(77);
				const limitF = Number(limitPriceRaw) / 1e6;
				const entryF = Number(entryPrice) / 1e6;
				const notionalUsd = Number(sizeUsd) / 1e6;
				const refPrice =
					status === 0 && orderTypeByte === 1 && limitF > 0 ? limitF : entryF;
				if (refPrice <= 0) continue;

				const base = notionalUsd / refPrice;
				if (pairIndex >= 0 && pairIndex <= 4) {
					held[pairIndex] = (held[pairIndex] ?? 0) + base;
				}
			}
		} catch {
			//
		}
		return held;
	}

	private parseUnifiedUserAccountBuffer(data: Buffer): {
		tokenInBalance: number;
		totalPositions: number;
		totalUsdtUsd: number;
		lockedMarginUsd: number;
		availableUsd: number;
	} | null {
		if (
			data.length < UNIFIED_USER_DATA_LEN ||
			!data.subarray(0, 8).equals(USER_ACCOUNT_DISCRIMINATOR)
		) {
			return null;
		}
		const usdtRaw = data.readBigUInt64LE(40);
		const lockedRaw = data.readBigUInt64LE(48);
		const totalPositions = Number(data.readBigUInt64LE(56));
		const total = Number(usdtRaw) / 1e6;
		const locked = Number(lockedRaw) / 1e6;
		const available = Math.max(0, total - locked);
		return {
			tokenInBalance: total,
			totalPositions,
			totalUsdtUsd: total,
			lockedMarginUsd: locked,
			availableUsd: available,
		};
	}

	/** Unified USDT row + synthetic base balance for this pair (open spot longs). */
	async getUserAccountData(
		pairIndex: number
	): Promise<{
		tokenInBalance: number;
		tokenOutBalance: number;
		totalPositions: number;
		/** Same as tokenInBalance — total USDT including margin locked in positions. */
		totalUsdtUsd: number;
		lockedMarginUsd: number;
		availableUsd: number;
	} | null> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return null;
		}

		try {
			const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);
			const accountInfo = await this.connection.getAccountInfo(userAccountPDA, 'confirmed');

			if (!accountInfo) {
				return null;
			}

			const unified = this.parseUnifiedUserAccountBuffer(accountInfo.data);
			if (!unified) {
				return null;
			}

			const spotHeld = await this.fetchSpotLongBaseHeldByPair(currentWallet.publicKey);
			return {
				...unified,
				tokenOutBalance: spotHeld[pairIndex] ?? 0,
			};
		} catch (error) {
			return null;
		}
	}

	// Same unified USDT for every pair index; tokenOutBalance is per-pair spot long exposure.
	async getAllUserAccountData(): Promise<{
		[pairIndex: number]: {
			tokenInBalance: number;
			tokenOutBalance: number;
			totalPositions: number;
			totalUsdtUsd: number;
			lockedMarginUsd: number;
			availableUsd: number;
		};
	}> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return {};
		}

		const accountData: {
			[pairIndex: number]: {
				tokenInBalance: number;
				tokenOutBalance: number;
				totalPositions: number;
				totalUsdtUsd: number;
				lockedMarginUsd: number;
				availableUsd: number;
			};
		} = {};

		try {
			const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey);
			const accountInfo = await this.connection.getAccountInfo(userAccountPDA, 'confirmed');
			if (!accountInfo) {
				return {};
			}

			const unified = this.parseUnifiedUserAccountBuffer(accountInfo.data);
			if (!unified) {
				return {};
			}

			const spotHeld = await this.fetchSpotLongBaseHeldByPair(currentWallet.publicKey);

			for (const [, pairIndex] of Object.entries(TRADING_PAIRS)) {
				const idx = Number(pairIndex);
				accountData[idx] = {
					...unified,
					tokenOutBalance: spotHeld[idx] ?? 0,
				};
			}
		} catch {
			//
		}

		return accountData;
	}

	async fetchLeaderboard(currentPrices?: Record<string, number>): Promise<any[]> {
		try {
			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [{ dataSize: UNIFIED_USER_DATA_LEN }],
			});

			const leaderboard: {
				address: string;
				pnl: number;
				trades: number;
				balance: number;
			}[] = [];

			for (const accountInfo of allAccounts) {
				try {
					const data = accountInfo.account.data;
					if (!data.subarray(0, 8).equals(USER_ACCOUNT_DISCRIMINATOR)) continue;

					const owner = new PublicKey(data.subarray(8, 40)).toBase58();
					const usdtBalance = Number(data.readBigUInt64LE(40)) / 1e6;
					const totalPositions = Number(data.readBigUInt64LE(56));

					const pnl = usdtBalance - 100_000;

					leaderboard.push({
						address: owner.substring(0, 8),
						pnl,
						trades: totalPositions,
						balance: usdtBalance,
					});
				} catch {
					//
				}
			}

			leaderboard.sort((a, b) => b.pnl - a.pnl);

			return leaderboard.map((entry, index) => ({
				...entry,
				rank: index + 1,
			}));
		} catch (error) {
			return [];
		}
	}

}

export const magicBlockClient = new MagicBlockClient();

export { sessionKeyManager } from './solana/session-keys';
