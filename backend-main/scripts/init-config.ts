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

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const walletPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const wallet = Keypair.fromSecretKey(new Uint8Array(walletData));

  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Program ID:", PROGRAM_ID.toBase58());

  const [configPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );

  console.log("Config PDA:", configPDA.toBase58());

  const existingConfig = await connection.getAccountInfo(configPDA);
  if (existingConfig) {
    console.log("Config account already initialized!");
    return;
  }

  const treasuryKeypair = Keypair.generate();
  console.log("Treasury (generated):", treasuryKeypair.publicKey.toBase58());

  const methodName = "global:initialize_config";
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(methodName)
  );
  const discriminator = new Uint8Array(hash).slice(0, 8);

  const data = Buffer.alloc(8 + 32);
  Buffer.from(discriminator).copy(data, 0);
  treasuryKeypair.publicKey.toBuffer().copy(data, 8);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });

  const transaction = new Transaction().add(instruction);

  console.log("Initializing config account...");

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [wallet],
    { commitment: "confirmed" }
  );

  console.log("Config initialized!");
  console.log("Transaction:", signature);
  console.log("Config PDA:", configPDA.toBase58());
  console.log("Authority:", wallet.publicKey.toBase58());
  console.log("Treasury:", treasuryKeypair.publicKey.toBase58());
  console.log("\nIMPORTANT: Save this treasury public key for your records!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
