import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { FindEntityPda, ApplySystem, SerializeArgs, BN, anchor } from '@magicblock-labs/bolt-sdk';
import type { Adapter, SignerWalletAdapter } from '@solana/wallet-adapter-base';
import * as ENV from './env';

export const MAGICBLOCK_RPC = ENV.MAGICBLOCK_RPC;
export const SOLANA_RPC = ENV.SOLANA_RPC;

// Paper Trading Program ID from the contract
export const PAPER_TRADING_PROGRAM_ID = new PublicKey(ENV.PAPER_TRADING_PROGRAM_ID);

export const COMPONENT_IDS = {
	TRADING_ACCOUNT: new PublicKey(ENV.COMPONENT_IDS.TRADING_ACCOUNT),
	COMPETITION: new PublicKey(ENV.COMPONENT_IDS.COMPETITION),
	POSITION: new PublicKey(ENV.COMPONENT_IDS.POSITION),
	LEADERBOARD: new PublicKey(ENV.COMPONENT_IDS.LEADERBOARD),
};

export const SYSTEM_IDS = {
	JOIN_COMPETITION: new PublicKey(ENV.SYSTEM_IDS.JOIN_COMPETITION),
	OPEN_POSITION: new PublicKey(ENV.SYSTEM_IDS.OPEN_POSITION),
	CLOSE_POSITION: new PublicKey(ENV.SYSTEM_IDS.CLOSE_POSITION),
	SETTLE_COMPETITION: new PublicKey(ENV.SYSTEM_IDS.SETTLE_COMPETITION),
};

export const TRADING_PAIRS = {
	SOL: 0,
	BTC: 1,
	ETH: 2,
	AVAX: 3,
	LINK: 4,
};

export enum TournamentStatus {
	Pending = 0,    // Registration open
	Active = 1,     // Trading active
	Ended = 2,      // Trading ended, awaiting settlement
	Settled = 3,    // Prizes distributed
}

export interface Tournament {
	pubkey: string;
	id: number;
	creator: string;
	entryFee: number;      // in SOL
	prizePool: number;     // in SOL
	cooldownEnd: Date;
	endTime: Date;
	status: TournamentStatus;
	participantCount: number;
	createdAt: Date;
}

export interface TournamentParticipant {
	pubkey: string;
	tournament: string;
	user: string;
	usdtBalance: number;
	solBalance: number;
	btcBalance: number;
	ethBalance: number;
	avaxBalance: number;
	linkBalance: number;
	totalPositions: number;
	joinedAt: Date;
}

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

export const WORLD_ID = new BN(ENV.WORLD_ID);
export const WORLD_INSTANCE_ID = new PublicKey(ENV.WORLD_INSTANCE_ID);

export class MagicBlockClient {
	connection: Connection;
	wallet: Keypair | null = null;
	sessionWallet: Keypair | null = null;
	connectedWallet: Adapter | null = null;
	entityPda: PublicKey | null = null;
	competitionEntity: PublicKey | null = null;

	constructor() {
		this.connection = new Connection(MAGICBLOCK_RPC, 'confirmed');
	}

	// Set connected wallet adapter
	async setConnectedWallet(wallet: Adapter | null) {
		this.connectedWallet = wallet;

		if (wallet?.connected && wallet.publicKey) {
			await this.initializeEntity();
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

	// Get user account PDA for a specific pair
	getUserAccountPDA(userPubkey: PublicKey, pairIndex: number): [PublicKey, number] {
		return PublicKey.findProgramAddressSync(
			[
				Buffer.from('user'),
				userPubkey.toBuffer(),
				Buffer.from([pairIndex])
			],
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

	// Initialize trading account for a user - MagicBlock ephemeral rollup approach
	async initializeAccount(pairIndex: number, entryFee: number = 0.1, initialTokenIn: number = 10000): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		try {
			const solanaConnection = new Connection(SOLANA_RPC, 'confirmed');
			const balance = await solanaConnection.getBalance(currentWallet.publicKey);
			if (balance < 100000000) {
				throw new Error('Insufficient SOL balance');
			}

			const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);
			const [configPDA] = this.getConfigPDA();

			const existingAccount = await this.connection.getAccountInfo(userAccountPDA);
			if (existingAccount) {
				return 'account_already_exists';
			}

			const configAccountInfo = await this.connection.getAccountInfo(configPDA);
			if (!configAccountInfo) {
				throw new Error('Config account not initialized. Contact admin.');
			}

			const treasuryPubkey = new PublicKey(configAccountInfo.data.subarray(40, 72));

			const entryFeeScaled = Math.floor(entryFee * LAMPORTS_PER_SOL);
			const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
			const initialTokenInScaled = Math.floor(initialTokenIn * Math.pow(10, pairDecimals.tokenIn));

			// Setup for potential Anchor usage (keeping for future use)

			// Calculate the correct Anchor discriminator
			const methodName = "global:initialize_account";
			const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
			const discriminator = new Uint8Array(hash).slice(0, 8);
			
			
			// Create instruction data buffer (discriminator + pair_index + entry_fee + initial_token_in + token_in_decimals + token_out_decimals)
			const instructionData = Buffer.alloc(27);
			Buffer.from(discriminator).copy(instructionData, 0);
			instructionData.writeUInt8(pairIndex, 8);
			instructionData.writeBigUInt64LE(BigInt(entryFeeScaled), 9);
			instructionData.writeBigUInt64LE(BigInt(initialTokenInScaled), 17);
			instructionData.writeUInt8(pairDecimals.tokenIn, 25);
			instructionData.writeUInt8(pairDecimals.tokenOut, 26);

			const instruction = new TransactionInstruction({
				keys: [
					{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
					{ pubkey: configPDA, isSigner: false, isWritable: false },
					{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: true },
					{ pubkey: treasuryPubkey, isSigner: false, isWritable: true },
					{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
				],
				programId: PAPER_TRADING_PROGRAM_ID,
				data: instructionData
			});

			const transaction = new Transaction().add(instruction);
			
			// Get fresh blockhash to avoid duplicate transaction issues
			const latestBlockhash = await this.connection.getLatestBlockhash('finalized');
			transaction.recentBlockhash = latestBlockhash.blockhash;
			transaction.feePayer = currentWallet.publicKey;

			// Sign and send transaction on main chain
			let signature: string;
			if (currentWallet.signTransaction) {
				const signedTx = await currentWallet.signTransaction(transaction);
				try {
					signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
						skipPreflight: false,
						preflightCommitment: 'finalized'
					});
				} catch (error: any) {
					if (error.name === 'SendTransactionError') {
						if (error.message?.includes('This transaction has already been processed')) {
							throw new Error('Transaction already processed. Please wait a moment before trying again.');
						}
					}
					throw error;
				}
			} else {
				throw new Error('Wallet does not support transaction signing');
			}

			
			// Wait for confirmation
			await this.connection.confirmTransaction(signature, 'confirmed');
			
			return signature;
		} catch (error) {
			throw error;
		}
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
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) return;

		try {
			this.entityPda = FindEntityPda({
				worldId: WORLD_ID,
				seed: Buffer.from(currentWallet.publicKey.toBytes()),
			});

			this.competitionEntity = new PublicKey(ENV.COMPETITION_ENTITY);
		} catch (e) {
		}
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

	async getTradingAccountPDA(owner: PublicKey): Promise<[PublicKey, number]> {
		return PublicKey.findProgramAddressSync(
			[Buffer.from('trading-account'), owner.toBuffer()],
			COMPONENT_IDS.TRADING_ACCOUNT
		);
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

	async getPositionPDA(
		tradingAccount: PublicKey,
		positionId: number
	): Promise<[PublicKey, number]> {
		return PublicKey.findProgramAddressSync(
			[Buffer.from('position'), tradingAccount.toBuffer(), Buffer.from([positionId])],
			COMPONENT_IDS.POSITION
		);
	}

	async openPosition(
		pairSymbol: string,
		direction: PositionDirection,
		currentPrice: number,
		size: number,
		takeProfit?: number,
		stopLoss?: number
	): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const pairIndex = TRADING_PAIRS[pairSymbol as keyof typeof TRADING_PAIRS];
		if (pairIndex === undefined) {
			throw new Error(`Unknown trading pair: ${pairSymbol}`);
		}

		// First try MagicBlock rollup execution
		try {
			return await this.openMagicBlockPosition(
				currentWallet,
				pairIndex,
				direction,
				currentPrice,
				size,
				takeProfit,
				stopLoss
			);
		} catch (error) {
			
			// Fallback to direct contract call
			return await this.openDirectPosition(
				currentWallet,
				pairIndex,
				direction,
				currentPrice,
				size,
				takeProfit,
				stopLoss
			);
		}
	}

	private async openMagicBlockPosition(
		currentWallet: any,
		pairIndex: number,
		direction: PositionDirection,
		currentPrice: number,
		size: number,
		takeProfit?: number,
		stopLoss?: number
	): Promise<string> {
		
		// Get decimal configuration for this pair
		const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
		
		// Instead of using Bolt systems, let's execute the paper trading program directly
		const priceScaled = Math.floor(currentPrice * 1e6); // Price always has 6 decimals
		const amountTokenOut = Math.floor((size / currentPrice) * Math.pow(10, pairDecimals.tokenOut));
		const requiredTokenIn = Math.floor(size * Math.pow(10, pairDecimals.tokenIn));
		const takeProfitScaled = takeProfit ? Math.floor(takeProfit * 1e6) : 0;
		const stopLossScaled = stopLoss ? Math.floor(stopLoss * 1e6) : 0;

		// Check if user has sufficient balance before attempting the transaction
		const accountData = await this.getUserAccountData(pairIndex);
		if (!accountData) {
			throw new Error(`Trading account not found for pair ${pairIndex}. Please initialize first.`);
		}

		const requiredBalance = requiredTokenIn / Math.pow(10, pairDecimals.tokenIn); // Convert back to readable format for comparison
		const epsilon = 0.01; // Allow 0.01 USDT tolerance for floating point precision

		if (accountData.tokenInBalance < requiredBalance - epsilon) {
			throw new Error(`Insufficient balance. Required: ${requiredBalance.toFixed(2)} USDT, Available: ${accountData.tokenInBalance.toFixed(2)} USDT`);
		}

		// Get the user account PDA for this pair
		const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);
		
		// Check if account is initialized on MagicBlock
		const accountInfo = await this.connection.getAccountInfo(userAccountPDA);
		if (!accountInfo) {
			throw new Error(`Trading account not initialized for pair ${pairIndex}. Please initialize first.`);
		}

		// Create the instruction data for the paper trading program
		let methodName: string;
		if (direction === PositionDirection.Long) {
			methodName = "global:open_long_position";
		} else {
			methodName = "global:open_short_position";  
		}

		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		// Create instruction data buffer (discriminator + 4 u64s)
		const instructionData = Buffer.alloc(8 + 32); // 8 bytes discriminator + 32 bytes for 4 u64s
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(amountTokenOut), 8);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 16);
		instructionData.writeBigUInt64LE(BigInt(takeProfitScaled), 24);
		instructionData.writeBigUInt64LE(BigInt(stopLossScaled), 32);

		// Calculate position PDA - read total_positions from account data
		// Updated UserAccount structure: discriminator(8) + owner(32) + pair_index(1) + token_in_balance(8) + token_out_balance(8) + token_in_decimals(1) + token_out_decimals(1) + total_positions(8)
		const dataView = new DataView(accountInfo.data.buffer, accountInfo.data.byteOffset, accountInfo.data.byteLength);
		const totalPositions = dataView.getBigUint64(8 + 32 + 1 + 8 + 8 + 1 + 1, true); // little endian
		
		// Convert totalPositions to little endian bytes (8 bytes for u64)
		const totalPositionsBuffer = Buffer.allocUnsafe(8);
		totalPositionsBuffer.writeBigUInt64LE(totalPositions);

		const [positionPDA] = PublicKey.findProgramAddressSync(
			[
				Buffer.from('position'),
				currentWallet.publicKey.toBuffer(),
				Buffer.from([pairIndex]),
				totalPositionsBuffer
			],
			PAPER_TRADING_PROGRAM_ID
		);

		// Create the transaction instruction to execute on MagicBlock
		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
				{ pubkey: positionPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: true },
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
			],
			programId: PAPER_TRADING_PROGRAM_ID,
			data: instructionData
		});

		const transaction = new Transaction().add(instruction);
		
		// Get fresh blockhash from MagicBlock connection
		const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
		transaction.recentBlockhash = latestBlockhash.blockhash;
		transaction.feePayer = currentWallet.publicKey;

		const signedTx = await currentWallet.signTransaction(transaction);
		
		let signature: string;
		try {
			signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
				skipPreflight: false,
				preflightCommitment: 'confirmed'
			});
		} catch (error: any) {
			if (error.name === 'SendTransactionError') {
				if (error.message?.includes('This transaction has already been processed')) {
					// Check if we can extract the signature from the error or transaction
					// If the transaction was already processed, it likely succeeded
					
					// Try to get the signature from the serialized transaction
					try {
						const txSignature = signedTx.signatures[0]?.toString();
						if (txSignature) {
							// Check transaction status
							const status = await this.connection.getSignatureStatus(txSignature);
							if (status.value?.confirmationStatus) {
								return txSignature;
							}
						}
					} catch (sigError) {
					}
					
					throw new Error('Transaction already processed. Please wait a moment before trying again.');
				}
			}
			throw error;
		}

		// Wait for confirmation on MagicBlock
		await this.connection.confirmTransaction({
			signature,
			blockhash: latestBlockhash.blockhash,
			lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
		}, 'confirmed');

		return signature;
	}

	private async openDirectPosition(
		currentWallet: any,
		pairIndex: number,
		direction: PositionDirection,
		currentPrice: number,
		size: number,
		takeProfit?: number,
		stopLoss?: number
	): Promise<string> {
		// Use MagicBlock connection only to avoid rate limits
		
		const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);
		
		// Check if account is initialized
		const accountInfo = await this.connection.getAccountInfo(userAccountPDA);
		if (!accountInfo) {
			throw new Error(`Trading account not initialized for pair ${pairIndex}. Please initialize first.`);
		}

		// Get decimal configuration for this pair
		const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
		
		const priceScaled = Math.floor(currentPrice * 1e6); // Price always has 6 decimals
		const amountTokenOut = Math.floor((size / currentPrice) * Math.pow(10, pairDecimals.tokenOut));
		const requiredTokenIn = Math.floor(size * Math.pow(10, pairDecimals.tokenIn));
		const takeProfitScaled = takeProfit ? Math.floor(takeProfit * 1e6) : 0;
		const stopLossScaled = stopLoss ? Math.floor(stopLoss * 1e6) : 0;

		// Check balance using MagicBlock connection
		const accountData = await this.getUserAccountData(pairIndex);
		
		if (!accountData) {
			throw new Error(`Trading account not found for pair ${pairIndex}. Please initialize first.`);
		}

		const requiredBalance = requiredTokenIn / Math.pow(10, pairDecimals.tokenIn); // Convert back to readable format

		if (accountData.tokenInBalance < requiredBalance) {
			throw new Error(`Insufficient balance. Required: ${requiredBalance.toFixed(2)} USDT, Available: ${accountData.tokenInBalance.toFixed(2)} USDT`);
		}

		// Create the instruction data
		let methodName: string;
		if (direction === PositionDirection.Long) {
			methodName = "global:open_long_position";
		} else {
			methodName = "global:open_short_position";  
		}

		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		// Create instruction data buffer (discriminator + 4 u64s)
		const instructionData = Buffer.alloc(8 + 32); // 8 bytes discriminator + 32 bytes for 4 u64s
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(amountTokenOut), 8);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 16);
		instructionData.writeBigUInt64LE(BigInt(takeProfitScaled), 24);
		instructionData.writeBigUInt64LE(BigInt(stopLossScaled), 32);

		// Calculate position PDA - read total_positions from account data
		// Updated UserAccount structure: discriminator(8) + owner(32) + pair_index(1) + token_in_balance(8) + token_out_balance(8) + token_in_decimals(1) + token_out_decimals(1) + total_positions(8)
		const dataView = new DataView(accountInfo.data.buffer, accountInfo.data.byteOffset, accountInfo.data.byteLength);
		const totalPositions = dataView.getBigUint64(8 + 32 + 1 + 8 + 8 + 1 + 1, true); // little endian
		
		// Convert totalPositions to little endian bytes (8 bytes for u64)
		const totalPositionsBuffer = Buffer.allocUnsafe(8);
		totalPositionsBuffer.writeBigUInt64LE(totalPositions);

		const [positionPDA] = PublicKey.findProgramAddressSync(
			[
				Buffer.from('position'),
				currentWallet.publicKey.toBuffer(),
				Buffer.from([pairIndex]),
				totalPositionsBuffer
			],
			PAPER_TRADING_PROGRAM_ID
		);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
				{ pubkey: positionPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: true },
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
			],
			programId: PAPER_TRADING_PROGRAM_ID,
			data: instructionData
		});

		const transaction = new Transaction().add(instruction);
		
		// Get fresh blockhash
		const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
		transaction.recentBlockhash = latestBlockhash.blockhash;
		transaction.feePayer = currentWallet.publicKey;

		const signedTx = await currentWallet.signTransaction(transaction);
		
		let signature: string;
		try {
			signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
				skipPreflight: false,
				preflightCommitment: 'confirmed'
			});
		} catch (error: any) {
			if (error.name === 'SendTransactionError') {
				if (error.message?.includes('This transaction has already been processed')) {
					// Check if the transaction actually succeeded
					
					try {
						const txSignature = signedTx.signatures[0]?.toString();
						if (txSignature) {
							const status = await this.connection.getSignatureStatus(txSignature);
							if (status.value?.confirmationStatus) {
								return txSignature;
							}
						}
					} catch (sigError) {
					}
					
					throw new Error('Transaction already processed. Please wait a moment before trying again.');
				}
			}
			throw error;
		}

		// Wait for confirmation
		await this.connection.confirmTransaction({
			signature,
			blockhash: latestBlockhash.blockhash,
			lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
		}, 'confirmed');

		return signature;
	}

	async closeDirectPosition(positionPubkey: string, currentPrice: number): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}


		// Use MagicBlock connection only to avoid rate limits
		
		// Get position account to read the data
		const positionAccountPubkey = new PublicKey(positionPubkey);
		const positionAccount = await this.connection.getAccountInfo(positionAccountPubkey);
		if (!positionAccount) {
			throw new Error('Position account not found');
		}

		// Parse position data to get pair_index
		const data = positionAccount.data;
		let offset = 8; // Skip discriminator
		offset += 32; // Skip owner
		const pairIndex = data[offset]; // pair_index

		// Get user account PDA
		const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);

		// Create the instruction data for close_position
		const methodName = "global:close_position";
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		// Create instruction data buffer (discriminator + current_price u64)
		const instructionData = Buffer.alloc(8 + 8); // 8 bytes discriminator + 8 bytes for u64
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(Math.floor(currentPrice * 1e6)), 8); // Price with 6 decimals

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: positionAccountPubkey, isSigner: false, isWritable: true },
				{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false },
			],
			programId: PAPER_TRADING_PROGRAM_ID,
			data: instructionData
		});

		const transaction = new Transaction().add(instruction);
		
		// Get fresh blockhash
		const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
		transaction.recentBlockhash = latestBlockhash.blockhash;
		transaction.feePayer = currentWallet.publicKey;

		const signedTx = await currentWallet.signTransaction!(transaction);
		
		let signature: string;
		try {
			signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
				skipPreflight: false,
				preflightCommitment: 'confirmed'
			});
		} catch (error: any) {
			if (error.name === 'SendTransactionError') {
				if (error.message?.includes('This transaction has already been processed')) {
					// For close position, this usually means the position was successfully closed
					
					try {
						const txSignature = signedTx.signatures[0]?.toString();
						if (txSignature) {
							return txSignature;
						}
					} catch (sigError) {
					}
					
					// Return success indicator - position likely closed successfully  
					return 'close_position_success';
				}
			}
			throw error;
		}

		// Wait for confirmation
		await this.connection.confirmTransaction({
			signature,
			blockhash: latestBlockhash.blockhash,
			lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
		}, 'confirmed');

		return signature;
	}

	async executeSpotTrade(
		pairSymbol: string,
		action: 'BUY' | 'SELL',
		currentPrice: number,
		tokenAmount: number
	): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const pairIndex = TRADING_PAIRS[pairSymbol as keyof typeof TRADING_PAIRS];
		if (pairIndex === undefined) {
			throw new Error(`Unknown trading pair: ${pairSymbol}`);
		}

		// Check if account is initialized
		const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);
		const accountInfo = await this.connection.getAccountInfo(userAccountPDA);
		if (!accountInfo) {
			throw new Error(`Trading account not initialized for pair ${pairIndex}. Please initialize first.`);
		}

		// Get decimal configuration for this pair
		const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];
		
		// Contract expects amount_token_out in proper token decimals
		const amountTokenOut = Math.floor(tokenAmount * Math.pow(10, pairDecimals.tokenOut));
		const priceScaled = Math.floor(currentPrice * 1e6); // Price always has 6 decimals

		// Check balance before executing trade
		const accountData = await this.getUserAccountData(pairIndex);
		if (!accountData) {
			throw new Error(`Trading account not found for pair ${pairIndex}. Please initialize first.`);
		}

		if (action === 'BUY') {
			// For buying, check if we have enough USDT
			const requiredUSDT = tokenAmount * currentPrice;
			const availableUSDT = accountData.tokenInBalance;
			if (availableUSDT < requiredUSDT) {
				throw new Error(`Insufficient USDT balance. Required: ${requiredUSDT.toFixed(2)}, Available: ${availableUSDT.toFixed(2)}`);
			}
		} else {
			// For selling, check if we have enough tokens
			const availableTokenAmount = accountData.tokenOutBalance;
			if (availableTokenAmount < tokenAmount) {
				throw new Error(`Insufficient token balance. Required: ${tokenAmount.toFixed(6)}, Available: ${availableTokenAmount.toFixed(6)}`);
			}
		}

		// Create the instruction data for buy/sell
		let methodName: string;
		if (action === 'BUY') {
			methodName = "global:buy";
		} else {
			methodName = "global:sell";
		}

		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		// Create instruction data buffer (discriminator + amount_token_out u64 + price u64)
		const instructionData = Buffer.alloc(8 + 8 + 8); // 8 bytes discriminator + 8 bytes amount + 8 bytes price
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(amountTokenOut), 8);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 16);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: userAccountPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: true },
			],
			programId: PAPER_TRADING_PROGRAM_ID,
			data: instructionData
		});

		const transaction = new Transaction().add(instruction);
		
		// Get fresh blockhash
		const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
		transaction.recentBlockhash = latestBlockhash.blockhash;
		transaction.feePayer = currentWallet.publicKey;

		const signedTx = await currentWallet.signTransaction!(transaction);
		
		let signature: string;
		try {
			signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
				skipPreflight: false,
				preflightCommitment: 'confirmed'
			});
		} catch (error: any) {
			if (error.name === 'SendTransactionError') {
				if (error.message?.includes('This transaction has already been processed')) {
					// For spot trades, this usually means the trade was successful
					
					try {
						const txSignature = signedTx.signatures[0]?.toString();
						if (txSignature) {
							return txSignature;
						}
					} catch (sigError) {
					}
					
					// Return success indicator - trade likely completed successfully  
					return 'spot_trade_success';
				}
			}
			throw error;
		}

		// Wait for confirmation
		await this.connection.confirmTransaction({
			signature,
			blockhash: latestBlockhash.blockhash,
			lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
		}, 'confirmed');

		return signature;
	}

	async closePosition(positionId: string): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet || !this.entityPda || !this.competitionEntity) {
			throw new Error('Wallet not connected or entity not initialized');
		}


		try {
			const positionEntityPda = new PublicKey(positionId);

			const { transaction } = await ApplySystem({
				authority: currentWallet.publicKey,
				systemId: SYSTEM_IDS.CLOSE_POSITION,
				entities: [
					{
						entity: this.competitionEntity,
						components: [{ componentId: COMPONENT_IDS.COMPETITION }],
					},
					{
						entity: this.entityPda,
						components: [{ componentId: COMPONENT_IDS.TRADING_ACCOUNT }],
					},
					{
						entity: positionEntityPda,
						components: [{ componentId: COMPONENT_IDS.POSITION }],
					},
				],
				world: WORLD_INSTANCE_ID,
			});

			// Get fresh blockhash and set transaction properties
			const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
			transaction.recentBlockhash = latestBlockhash.blockhash;
			transaction.feePayer = currentWallet.publicKey;

			// Sign and send transaction
			let signature: string;
			if (currentWallet.signTransaction) {
				const signedTx = await currentWallet.signTransaction(transaction);
				try {
					signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
						skipPreflight: false,
						preflightCommitment: 'confirmed'
					});
				} catch (error: any) {
					if (error.name === 'SendTransactionError') {
						if (error.message?.includes('This transaction has already been processed')) {
							throw new Error('Transaction already processed. Please wait a moment before trying again.');
						}
					}
					throw error;
				}
				
				// Wait for confirmation
				await this.connection.confirmTransaction({
					signature,
					blockhash: latestBlockhash.blockhash,
					lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
				}, 'confirmed');
			} else if (this.sessionWallet) {
				// Fallback to session wallet signing
				signature = await sendAndConfirmTransaction(
					this.connection,
					transaction,
					[this.sessionWallet],
					{ commitment: 'confirmed' }
				);
			} else {
				throw new Error('No signing method available');
			}

			return signature;
		} catch (error) {
			throw error;
		}
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
			const positionAccountSize = 104;

			// Fetch ALL position accounts for this user (including closed)
			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [
					{
						dataSize: positionAccountSize
					},
					{
						memcmp: {
							offset: 8, // Skip discriminator, match owner
							bytes: currentWallet.publicKey.toBase58()
						}
					}
				]
			});

			for (const accountInfo of allAccounts) {
				try {
					const data = accountInfo.account.data;
					const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

					let offset = 8; // Skip discriminator

					// owner: Pubkey (32 bytes)
					offset += 32;

					// pair_index: u8 (1 byte)
					const pairIndex = data[offset];
					offset += 1;

					// position_id: u64 (8 bytes)
					const positionId = dataView.getBigUint64(offset, true);
					offset += 8;

					// position_type: PositionType (1 byte) - 0 = Long, 1 = Short
					const positionType = data[offset];
					offset += 1;

					// amount_token_out: u64 (8 bytes)
					const amountTokenOut = dataView.getBigUint64(offset, true);
					offset += 8;

					// entry_price: u64 (8 bytes)
					const entryPrice = dataView.getBigUint64(offset, true);
					offset += 8;

					// take_profit_price: u64 (8 bytes)
					const takeProfitPrice = dataView.getBigUint64(offset, true);
					offset += 8;

					// stop_loss_price: u64 (8 bytes)
					const stopLossPrice = dataView.getBigUint64(offset, true);
					offset += 8;

					// status: PositionStatus (1 byte) - 0 = Active, 1 = Closed
					const status = data[offset];
					offset += 1;

					// opened_at: i64 (8 bytes)
					const openedAt = dataView.getBigInt64(offset, true);
					offset += 8;

					// closed_at: i64 (8 bytes)
					const closedAt = dataView.getBigInt64(offset, true);
					offset += 8;

					// exit_price: u64 (8 bytes) - if available in struct
					let exitPrice = BigInt(0);
					if (offset + 8 <= data.length) {
						exitPrice = dataView.getBigUint64(offset, true);
					}

					// Get pair symbol and decimals
					const pairSymbols = ['SOL', 'BTC', 'ETH', 'AVAX', 'LINK'];
					const pairSymbol = pairSymbols[pairIndex] || 'UNKNOWN';
					const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];

					if (!pairDecimals) continue;

					const entryPriceNum = Number(entryPrice) / 1e6;
					const exitPriceNum = exitPrice > 0 ? Number(exitPrice) / 1e6 : entryPriceNum;
					const amountNum = Number(amountTokenOut) / Math.pow(10, pairDecimals.tokenOut);
					const sizeUSDT = amountNum * entryPriceNum;

					// Calculate P&L
					let pnl = 0;
					if (status === 1 && exitPrice > 0) { // Closed position
						if (positionType === 0) { // Long
							pnl = (exitPriceNum - entryPriceNum) * amountNum;
						} else { // Short
							pnl = (entryPriceNum - exitPriceNum) * amountNum;
						}
					}

					tradeHistory.push({
						pubkey: accountInfo.pubkey.toBase58(),
						positionId: positionId.toString(),
						direction: positionType === 0 ? 'LONG' : 'SHORT',
						tradeType: positionType === 0 ? 'LONG' : 'SHORT',
						pairIndex,
						pairSymbol,
						pair: `${pairSymbol}/USDT`,
						type: status === 1 ? 'CLOSED' : 'OPEN',
						size: amountNum,
						sizeUSDT,
						entryPrice: entryPriceNum,
						exitPrice: status === 1 ? exitPriceNum : null,
						takeProfitPrice: takeProfitPrice > 0 ? Number(takeProfitPrice) / 1e6 : null,
						stopLossPrice: stopLossPrice > 0 ? Number(stopLossPrice) / 1e6 : null,
						status: status === 0 ? 'ACTIVE' : 'CLOSED',
						openedAt: new Date(Number(openedAt) * 1000),
						closedAt: status === 1 ? new Date(Number(closedAt) * 1000) : null,
						timestamp: status === 1 ? new Date(Number(closedAt) * 1000) : new Date(Number(openedAt) * 1000),
						pnl
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

		let positions: any[] = [];

		// Try to fetch MagicBlock positions first
		if (this.entityPda) {
			try {
				const positionAccounts = await this.connection.getProgramAccounts(COMPONENT_IDS.POSITION, {
					filters: [
						{
							memcmp: {
								offset: 8,
								bytes: this.entityPda.toBase58()
							}
						}
					]
				});

				for (const accountInfo of positionAccounts) {
					try {
						const data = accountInfo.account.data;
						positions.push({
							type: 'magicblock',
							pubkey: accountInfo.pubkey.toBase58(),
							data: data.toString('hex').substring(0, 100) + '...'
						});
					} catch (parseError) {
					}
				}

			} catch (error) {
			}
		}

		// Fetch direct contract positions using MagicBlock rollup only
		try {
			const positionAccountSize = 104;

			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [
					{
						dataSize: positionAccountSize
					},
					{
						memcmp: {
							offset: 8,
							bytes: currentWallet.publicKey.toBase58()
						}
					}
				]
			});

			const directPositions = allAccounts;

			for (const accountInfo of directPositions) {
				try {
					// Parse position data from the contract
					const data = accountInfo.account.data;
					const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
					
					// Parse according to PositionAccount struct from main.rs:
					// owner: Pubkey (32), pair_index: u8 (1), position_id: u64 (8)
					// position_type: PositionType (1), amount_token_out: u64 (8)
					// entry_price: u64 (8), take_profit_price: u64 (8), stop_loss_price: u64 (8)
					// status: PositionStatus (1), opened_at: i64 (8), closed_at: i64 (8)
					
					let offset = 8; // Skip discriminator
					
					// owner: Pubkey (32 bytes)
					offset += 32;
					
					// pair_index: u8 (1 byte)
					const pairIndex = data[offset];
					offset += 1;
					
					// position_id: u64 (8 bytes)
					const positionId = dataView.getBigUint64(offset, true);
					offset += 8;
					
					// position_type: PositionType (1 byte) - 0 = Long, 1 = Short  
					const positionType = data[offset];
					offset += 1;
					
					// amount_token_out: u64 (8 bytes)
					const amountTokenOut = dataView.getBigUint64(offset, true);
					offset += 8;
					
					// entry_price: u64 (8 bytes)
					const entryPrice = dataView.getBigUint64(offset, true);
					offset += 8;
					
					// take_profit_price: u64 (8 bytes)
					const takeProfitPrice = dataView.getBigUint64(offset, true);
					offset += 8;
					
					// stop_loss_price: u64 (8 bytes)
					const stopLossPrice = dataView.getBigUint64(offset, true);
					offset += 8;
					
					// status: PositionStatus (1 byte) - 0 = Active, 1 = Closed
					const status = data[offset];
					offset += 1;
					
					// opened_at: i64 (8 bytes)
					const openedAt = dataView.getBigInt64(offset, true);
					offset += 8;
					
					// closed_at: i64 (8 bytes)
					const closedAt = dataView.getBigInt64(offset, true);

					// Get pair symbol and decimals
					const pairSymbols = ['SOL', 'BTC', 'ETH', 'AVAX', 'LINK'];
					const pairSymbol = pairSymbols[pairIndex] || 'UNKNOWN';
					const pairDecimals = PAIR_DECIMALS[pairIndex as keyof typeof PAIR_DECIMALS];

					if (status === 0 && pairDecimals) {
						positions.push({
							type: 'direct',
							pubkey: accountInfo.pubkey.toBase58(),
							positionId: positionId.toString(),
							direction: positionType === 0 ? 'LONG' : 'SHORT',
							pairIndex,
							pairSymbol,
							amountTokenOut: Number(amountTokenOut) / Math.pow(10, pairDecimals.tokenOut),
							entryPrice: Number(entryPrice) / 1e6, // Price always has 6 decimals
							takeProfitPrice: takeProfitPrice > 0 ? Number(takeProfitPrice) / 1e6 : null,
							stopLossPrice: stopLossPrice > 0 ? Number(stopLossPrice) / 1e6 : null,
							openedAt: new Date(Number(openedAt) * 1000),
							status: 'ACTIVE'
						});
					}
				} catch (parseError) {
				}
			}

		} catch (error) {
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

	// Get mock token balances for a specific trading pair
	async getUserAccountData(pairIndex: number): Promise<{ tokenInBalance: number; tokenOutBalance: number; totalPositions: number } | null> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return null;
		}

		try {
			const [userAccountPDA] = this.getUserAccountPDA(currentWallet.publicKey, pairIndex);
			const accountInfo = await this.connection.getAccountInfo(userAccountPDA);
			
			if (!accountInfo) {
				return null;
			}

			// Parse the account data according to the UserAccount struct
			const data = accountInfo.data;
			
			// Skip the 8-byte discriminator
			let offset = 8;
			
			// Skip owner (32 bytes)
			offset += 32;
			
			// Skip pair_index (1 byte)  
			offset += 1;
			
			// Read token_in_balance (8 bytes, u64)
			const tokenInBalanceRaw = data.readBigUInt64LE(offset);
			offset += 8;
			
			// Read token_out_balance (8 bytes, u64)
			const tokenOutBalanceRaw = data.readBigUInt64LE(offset);
			offset += 8;
			
			// Read token_in_decimals (1 byte, u8)
			const tokenInDecimals = data[offset];
			offset += 1;
			
			// Read token_out_decimals (1 byte, u8)
			const tokenOutDecimals = data[offset];
			offset += 1;
			
			// Read total_positions (8 bytes, u64)
			const totalPositions = Number(data.readBigUInt64LE(offset));

			// Convert to readable format using stored decimals
			const tokenInBalance = Number(tokenInBalanceRaw) / Math.pow(10, tokenInDecimals);
			const tokenOutBalance = Number(tokenOutBalanceRaw) / Math.pow(10, tokenOutDecimals);

			return {
				tokenInBalance,
				tokenOutBalance,
				totalPositions
			};
		} catch (error) {
			return null;
		}
	}

	// Get mock token balances for all initialized trading pairs
	async getAllUserAccountData(): Promise<{ [pairIndex: number]: { tokenInBalance: number; tokenOutBalance: number; totalPositions: number } }> {
		const accountData: { [pairIndex: number]: { tokenInBalance: number; tokenOutBalance: number; totalPositions: number } } = {};
		
		// Check all trading pairs
		for (const [, pairIndex] of Object.entries(TRADING_PAIRS)) {
			const data = await this.getUserAccountData(pairIndex);
			if (data) {
				accountData[pairIndex] = data;
			}
		}

		return accountData;
	}

	async joinCompetition(): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet || !this.entityPda || !this.competitionEntity) {
			throw new Error('Wallet not connected or entity not initialized');
		}


		try {
			const { transaction } = await ApplySystem({
				authority: currentWallet.publicKey,
				systemId: SYSTEM_IDS.JOIN_COMPETITION,
				entities: [
					{
						entity: this.competitionEntity,
						components: [{ componentId: COMPONENT_IDS.COMPETITION }],
					},
					{
						entity: this.entityPda,
						components: [{ componentId: COMPONENT_IDS.TRADING_ACCOUNT }],
					},
				],
				world: WORLD_INSTANCE_ID,
			});

			// Get fresh blockhash and set transaction properties
			const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
			transaction.recentBlockhash = latestBlockhash.blockhash;
			transaction.feePayer = currentWallet.publicKey;

			// Sign and send transaction
			let signature: string;
			if (currentWallet.signTransaction) {
				const signedTx = await currentWallet.signTransaction(transaction);
				try {
					signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
						skipPreflight: false,
						preflightCommitment: 'confirmed'
					});
				} catch (error: any) {
					if (error.name === 'SendTransactionError') {
						if (error.message?.includes('This transaction has already been processed')) {
							throw new Error('Transaction already processed. Please wait a moment before trying again.');
						}
					}
					throw error;
				}
				
				// Wait for confirmation
				await this.connection.confirmTransaction({
					signature,
					blockhash: latestBlockhash.blockhash,
					lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
				}, 'confirmed');
			} else if (this.sessionWallet) {
				// Fallback to session wallet signing
				signature = await sendAndConfirmTransaction(
					this.connection,
					transaction,
					[this.sessionWallet],
					{ commitment: 'confirmed' }
				);
			} else {
				throw new Error('No signing method available');
			}

			return signature;
		} catch (error) {
			throw error;
		}
	}

	async fetchLeaderboard(currentPrices?: Record<string, number>): Promise<any[]> {
		try {
			const userAccountSize = 68; // Updated size with decimal fields

			const allAccounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [
					{
						dataSize: userAccountSize
					}
				]
			});

			const userMap = new Map<string, { totalValue: number; totalPositions: number }>();

			for (const accountInfo of allAccounts) {
				try {
					const data = accountInfo.account.data;
					let offset = 8;

					const ownerBytes = data.slice(offset, offset + 32);
					const owner = new PublicKey(ownerBytes).toBase58();
					offset += 32;

					const pairIndex = data[offset];
					offset += 1;

					const tokenInBalanceRaw = data.readBigUInt64LE(offset);
					offset += 8;

					const tokenOutBalanceRaw = data.readBigUInt64LE(offset);
					offset += 8;

					const tokenInDecimals = data[offset];
					offset += 1;

					const tokenOutDecimals = data[offset];
					offset += 1;

					const totalPositions = Number(data.readBigUInt64LE(offset));

					const tokenInBalance = Number(tokenInBalanceRaw) / Math.pow(10, tokenInDecimals);
					const tokenOutBalance = Number(tokenOutBalanceRaw) / Math.pow(10, tokenOutDecimals);

					const pairSymbols = ['SOL', 'BTC', 'ETH', 'AVAX', 'LINK'];
					const pairSymbol = pairSymbols[pairIndex];
					const currentPrice = currentPrices?.[pairSymbol] || 0;

					const pairValue = tokenInBalance + (tokenOutBalance * currentPrice);

					if (!userMap.has(owner)) {
						userMap.set(owner, { totalValue: 0, totalPositions: 0 });
					}

					const userData = userMap.get(owner)!;
					userData.totalValue += pairValue;
					userData.totalPositions += totalPositions;
				} catch (parseError) {
				}
			}

			const leaderboard = [];
			for (const [address, data] of userMap.entries()) {
				const pnl = data.totalValue - 10000;

				leaderboard.push({
					address: address.substring(0, 8),
					pnl,
					trades: data.totalPositions,
					balance: data.totalValue
				});
			}

			leaderboard.sort((a, b) => b.pnl - a.pnl);

			return leaderboard.map((entry, index) => ({
				...entry,
				rank: index + 1
			}));
		} catch (error) {
			return [];
		}
	}

	async fetchCompetitionData(): Promise<{ startTime: Date; endTime: Date; totalParticipants: number; prizePool: number; isActive: boolean; name: string } | null> {
		if (!this.competitionEntity) {
			return null;
		}

		try {

			const [componentPda] = PublicKey.findProgramAddressSync(
				[Buffer.from('component'), this.competitionEntity.toBuffer(), COMPONENT_IDS.COMPETITION.toBuffer()],
				COMPONENT_IDS.COMPETITION
			);

			const accountInfo = await this.connection.getAccountInfo(componentPda);
			if (!accountInfo) {
				return null;
			}

			const data = accountInfo.data;
			let offset = 8;

			const authorityBytes = data.slice(offset, offset + 32);
			offset += 32;

			const startTimeBuffer = data.slice(offset, offset + 8);
			const startTime = new DataView(startTimeBuffer.buffer, startTimeBuffer.byteOffset).getBigInt64(0, true);
			offset += 8;

			const endTimeBuffer = data.slice(offset, offset + 8);
			const endTime = new DataView(endTimeBuffer.buffer, endTimeBuffer.byteOffset).getBigInt64(0, true);
			offset += 8;

			const totalParticipantsBuffer = data.slice(offset, offset + 8);
			const totalParticipants = new DataView(totalParticipantsBuffer.buffer, totalParticipantsBuffer.byteOffset).getBigUint64(0, true);
			offset += 8;

			const prizePoolBuffer = data.slice(offset, offset + 8);
			const prizePool = new DataView(prizePoolBuffer.buffer, prizePoolBuffer.byteOffset).getBigUint64(0, true);
			offset += 8;

			const isActive = data[offset] === 1;
			offset += 1;

			const nameLength = data.readUInt32LE(offset);
			offset += 4;
			const name = data.slice(offset, offset + nameLength).toString('utf-8');

			return {
				startTime: new Date(Number(startTime) * 1000),
				endTime: new Date(Number(endTime) * 1000),
				totalParticipants: Number(totalParticipants),
				prizePool: Number(prizePool),
				isActive,
				name
			};
		} catch (error) {
			return null;
		}
	}

	async settleCompetition(): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet || !this.competitionEntity) {
			throw new Error('Wallet not connected or competition entity not initialized');
		}


		try {
			const { transaction } = await ApplySystem({
				authority: currentWallet.publicKey,
				systemId: SYSTEM_IDS.SETTLE_COMPETITION,
				entities: [
					{
						entity: this.competitionEntity,
						components: [{ componentId: COMPONENT_IDS.COMPETITION }],
					},
				],
				world: WORLD_INSTANCE_ID,
			});

			// Get fresh blockhash and set transaction properties
			const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
			transaction.recentBlockhash = latestBlockhash.blockhash;
			transaction.feePayer = currentWallet.publicKey;

			// Sign and send transaction
			let signature: string;
			if (currentWallet.signTransaction) {
				const signedTx = await currentWallet.signTransaction(transaction);
				try {
					signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
						skipPreflight: false,
						preflightCommitment: 'confirmed'
					});
				} catch (error: any) {
					if (error.name === 'SendTransactionError') {
						if (error.message?.includes('This transaction has already been processed')) {
							throw new Error('Transaction already processed. Please wait a moment before trying again.');
						}
					}
					throw error;
				}
				
				// Wait for confirmation
				await this.connection.confirmTransaction({
					signature,
					blockhash: latestBlockhash.blockhash,
					lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
				}, 'confirmed');
			} else if (this.sessionWallet) {
				// Fallback to session wallet signing
				signature = await sendAndConfirmTransaction(
					this.connection,
					transaction,
					[this.sessionWallet],
					{ commitment: 'confirmed' }
				);
			} else {
				throw new Error('No signing method available');
			}

			return signature;
		} catch (error) {
			throw error;
		}
	}

	async mintTrophyNFT(
		rank: number,
		winnerAddress: PublicKey,
		competitionId: string,
		finalPnl: number,
		totalTrades: number
	): Promise<string> {
		if (!this.wallet) {
			throw new Error('Admin wallet not initialized');
		}


		const mintKeypair = Keypair.generate();

		const [metadataPDA] = PublicKey.findProgramAddressSync(
			[
				Buffer.from('metadata'),
				new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(),
				mintKeypair.publicKey.toBuffer(),
			],
			new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
		);


		const associatedTokenAddress = await this.getAssociatedTokenAddress(
			mintKeypair.publicKey,
			winnerAddress
		);

		try {
			const instruction = await this.createMintTrophyInstruction(
				this.wallet.publicKey,
				winnerAddress,
				mintKeypair.publicKey,
				associatedTokenAddress,
				metadataPDA,
				rank,
				competitionId,
				finalPnl,
				totalTrades
			);

			const transaction = new Transaction().add(instruction);
			transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
			transaction.feePayer = this.wallet.publicKey;

			transaction.sign(this.wallet, mintKeypair);

			const signature = await sendAndConfirmTransaction(
				this.connection,
				transaction,
				[this.wallet, mintKeypair],
				{ commitment: 'confirmed' }
			);

			return signature;
		} catch (error) {
			throw error;
		}
	}

	async getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
		const [address] = PublicKey.findProgramAddressSync(
			[owner.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()],
			new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
		);
		return address;
	}

	async createMintTrophyInstruction(
		authority: PublicKey,
		winner: PublicKey,
		mint: PublicKey,
		tokenAccount: PublicKey,
		metadata: PublicKey,
		rank: number,
		competitionId: string,
		finalPnl: number,
		totalTrades: number
	): Promise<any> {
		const args = {
			rank,
			competitionId,
			finalPnl: Math.floor(finalPnl * 1e8),
			totalTrades,
		};

		const accounts = {
			authority,
			winner,
			mint,
			tokenAccount,
			metadata,
			tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
			associatedTokenProgram: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
			systemProgram: new PublicKey('11111111111111111111111111111111'),
			rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
			tokenMetadataProgram: new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
		};

		return {
			keys: [
				{ pubkey: accounts.authority, isSigner: true, isWritable: true },
				{ pubkey: accounts.winner, isSigner: false, isWritable: true },
				{ pubkey: accounts.mint, isSigner: true, isWritable: true },
				{ pubkey: accounts.tokenAccount, isSigner: false, isWritable: true },
				{ pubkey: accounts.metadata, isSigner: false, isWritable: true },
				{ pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
				{ pubkey: accounts.associatedTokenProgram, isSigner: false, isWritable: false },
				{ pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
				{ pubkey: accounts.rent, isSigner: false, isWritable: false },
				{ pubkey: accounts.tokenMetadataProgram, isSigner: false, isWritable: false },
			],
			programId: SYSTEM_IDS.SETTLE_COMPETITION,
			data: Buffer.from(JSON.stringify(args)),
		};
	}

	// ============= TOURNAMENT METHODS =============

	// Get tournament PDA
	getTournamentPDA(tournamentId: number): [PublicKey, number] {
		const idBuffer = Buffer.allocUnsafe(8);
		idBuffer.writeBigUInt64LE(BigInt(tournamentId));
		return PublicKey.findProgramAddressSync(
			[Buffer.from('tournament'), idBuffer],
			PAPER_TRADING_PROGRAM_ID
		);
	}

	// Get participant PDA
	getParticipantPDA(tournamentPubkey: PublicKey, userPubkey: PublicKey): [PublicKey, number] {
		return PublicKey.findProgramAddressSync(
			[Buffer.from('participant'), tournamentPubkey.toBuffer(), userPubkey.toBuffer()],
			PAPER_TRADING_PROGRAM_ID
		);
	}

	// Get tournament position PDA
	getTournamentPositionPDA(
		tournamentPubkey: PublicKey,
		userPubkey: PublicKey,
		pairIndex: number,
		positionId: number
	): [PublicKey, number] {
		const positionIdBuffer = Buffer.allocUnsafe(8);
		positionIdBuffer.writeBigUInt64LE(BigInt(positionId));
		return PublicKey.findProgramAddressSync(
			[
				Buffer.from('tournament_position'),
				tournamentPubkey.toBuffer(),
				userPubkey.toBuffer(),
				Buffer.from([pairIndex]),
				positionIdBuffer
			],
			PAPER_TRADING_PROGRAM_ID
		);
	}

	// Create a new tournament
	async createTournament(
		tournamentId: number,
		entryFeeSOL: number,
		durationMinutes: number,
		cooldownMinutes: number
	): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const [tournamentPDA] = this.getTournamentPDA(tournamentId);

		// Check if tournament already exists
		const existing = await this.connection.getAccountInfo(tournamentPDA);
		if (existing) {
			throw new Error('Tournament with this ID already exists');
		}

		const entryFeeLamports = Math.floor(entryFeeSOL * LAMPORTS_PER_SOL);
		const durationSeconds = durationMinutes * 60;
		const cooldownSeconds = cooldownMinutes * 60;

		// Create discriminator
		const methodName = 'global:create_tournament';
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		// Create instruction data: discriminator + tournament_id(u64) + entry_fee(u64) + duration_seconds(i64) + cooldown_seconds(i64)
		const instructionData = Buffer.alloc(8 + 8 + 8 + 8 + 8);
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeBigUInt64LE(BigInt(tournamentId), 8);
		instructionData.writeBigUInt64LE(BigInt(entryFeeLamports), 16);
		instructionData.writeBigInt64LE(BigInt(durationSeconds), 24);
		instructionData.writeBigInt64LE(BigInt(cooldownSeconds), 32);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: tournamentPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: true },
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
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

	// Enter a tournament
	async enterTournament(tournamentId: number): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const [tournamentPDA] = this.getTournamentPDA(tournamentId);
		const [participantPDA] = this.getParticipantPDA(tournamentPDA, currentWallet.publicKey);

		// Check if already joined
		const existing = await this.connection.getAccountInfo(participantPDA);
		if (existing) {
			throw new Error('Already joined this tournament');
		}

		// Create discriminator
		const methodName = 'global:enter_tournament';
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		const instructionData = Buffer.from(discriminator);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: tournamentPDA, isSigner: false, isWritable: true },
				{ pubkey: participantPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: true },
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
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

	// Start a tournament (anyone can call after cooldown ends)
	async startTournament(tournamentId: number): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const [tournamentPDA] = this.getTournamentPDA(tournamentId);

		const methodName = 'global:start_tournament';
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		const instructionData = Buffer.from(discriminator);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: tournamentPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false }
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

	async endTournament(tournamentId: number): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const [tournamentPDA] = this.getTournamentPDA(tournamentId);

		const methodName = 'global:end_tournament';
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		const instructionData = Buffer.from(discriminator);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: tournamentPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false }
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

	// Tournament buy - buy token with USDT balance
	async tournamentBuy(
		tournamentId: number,
		pairIndex: number,
		tokenAmount: number,
		currentPrice: number
	): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const [tournamentPDA] = this.getTournamentPDA(tournamentId);
		const [participantPDA] = this.getParticipantPDA(tournamentPDA, currentWallet.publicKey);

		// All tokens use 8 decimals for token_out in tournament
		const amountTokenOut = Math.floor(tokenAmount * 1e8);
		const priceScaled = Math.floor(currentPrice * 1e6);

		const methodName = 'global:tournament_buy';
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		// pair_index(u8) + amount_token_out(u64) + price(u64)
		const instructionData = Buffer.alloc(8 + 1 + 8 + 8);
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeUInt8(pairIndex, 8);
		instructionData.writeBigUInt64LE(BigInt(amountTokenOut), 9);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 17);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: tournamentPDA, isSigner: false, isWritable: false },
				{ pubkey: participantPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false }
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

	// Tournament sell - sell token for USDT
	async tournamentSell(
		tournamentId: number,
		pairIndex: number,
		tokenAmount: number,
		currentPrice: number
	): Promise<string> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			throw new Error('Wallet not connected');
		}

		const [tournamentPDA] = this.getTournamentPDA(tournamentId);
		const [participantPDA] = this.getParticipantPDA(tournamentPDA, currentWallet.publicKey);

		const amountTokenOut = Math.floor(tokenAmount * 1e8);
		const priceScaled = Math.floor(currentPrice * 1e6);

		const methodName = 'global:tournament_sell';
		const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(methodName));
		const discriminator = new Uint8Array(hash).slice(0, 8);

		const instructionData = Buffer.alloc(8 + 1 + 8 + 8);
		Buffer.from(discriminator).copy(instructionData, 0);
		instructionData.writeUInt8(pairIndex, 8);
		instructionData.writeBigUInt64LE(BigInt(amountTokenOut), 9);
		instructionData.writeBigUInt64LE(BigInt(priceScaled), 17);

		const instruction = new TransactionInstruction({
			keys: [
				{ pubkey: tournamentPDA, isSigner: false, isWritable: false },
				{ pubkey: participantPDA, isSigner: false, isWritable: true },
				{ pubkey: currentWallet.publicKey, isSigner: true, isWritable: false }
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

	// Fetch all tournaments
	async fetchTournaments(): Promise<Tournament[]> {
		try {
			console.log('[TOURNAMENTS] Fetching all program accounts...');

			// Fetch all accounts owned by the program (no size filter)
			const accounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID);

			console.log(`[TOURNAMENTS] Found ${accounts.length} total program accounts`);

			const tournaments: Tournament[] = [];

			for (const accountInfo of accounts) {
				try {
					const data = accountInfo.account.data;
					console.log(`[TOURNAMENTS] Checking account ${accountInfo.pubkey.toBase58()}, data length: ${data.length}`);

					// Skip if data is too small to be a tournament
					if (data.length < 90) {
						console.log(`[TOURNAMENTS] Skipping - too small`);
						continue;
					}

					const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

					let offset = 8; // Skip discriminator

					// Check if we can read all required fields
					if (data.length < offset + 8 + 32 + 8 + 8 + 8 + 8 + 1 + 4 + 8) {
						console.log(`[TOURNAMENTS] Skipping - insufficient data for tournament structure`);
						continue;
					}

					const id = Number(dataView.getBigUint64(offset, true));
					offset += 8;

					const creatorBytes = data.slice(offset, offset + 32);
					const creator = new PublicKey(creatorBytes).toBase58();
					offset += 32;

					const entryFee = Number(dataView.getBigUint64(offset, true)) / LAMPORTS_PER_SOL;
					offset += 8;

					const prizePool = Number(dataView.getBigUint64(offset, true)) / LAMPORTS_PER_SOL;
					offset += 8;

					const cooldownEnd = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);
					offset += 8;

					const endTime = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);
					offset += 8;

					const status = data[offset] as TournamentStatus;
					offset += 1;

					const participantCount = dataView.getUint32(offset, true);
					offset += 4;

					const createdAt = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);
					offset += 8;

					// Validate that this looks like a tournament (reasonable values)
					if (status > 3 || participantCount > 100000) {
						console.log(`[TOURNAMENTS] Skipping - invalid status or participant count`);
						continue;
					}

					console.log(`[TOURNAMENTS] ✓ Parsed tournament #${id}:`, {
						pubkey: accountInfo.pubkey.toBase58(),
						id,
						creator,
						entryFee,
						prizePool,
						status,
						participantCount,
						dataLength: data.length
					});

					tournaments.push({
						pubkey: accountInfo.pubkey.toBase58(),
						id,
						creator,
						entryFee,
						prizePool,
						cooldownEnd,
						endTime,
						status,
						participantCount,
						createdAt
					});
				} catch (parseError) {
					console.log('[TOURNAMENTS] Error parsing account:', accountInfo.pubkey.toBase58(), parseError);
				}
			}

			console.log(`[TOURNAMENTS] Successfully parsed ${tournaments.length} tournaments out of ${accounts.length} total accounts`);

			// Sort by created time descending
			tournaments.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

			return tournaments;
		} catch (error) {
			console.error('[TOURNAMENTS] Error fetching tournaments:', error);
			return [];
		}
	}

	// Fetch single tournament data
	async fetchTournamentById(tournamentId: number): Promise<Tournament | null> {
		try {
			const [tournamentPDA] = this.getTournamentPDA(tournamentId);
			console.log(`[TOURNAMENT] Fetching tournament #${tournamentId}, PDA: ${tournamentPDA.toBase58()}`);

			const accountInfo = await this.connection.getAccountInfo(tournamentPDA);

			if (!accountInfo) {
				console.log(`[TOURNAMENT] Account not found for tournament #${tournamentId}`);
				return null;
			}

			console.log(`[TOURNAMENT] Account found, data length: ${accountInfo.data.length}`);

			const data = accountInfo.data;
			const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

			let offset = 8; // Skip discriminator

			const id = Number(dataView.getBigUint64(offset, true));
			offset += 8;

			const creatorBytes = data.slice(offset, offset + 32);
			const creator = new PublicKey(creatorBytes).toBase58();
			offset += 32;

			const entryFee = Number(dataView.getBigUint64(offset, true)) / LAMPORTS_PER_SOL;
			offset += 8;

			const prizePool = Number(dataView.getBigUint64(offset, true)) / LAMPORTS_PER_SOL;
			offset += 8;

			const cooldownEnd = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);
			offset += 8;

			const endTime = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);
			offset += 8;

			const status = data[offset] as TournamentStatus;
			offset += 1;

			const participantCount = dataView.getUint32(offset, true);
			offset += 4;

			const createdAt = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);

			console.log(`[TOURNAMENT] Successfully parsed tournament #${id}:`, {
				id,
				creator,
				entryFee,
				prizePool,
				status,
				participantCount
			});

			return {
				pubkey: tournamentPDA.toBase58(),
				id,
				creator,
				entryFee,
				prizePool,
				cooldownEnd,
				endTime,
				status,
				participantCount,
				createdAt
			};
		} catch (error) {
			console.error('[TOURNAMENT] Error fetching tournament:', error);
			return null;
		}
	}

	// Fetch participant data for current user
	async fetchTournamentParticipant(tournamentId: number): Promise<TournamentParticipant | null> {
		const currentWallet = this.getCurrentWallet();
		if (!currentWallet) {
			return null;
		}

		try {
			const [tournamentPDA] = this.getTournamentPDA(tournamentId);
			const [participantPDA] = this.getParticipantPDA(tournamentPDA, currentWallet.publicKey);

			const accountInfo = await this.connection.getAccountInfo(participantPDA);

			if (!accountInfo) {
				return null;
			}

			const data = accountInfo.data;
			const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

			let offset = 8; // Skip discriminator

			const tournamentBytes = data.slice(offset, offset + 32);
			const tournament = new PublicKey(tournamentBytes).toBase58();
			offset += 32;

			const userBytes = data.slice(offset, offset + 32);
			const user = new PublicKey(userBytes).toBase58();
			offset += 32;

			const usdtBalance = Number(dataView.getBigUint64(offset, true)) / 1e6;
			offset += 8;

			const solBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
			offset += 8;

			const btcBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
			offset += 8;

			const ethBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
			offset += 8;

			const avaxBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
			offset += 8;

			const linkBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
			offset += 8;

			const totalPositions = Number(dataView.getBigUint64(offset, true));
			offset += 8;

			const joinedAt = new Date(Number(dataView.getBigInt64(offset, true)) * 1000);

			return {
				pubkey: participantPDA.toBase58(),
				tournament,
				user,
				usdtBalance,
				solBalance,
				btcBalance,
				ethBalance,
				avaxBalance,
				linkBalance,
				totalPositions,
				joinedAt
			};
		} catch (error) {
			console.error('Error fetching participant:', error);
			return null;
		}
	}

	// Check if user has joined a tournament
	async hasJoinedTournament(tournamentId: number): Promise<boolean> {
		const participant = await this.fetchTournamentParticipant(tournamentId);
		return participant !== null;
	}

	// Fetch tournament leaderboard
	async fetchTournamentLeaderboard(tournamentId: number, currentPrices?: Record<string, number>): Promise<any[]> {
		try {
			const [tournamentPDA] = this.getTournamentPDA(tournamentId);

			console.log(`[LEADERBOARD] Fetching participants for tournament ${tournamentId}, PDA: ${tournamentPDA.toBase58()}`);

			// Fetch accounts that match the tournament PDA at offset 8
			const accounts = await this.connection.getProgramAccounts(PAPER_TRADING_PROGRAM_ID, {
				filters: [
					{
						memcmp: {
							offset: 8, // After discriminator
							bytes: tournamentPDA.toBase58()
						}
					}
				]
			});

			console.log(`[LEADERBOARD] Found ${accounts.length} accounts with matching tournament PDA`);

			const leaderboard = [];

			for (const accountInfo of accounts) {
				try {
					const data = accountInfo.account.data;
					console.log(`[LEADERBOARD] Parsing participant account ${accountInfo.pubkey.toBase58()}, data length: ${data.length}`);

					const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

					let offset = 8 + 32; // Skip discriminator and tournament pubkey

					const userBytes = data.slice(offset, offset + 32);
					const user = new PublicKey(userBytes).toBase58();
					offset += 32;

					const usdtBalance = Number(dataView.getBigUint64(offset, true)) / 1e6;
					offset += 8;

					const solBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
					offset += 8;

					const btcBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
					offset += 8;

					const ethBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
					offset += 8;

					const avaxBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
					offset += 8;

					const linkBalance = Number(dataView.getBigUint64(offset, true)) / 1e8;
					offset += 8;

					const totalPositions = Number(dataView.getBigUint64(offset, true));

					// Calculate total portfolio value
					let totalValue = usdtBalance;
					if (currentPrices) {
						totalValue += solBalance * (currentPrices['SOL'] || 0);
						totalValue += btcBalance * (currentPrices['BTC'] || 0);
						totalValue += ethBalance * (currentPrices['ETH'] || 0);
						totalValue += avaxBalance * (currentPrices['AVAX'] || 0);
						totalValue += linkBalance * (currentPrices['LINK'] || 0);
					}

					const pnl = totalValue - 10000; // Starting balance was 10k

					leaderboard.push({
						address: user.substring(0, 8),
						fullAddress: user,
						balance: totalValue,
						pnl,
						trades: totalPositions,
						usdtBalance,
						solBalance,
						btcBalance,
						ethBalance,
						avaxBalance,
						linkBalance
					});
				} catch (parseError) {
					console.error('Error parsing participant:', parseError);
				}
			}

			// Sort by P&L descending
			leaderboard.sort((a, b) => b.pnl - a.pnl);

			// Add rank
			return leaderboard.map((entry, index) => ({
				...entry,
				rank: index + 1
			}));
		} catch (error) {
			console.error('Error fetching tournament leaderboard:', error);
			return [];
		}
	}
}

export const magicBlockClient = new MagicBlockClient();
