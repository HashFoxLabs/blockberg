import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PROGRAM_ID = new PublicKey("ENpbjfPxXx9fLhLDcqbLsHmo25LRU4fW9RXFfrqbKbmo");
const RPC_URL = "https://rpc.magicblock.app/devnet/";

// Trading pair configuration with correct decimals
const TRADING_PAIRS = [
  {
    index: 0,
    name: "SOL/USDT",
    tokenIn: "USDT",
    tokenOut: "SOL", 
    tokenInDecimals: 6,   // USDT has 6 decimals
    tokenOutDecimals: 9,  // SOL has 9 decimals
    initialBalance: 10_000_000_000, // 10,000 USDT (6 decimals: 10,000 * 10^6)
  },
  {
    index: 1,
    name: "BTC/USDT",
    tokenIn: "USDT",
    tokenOut: "BTC",
    tokenInDecimals: 6,   // USDT has 6 decimals
    tokenOutDecimals: 8,  // BTC has 8 decimals  
    initialBalance: 10_000_000_000, // 10,000 USDT (6 decimals: 10,000 * 10^6)
  },
  {
    index: 2,
    name: "ETH/USDT", 
    tokenIn: "USDT",
    tokenOut: "ETH",
    tokenInDecimals: 6,   // USDT has 6 decimals
    tokenOutDecimals: 18, // ETH has 18 decimals
    initialBalance: 10_000_000_000, // 10,000 USDT (6 decimals: 10,000 * 10^6)
  },
  {
    index: 3,
    name: "AVAX/USDT",
    tokenIn: "USDT", 
    tokenOut: "AVAX",
    tokenInDecimals: 6,   // USDT has 6 decimals
    tokenOutDecimals: 18, // AVAX has 18 decimals
    initialBalance: 10_000_000_000, // 10,000 USDT (6 decimals: 10,000 * 10^6)
  },
  {
    index: 4,
    name: "LINK/USDT",
    tokenIn: "USDT",
    tokenOut: "LINK", 
    tokenInDecimals: 6,   // USDT has 6 decimals
    tokenOutDecimals: 18, // LINK has 18 decimals
    initialBalance: 10_000_000_000, // 10,000 USDT (6 decimals: 10,000 * 10^6)
  },
];

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const walletPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(walletData));

  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Program ID:", PROGRAM_ID.toBase58());

  // Get treasury from config account
  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );

  const configAccount = await connection.getAccountInfo(configPDA);
  if (!configAccount) {
    console.error("Config account not found! Please run init-config.ts first.");
    return;
  }

  // Decode treasury address from config (skip first 8 bytes for discriminator + 32 bytes for authority)
  const treasuryBytes = configAccount.data.slice(40, 72);
  const treasury = new PublicKey(treasuryBytes);
  console.log("Treasury from config:", treasury.toBase58());

  const entryFee = 100_000_000; // 0.1 SOL in lamports

  console.log("\\n=== Initializing Trading Accounts ===\\n");

  for (const pair of TRADING_PAIRS) {
    console.log(`Initializing account for ${pair.name}...`);
    
    // Generate the PDA for this user account and pair
    const [userAccountPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user"),
        wallet.publicKey.toBuffer(),
        Buffer.from([pair.index])
      ],
      PROGRAM_ID
    );

    console.log(`  User Account PDA: ${userAccountPDA.toBase58()}`);

    // Check if account already exists
    const existingAccount = await connection.getAccountInfo(userAccountPDA);
    if (existingAccount) {
      console.log(`  ✅ Account for ${pair.name} already exists, skipping...\\n`);
      continue;
    }

    // Create instruction for initialize_account
    const methodName = "global:initialize_account";
    const hash = await crypto.subtle.digest(
      "SHA-256", 
      new TextEncoder().encode(methodName)
    );
    const discriminator = new Uint8Array(hash).slice(0, 8);

    // Instruction data: discriminator + pair_index + entry_fee + initial_token_in + token_in_decimals + token_out_decimals
    const data = Buffer.alloc(8 + 1 + 8 + 8 + 1 + 1);
    let offset = 0;
    
    // Copy discriminator
    Buffer.from(discriminator).copy(data, offset);
    offset += 8;
    
    // pair_index (u8)
    data.writeUInt8(pair.index, offset);
    offset += 1;
    
    // entry_fee (u64, little endian)
    data.writeBigUInt64LE(BigInt(entryFee), offset);
    offset += 8;
    
    // initial_token_in (u64, little endian)
    data.writeBigUInt64LE(BigInt(pair.initialBalance), offset);
    offset += 8;
    
    // token_in_decimals (u8)
    data.writeUInt8(pair.tokenInDecimals, offset);
    offset += 1;
    
    // token_out_decimals (u8)
    data.writeUInt8(pair.tokenOutDecimals, offset);

    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: userAccountPDA, isSigner: false, isWritable: true },     // user_account
        { pubkey: configPDA, isSigner: false, isWritable: false },        // config
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },   // user (payer)
        { pubkey: treasury, isSigner: false, isWritable: true },          // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      programId: PROGRAM_ID,
      data,
    });

    const transaction = new Transaction().add(instruction);

    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet],
        { commitment: "confirmed" }
      );

      console.log(`  ✅ Successfully initialized ${pair.name}`);
      console.log(`  📝 Transaction: ${signature}`);
      console.log(`  💰 Initial balance: ${pair.initialBalance / Math.pow(10, pair.tokenInDecimals)} ${pair.tokenIn}`);
      console.log(`  🔢 Token decimals: ${pair.tokenIn}=${pair.tokenInDecimals}, ${pair.tokenOut}=${pair.tokenOutDecimals}\\n`);
      
    } catch (error) {
      console.error(`  ❌ Failed to initialize ${pair.name}:`, error);
      console.log(`  ⚠️  Continuing with next pair...\\n`);
    }
  }

  console.log("=== Account Initialization Complete ===");
  console.log("\\n📋 Summary:");
  console.log("- Each account has 10,000 USDT initial balance");
  console.log("- SOL/USDT: USDT=6 decimals, SOL=9 decimals");
  console.log("- BTC/USDT: USDT=6 decimals, BTC=8 decimals");
  console.log("- ETH/USDT: USDT=6 decimals, ETH=18 decimals");
  console.log("- AVAX/USDT: USDT=6 decimals, AVAX=18 decimals");
  console.log("- LINK/USDT: USDT=6 decimals, LINK=18 decimals");
  console.log("\\n⚠️  IMPORTANT: These decimal configurations are crucial for accurate calculations!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });