import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	Transaction,
	SystemProgram,
} from '@solana/web3.js';
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import { sessionIdl } from '@magicblock-labs/bolt-sdk/lib/generated';
import bs58 from 'bs58';
import { MAGICBLOCK_RPC, PAPER_TRADING_PROGRAM_ID } from '../env';

/** MagicBlock session-keys program (same as Polymock / bolt-sdk `gpl_session`). */
export const SESSION_KEYS_PROGRAM_ID = new PublicKey('KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5');

const SEED_PREFIX = 'session_token';
const SESSION_STORAGE_KEY = 'blockberg_paper_session';

interface StoredSession {
	secretKey: number[];
	sessionTokenPDA: string;
	authority: string;
	validUntil: number;
	createdAt: number;
}

function getTargetProgramId(): PublicKey {
	return new PublicKey(PAPER_TRADING_PROGRAM_ID);
}

function deriveSessionTokenPDA(
	targetProgram: PublicKey,
	sessionSigner: PublicKey,
	authority: PublicKey
): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(
		[
			Buffer.from(SEED_PREFIX),
			targetProgram.toBuffer(),
			sessionSigner.toBuffer(),
			authority.toBuffer(),
		],
		SESSION_KEYS_PROGRAM_ID
	);
}

/** Session token PDA for the paper program (same seeds as `gpl_session` `CreateSessionToken`). */
export function derivePaperSessionTokenPda(sessionSigner: PublicKey, authority: PublicKey): PublicKey {
	const [pda] = deriveSessionTokenPDA(getTargetProgramId(), sessionSigner, authority);
	return pda;
}

export class SessionKeyManager {
	private connection: Connection;
	private createSessionInFlight = false;
	private sessionProgram: Program<Idl> | null = null;

	constructor() {
		this.connection = new Connection(MAGICBLOCK_RPC, 'confirmed');
	}

	/** Anchor client for `gpl_session` using this RPC (no global `ANCHOR_WALLET` / bolt `SessionProgram` proxy). */
	private getSessionProgram(): Program<Idl> {
		if (this.sessionProgram) return this.sessionProgram;
		const dummy = Keypair.generate();
		const wallet = {
			publicKey: dummy.publicKey,
			signTransaction: async (t: Transaction) => t,
			signAllTransactions: async (txs: Transaction[]) => txs,
		};
		const provider = new AnchorProvider(this.connection, wallet as never, {
			commitment: 'confirmed',
		});
		this.sessionProgram = new Program(sessionIdl as Idl, provider);
		return this.sessionProgram;
	}

	private sendSignedRawOrRecoverDup(signed: Transaction): Promise<string> {
		const raw = signed.serialize();
		return this.connection
			.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
			.catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes('already been processed')) {
					const sigBytes = signed.signatures[0]?.signature;
					if (!sigBytes || sigBytes.every((b) => b === 0)) {
						throw e;
					}
					return bs58.encode(sigBytes);
				}
				throw e;
			});
	}

	/**
	 * Close the session token PDA (rent → wallet) and move all lamports from the **session signer**
	 * system account back to the wallet. `create_session` top-up goes to the signer pubkey; `revoke_session`
	 * alone does not reclaim that SOL — only the session keypair can transfer it.
	 */
	private async revokeAndSweepOnChain(
		wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
		sessionKp: Keypair,
		sessionTokenPda: PublicKey
	): Promise<void> {
		const authority = wallet.publicKey;
		const tx = new Transaction();

		const tokenInfo = await this.connection.getAccountInfo(sessionTokenPda, 'confirmed');
		if (tokenInfo?.owner.equals(SESSION_KEYS_PROGRAM_ID)) {
			const program = this.getSessionProgram();
			const revokeIx = await program.methods
				.revokeSession()
				.accounts({
					sessionToken: sessionTokenPda,
					authority,
					systemProgram: SystemProgram.programId,
				})
				.instruction();
			tx.add(revokeIx);
		}

		const signerBal = await this.connection.getBalance(sessionKp.publicKey, 'confirmed');
		if (signerBal > 0) {
			tx.add(
				SystemProgram.transfer({
					fromPubkey: sessionKp.publicKey,
					toPubkey: authority,
					lamports: signerBal,
				})
			);
		}

		if (tx.instructions.length === 0) {
			return;
		}

		tx.feePayer = authority;
		const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
		tx.recentBlockhash = blockhash;

		if (signerBal > 0) {
			tx.partialSign(sessionKp);
		}
		const signed = await wallet.signTransaction(tx);
		const sig = await this.sendSignedRawOrRecoverDup(signed);
		await this.connection.confirmTransaction(
			{ signature: sig, blockhash, lastValidBlockHeight },
			'confirmed'
		);
	}

	async createSession(
		wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
		expiryMinutes: number = 60 * 24,
		topUpSol: number = 0.05
	): Promise<{ sessionTokenPDA: PublicKey; sessionKeypair: Keypair }> {
		if (!wallet?.publicKey) {
			throw new Error('Wallet not connected');
		}
		if (this.createSessionInFlight) {
			throw new Error('Session funding is already in progress');
		}
		this.createSessionInFlight = true;

		try {
			const authority = wallet.publicKey;
			// Avoid piling up on-chain session tokens + stranded signer SOL: end prior local session first.
			const prior = this.loadSession();
			if (prior) {
				if (prior.authority !== authority.toBase58()) {
					this.clearSession();
				} else {
					const sk = new Uint8Array(prior.secretKey);
					if (sk.length !== 64) {
						this.clearSession();
					} else {
						try {
							await this.revokeAndSweepOnChain(
								wallet,
								Keypair.fromSecretKey(sk),
								new PublicKey(prior.sessionTokenPDA)
							);
							this.clearSession();
						} catch (e) {
							console.warn('[Session] Prior session revoke/sweep failed:', e);
							throw new Error(
								'Could not close your previous paper session on-chain (needed before funding a new one). Use End session and try again, or retry after a moment.'
							);
						}
					}
				}
			}

			const targetProgram = getTargetProgramId();
			const sessionKeypair = Keypair.generate();

			const [sessionTokenPDA] = deriveSessionTokenPDA(
				targetProgram,
				sessionKeypair.publicKey,
				authority
			);

			const validUntil = Math.floor(Date.now() / 1000) + expiryMinutes * 60;
			const lamports = Math.round(topUpSol * LAMPORTS_PER_SOL);

			const program = this.getSessionProgram();
			const ix = await program.methods
				.createSession(true, new BN(validUntil), new BN(lamports))
				.accounts({
					sessionSigner: sessionKeypair.publicKey,
					authority,
					targetProgram,
					sessionToken: sessionTokenPDA,
					systemProgram: SystemProgram.programId,
				})
				.instruction();

			const tx = new Transaction().add(ix);
			tx.feePayer = authority;
			const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
			tx.recentBlockhash = blockhash;

			tx.partialSign(sessionKeypair);
			const signed = await wallet.signTransaction(tx);
			const sig = await this.sendSignedRawOrRecoverDup(signed);

			await this.connection.confirmTransaction(
				{ signature: sig, blockhash, lastValidBlockHeight },
				'confirmed'
			);

			this.storeSession({
				secretKey: Array.from(sessionKeypair.secretKey),
				sessionTokenPDA: sessionTokenPDA.toBase58(),
				authority: authority.toBase58(),
				validUntil,
				createdAt: Math.floor(Date.now() / 1000),
			});

			return { sessionTokenPDA, sessionKeypair };
		} finally {
			this.createSessionInFlight = false;
		}
	}

	getSessionKeypair(): Keypair | null {
		const session = this.loadSession();
		if (!session) return null;
		if (this.isExpired(session)) {
			this.clearSession();
			return null;
		}
		const sk = new Uint8Array(session.secretKey);
		if (sk.length !== 64) {
			this.clearSession();
			return null;
		}
		return Keypair.fromSecretKey(sk);
	}

	getSessionTokenPDA(): PublicKey | null {
		const session = this.loadSession();
		if (!session) return null;
		if (this.isExpired(session)) {
			this.clearSession();
			return null;
		}
		return new PublicKey(session.sessionTokenPDA);
	}

	isSessionActive(): boolean {
		const session = this.loadSession();
		if (!session) return false;
		if (this.isExpired(session)) {
			this.clearSession();
			return false;
		}
		return true;
	}

	isSessionForWallet(walletPubkey: PublicKey): boolean {
		const session = this.loadSession();
		if (!session) return false;
		const addr = walletPubkey.toBase58?.() ?? walletPubkey.toString();
		return session.authority === addr;
	}

	getSessionTimeRemaining(): number {
		const session = this.loadSession();
		if (!session) return 0;
		return Math.max(0, session.validUntil - Math.floor(Date.now() / 1000));
	}

	async revokeSession(wallet: {
		publicKey: PublicKey;
		signTransaction: (tx: Transaction) => Promise<Transaction>;
	}): Promise<void> {
		const session = this.loadSession();
		if (!session) return;

		if (session.authority !== wallet.publicKey.toBase58()) {
			this.clearSession();
			return;
		}

		const sk = new Uint8Array(session.secretKey);
		if (sk.length !== 64) {
			this.clearSession();
			return;
		}
		const sessionKp = Keypair.fromSecretKey(sk);

		try {
			await this.revokeAndSweepOnChain(wallet, sessionKp, new PublicKey(session.sessionTokenPDA));
			this.clearSession();
		} catch (e) {
			console.error('[Session] End session (revoke + sweep) failed:', e);
			throw e;
		}
	}

	clearSession(): void {
		if (typeof localStorage !== 'undefined') {
			localStorage.removeItem(SESSION_STORAGE_KEY);
		}
	}

	private isExpired(session: StoredSession): boolean {
		return Math.floor(Date.now() / 1000) >= session.validUntil;
	}

	private storeSession(session: StoredSession): void {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
		}
	}

	private loadSession(): StoredSession | null {
		if (typeof localStorage === 'undefined') return null;
		const raw = localStorage.getItem(SESSION_STORAGE_KEY);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as StoredSession;
		} catch {
			return null;
		}
	}
}

export const sessionKeyManager = new SessionKeyManager();
