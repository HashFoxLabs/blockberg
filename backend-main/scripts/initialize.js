const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROGRAM_ID = new PublicKey('GTyA9zS7YrRJ7LQCqeKAYZa4yL2CSCaH6SmEALEWAXAk');
const RPC_URL = 'https://rpc.magicblock.app/devnet/';

async function main() {
    // Load wallet
    const walletPath = process.env.HOME + '/.config/solana/phantom.json';
    const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(Uint8Array.from(walletData));

    console.log('Wallet:', wallet.publicKey.toBase58());

    const connection = new Connection(RPC_URL, 'confirmed');

    // Derive config PDA
    const [configPda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        PROGRAM_ID
    );
    console.log('Config PDA:', configPda.toBase58());

    // Check if already initialized
    const existingConfig = await connection.getAccountInfo(configPda);
    if (existingConfig) {
        console.log('Config already initialized!');
        console.log('Data length:', existingConfig.data.length);
        return;
    }

    // Treasury is the same wallet for now
    const treasury = wallet.publicKey;
    console.log('Treasury:', treasury.toBase58());

    // Create discriminator for initialize_config
    const methodName = 'global:initialize_config';
    const hash = crypto.createHash('sha256').update(methodName).digest();
    const discriminator = hash.slice(0, 8);

    // Create instruction data: discriminator + treasury pubkey (32 bytes)
    const instructionData = Buffer.alloc(8 + 32);
    discriminator.copy(instructionData, 0);
    treasury.toBuffer().copy(instructionData, 8);

    const instruction = new TransactionInstruction({
        keys: [
            { pubkey: configPda, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        programId: PROGRAM_ID,
        data: instructionData
    });

    const transaction = new Transaction().add(instruction);

    console.log('Sending initialize_config transaction...');

    const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet],
        { commitment: 'confirmed' }
    );

    console.log('Config initialized!');
    console.log('Signature:', signature);

    // Verify
    const configAccount = await connection.getAccountInfo(configPda);
    if (configAccount) {
        console.log('Verified: Config account exists with', configAccount.data.length, 'bytes');
    }
}

main().catch(console.error);
