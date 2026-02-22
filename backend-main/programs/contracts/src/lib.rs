use anchor_lang::prelude::*;
use bolt_lang::*;

declare_id!("GTyA9zS7YrRJ7LQCqeKAYZa4yL2CSCaH6SmEALEWAXAk");

/// Account for MagicBlock Bolt - the user account usable in Ephemeral Rollups
/// A user can have multiple accounts (one per trading pair)
#[account]
#[derive(Default, InitSpace)]
pub struct UserAccount {
    pub owner: Pubkey,
    pub pair_index: u8,          // Pair identifier (0=SOL/USDT, 1=BTC/USDT, etc.)
    pub token_in_balance: u64,   // Balance of the input token (ex: USDT) - 6 decimals
    pub token_out_balance: u64,  // Balance of the output token (ex: SOL/BTC/ETH) - 9 decimals
    pub token_in_decimals: u8,   // Decimals for token_in (typically 6 for USDT)
    pub token_out_decimals: u8,  // Decimals for token_out (9 for SOL, 8 for BTC, etc.)
    pub total_positions: u64,
    pub created_at: i64,
}

/// Account for positions with TP/SL
#[account]
#[derive(Default, InitSpace)]
pub struct PositionAccount {
    pub owner: Pubkey,
    pub pair_index: u8,          // Pair identifier
    pub position_id: u64,
    pub position_type: PositionType,
    pub amount_token_out: u64,   // Amount of the output token (ex: SOL)
    pub entry_price: u64,        // Entry price (6 decimals)
    pub take_profit_price: u64,  // TP price (6 decimals)
    pub stop_loss_price: u64,    // SL price (6 decimals)
    pub status: PositionStatus,
    pub opened_at: i64,
    pub closed_at: i64,
}

/// Global configuration of the program with the admin whitelist
#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,           // Super admin
    pub treasury: Pubkey,            // Wallet that receives the fees
    pub authorized_executors: Vec<Pubkey>, // Whitelist of authorized backends
    pub bump: u8,
}

// ============= TOURNAMENT ACCOUNTS =============

/// Tournament account - stores tournament metadata
#[account]
#[derive(Default, InitSpace)]
pub struct Tournament {
    pub id: u64,                     // Unique tournament ID
    pub creator: Pubkey,             // Who created the tournament
    pub entry_fee: u64,              // Entry fee in lamports (SOL)
    pub prize_pool: u64,             // Total accumulated prize pool
    pub cooldown_end: i64,           // When registration closes and trading starts
    pub end_time: i64,               // When tournament ends
    pub status: TournamentStatus,    // Current status
    pub participant_count: u32,      // Number of participants
    pub created_at: i64,             // Creation timestamp
    pub bump: u8,                    // PDA bump
}

/// Tournament participant account - one per user per tournament
/// Shared balance across all trading pairs
#[account]
#[derive(Default, InitSpace)]
pub struct TournamentParticipant {
    pub tournament: Pubkey,          // Which tournament
    pub user: Pubkey,                // Participant wallet
    pub usdt_balance: u64,           // Shared USDT balance (starts at 10k = 10_000_000_000 with 6 decimals)
    pub sol_balance: u64,            // SOL token balance (8 decimals)
    pub btc_balance: u64,            // BTC token balance (8 decimals)
    pub eth_balance: u64,            // ETH token balance (8 decimals)
    pub avax_balance: u64,           // AVAX token balance (8 decimals)
    pub link_balance: u64,           // LINK token balance (8 decimals)
    pub total_positions: u64,        // Total positions opened
    pub joined_at: i64,              // When they joined
    pub bump: u8,                    // PDA bump
}

/// Tournament position account - positions within a tournament
#[account]
#[derive(Default, InitSpace)]
pub struct TournamentPosition {
    pub tournament: Pubkey,          // Which tournament
    pub owner: Pubkey,               // Position owner
    pub pair_index: u8,              // Trading pair (0=SOL, 1=BTC, etc.)
    pub position_id: u64,            // Position ID within tournament
    pub position_type: PositionType, // Long or Short
    pub amount_token_out: u64,       // Amount of token
    pub entry_price: u64,            // Entry price (6 decimals)
    pub take_profit_price: u64,      // TP price (6 decimals)
    pub stop_loss_price: u64,        // SL price (6 decimals)
    pub status: PositionStatus,      // Active or Closed
    pub opened_at: i64,
    pub closed_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum TournamentStatus {
    #[default]
    Pending,    // Cooldown period - registration open
    Active,     // Trading active
    Ended,      // Trading ended, awaiting settlement
    Settled,    // Prizes distributed
}

#[program]
pub mod paper_trading {
    use super::*;

    /// Initialize the program configuration (only once at deployment)
    pub fn initialize_config(ctx: Context<InitializeConfig>, treasury: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = treasury;
        config.authorized_executors = Vec::new();
        config.bump = ctx.bumps.config;

        emit!(ConfigInitialized {
            authority: config.authority,
            treasury: config.treasury,
        });

        Ok(())
    }

    /// Add an authorized backend executor to execute the TP/SL
    pub fn add_executor(ctx: Context<UpdateExecutors>, executor: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        
        require!(
            !config.authorized_executors.contains(&executor),
            ErrorCode::ExecutorAlreadyExists
        );

        config.authorized_executors.push(executor);

        emit!(ExecutorAdded { executor });

        Ok(())
    }

    /// Remove an authorized backend executor
    pub fn remove_executor(ctx: Context<UpdateExecutors>, executor: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        
        config.authorized_executors.retain(|&x| x != executor);

        emit!(ExecutorRemoved { executor });

        Ok(())
    }

    /// Initialize a paper trading account for a user on a specific pair
    /// The user pays an entry fee and receives mock tokens
    /// The user can create multiple accounts (one per pair: SOL/USDT, BTC/USDT, etc.)
    pub fn initialize_account(
        ctx: Context<InitializeAccount>,
        pair_index: u8,          // 0=SOL/USDT, 1=BTC/USDT, 2=ETH/USDT, etc.
        entry_fee: u64,
        initial_token_in: u64,   // How many token_in to give to the user (ex: 10,000 USDT)
        token_in_decimals: u8,   // Decimals for token_in (6 for USDT)
        token_out_decimals: u8,  // Decimals for token_out (9 for SOL, 8 for BTC, etc.)
    ) -> Result<()> {
        require!(entry_fee >= 100_000_000, ErrorCode::EntryFeeTooLow); // Min 0.1 SOL

        let user_account = &mut ctx.accounts.user_account;
        let clock = Clock::get()?;

        user_account.owner = ctx.accounts.user.key();
        user_account.pair_index = pair_index;
        user_account.token_in_balance = initial_token_in;
        user_account.token_out_balance = 0;
        user_account.token_in_decimals = token_in_decimals;
        user_account.token_out_decimals = token_out_decimals;
        user_account.total_positions = 0;
        user_account.created_at = clock.unix_timestamp;

        // Transfer the fees to the treasury
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, entry_fee)?;

        emit!(AccountInitialized {
            user: ctx.accounts.user.key(),
            pair_index,
            initial_token_in,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Buy token_out with token_in (without TP/SL)
    /// Example: buy SOL with USDT (pair_index=0)
    /// The price is passed as a parameter (calculated by the backend via Pyth or other oracle)
    pub fn buy(
        ctx: Context<Trade>, 
        amount_token_out: u64,  // How many token_out to buy
        price: u64,             // Current price (6 decimals) - ex: 150.50 USDT = 150_500_000
    ) -> Result<()> {
        let user_account = &mut ctx.accounts.user_account;
        
        // Calculate the cost in token_in with proper decimal handling
        let price_decimals = 6u32; // Price always has 6 decimals
        let decimal_adjustment = (user_account.token_out_decimals as u32)
            .checked_add(price_decimals)
            .unwrap()
            .checked_sub(user_account.token_in_decimals as u32)
            .unwrap();
        
        let cost_token_in = (amount_token_out as u128)
            .checked_mul(price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        require!(
            user_account.token_in_balance >= cost_token_in,
            ErrorCode::InsufficientBalance
        );

        // Update the balances - in an Ephemeral Rollup
        user_account.token_in_balance = user_account
            .token_in_balance
            .checked_sub(cost_token_in)
            .unwrap();
        user_account.token_out_balance = user_account
            .token_out_balance
            .checked_add(amount_token_out)
            .unwrap();

        emit!(TradeExecuted {
            user: user_account.owner,
            pair_index: user_account.pair_index,
            trade_type: TradeType::Buy,
            amount: amount_token_out,
            price,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Sell token_out for token_in (without TP/SL)
    /// Example: sell SOL for USDT
    pub fn sell(
        ctx: Context<Trade>, 
        amount_token_out: u64,  // How many token_out to sell
        price: u64,             // Current price (6 decimals)
    ) -> Result<()> {
        let user_account = &mut ctx.accounts.user_account;

        require!(
            user_account.token_out_balance >= amount_token_out,
            ErrorCode::InsufficientBalance
        );
        
        // Calculate how many token_in we receive with proper decimal handling
        let price_decimals = 6u32; // Price always has 6 decimals
        let decimal_adjustment = (user_account.token_out_decimals as u32)
            .checked_add(price_decimals)
            .unwrap()
            .checked_sub(user_account.token_in_decimals as u32)
            .unwrap();
        
        let received_token_in = (amount_token_out as u128)
            .checked_mul(price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        // Update the balances
        user_account.token_out_balance = user_account
            .token_out_balance
            .checked_sub(amount_token_out)
            .unwrap();
        user_account.token_in_balance = user_account
            .token_in_balance
            .checked_add(received_token_in)
            .unwrap();

        emit!(TradeExecuted {
            user: user_account.owner,
            pair_index: user_account.pair_index,
            trade_type: TradeType::Sell,
            amount: amount_token_out,
            price,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Open a LONG position with TP/SL
    /// Buy token_out and create a position monitored by the backend
    pub fn open_long_position(
        ctx: Context<OpenPosition>,
        amount_token_out: u64,
        entry_price: u64,        // Entry price provided by the backend
        take_profit_price: u64,
        stop_loss_price: u64,
    ) -> Result<()> {
        let user_account = &mut ctx.accounts.user_account;
        let position_account = &mut ctx.accounts.position_account;

        // Check the consistency of the prices for a LONG
        require!(
            take_profit_price > entry_price,
            ErrorCode::InvalidTakeProfitPrice
        );
        require!(
            stop_loss_price < entry_price,
            ErrorCode::InvalidStopLossPrice
        );

        // Calculate the cost with proper decimal handling
        let price_decimals = 6u32; // Price always has 6 decimals
        let decimal_adjustment = (user_account.token_out_decimals as u32)
            .checked_add(price_decimals)
            .unwrap()
            .checked_sub(user_account.token_in_decimals as u32)
            .unwrap();
        
        let cost_token_in = (amount_token_out as u128)
            .checked_mul(entry_price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        require!(
            user_account.token_in_balance >= cost_token_in,
            ErrorCode::InsufficientBalance
        );

        // Deduct the token_in
        user_account.token_in_balance = user_account
            .token_in_balance
            .checked_sub(cost_token_in)
            .unwrap();

        // Create the position
        let clock = Clock::get()?;
        position_account.owner = user_account.owner;
        position_account.pair_index = user_account.pair_index;
        position_account.position_id = user_account.total_positions;
        position_account.position_type = PositionType::Long;
        position_account.amount_token_out = amount_token_out;
        position_account.entry_price = entry_price;
        position_account.take_profit_price = take_profit_price;
        position_account.stop_loss_price = stop_loss_price;
        position_account.status = PositionStatus::Active;
        position_account.opened_at = clock.unix_timestamp;
        position_account.closed_at = 0;

        user_account.total_positions += 1;

        emit!(PositionOpened {
            user: user_account.owner,
            pair_index: user_account.pair_index,
            position_id: position_account.position_id,
            position_type: PositionType::Long,
            amount: amount_token_out,
            entry_price,
            tp_price: take_profit_price,
            sl_price: stop_loss_price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Open a SHORT position with TP/SL
    pub fn open_short_position(
        ctx: Context<OpenPosition>,
        amount_token_out: u64,
        entry_price: u64,
        take_profit_price: u64,
        stop_loss_price: u64,
    ) -> Result<()> {
        let user_account = &mut ctx.accounts.user_account;
        let position_account = &mut ctx.accounts.position_account;

        // Check the consistency of the prices for a SHORT (inverse of the LONG)
        require!(
            take_profit_price < entry_price,
            ErrorCode::InvalidTakeProfitPrice
        );
        require!(
            stop_loss_price > entry_price,
            ErrorCode::InvalidStopLossPrice
        );

        let price_decimals = 6u32; // Price always has 6 decimals
        let decimal_adjustment = (user_account.token_out_decimals as u32)
            .checked_add(price_decimals)
            .unwrap()
            .checked_sub(user_account.token_in_decimals as u32)
            .unwrap();
        
        let cost_token_in = (amount_token_out as u128)
            .checked_mul(entry_price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        require!(
            user_account.token_in_balance >= cost_token_in,
            ErrorCode::InsufficientBalance
        );

        user_account.token_in_balance = user_account
            .token_in_balance
            .checked_sub(cost_token_in)
            .unwrap();

        // Create the short position
        let clock = Clock::get()?;
        position_account.owner = user_account.owner;
        position_account.pair_index = user_account.pair_index;
        position_account.position_id = user_account.total_positions;
        position_account.position_type = PositionType::Short;
        position_account.amount_token_out = amount_token_out;
        position_account.entry_price = entry_price;
        position_account.take_profit_price = take_profit_price;
        position_account.stop_loss_price = stop_loss_price;
        position_account.status = PositionStatus::Active;
        position_account.opened_at = clock.unix_timestamp;
        position_account.closed_at = 0;

        user_account.total_positions += 1;

        emit!(PositionOpened {
            user: user_account.owner,
            pair_index: user_account.pair_index,
            position_id: position_account.position_id,
            position_type: PositionType::Short,
            amount: amount_token_out,
            entry_price,
            tp_price: take_profit_price,
            sl_price: stop_loss_price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Execute a TP/SL automatically
    /// ONLY callable by authorized backends in the whitelist
    pub fn execute_tp_sl(
        ctx: Context<ExecuteTPSL>,
        current_price: u64,  // Current price provided by the backend
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let position_account = &mut ctx.accounts.position_account;
        let user_account = &mut ctx.accounts.user_account;

        // CRITICAL CHECK: The executor must be in the whitelist
        require!(
            config.authorized_executors.contains(&ctx.accounts.executor.key()),
            ErrorCode::UnauthorizedExecutor
        );

        require!(
            position_account.status == PositionStatus::Active,
            ErrorCode::PositionNotActive
        );

        // Check that the pair_index corresponds
        require!(
            position_account.pair_index == user_account.pair_index,
            ErrorCode::PairMismatch
        );

        // Check that the TP or SL condition is met
        let close_reason = match position_account.position_type {
            PositionType::Long => {
                if current_price >= position_account.take_profit_price {
                    CloseReason::TakeProfit
                } else if current_price <= position_account.stop_loss_price {
                    CloseReason::StopLoss
                } else {
                    return Err(ErrorCode::ConditionNotMet.into());
                }
            }
            PositionType::Short => {
                if current_price <= position_account.take_profit_price {
                    CloseReason::TakeProfit
                } else if current_price >= position_account.stop_loss_price {
                    CloseReason::StopLoss
                } else {
                    return Err(ErrorCode::ConditionNotMet.into());
                }
            }
        };

        // Close the position
        close_position_logic(
            position_account,
            user_account,
            current_price,
            close_reason,
        )?;

        Ok(())
    }

    /// Close a manually active position
    pub fn close_position(
        ctx: Context<ClosePositionManual>,
        current_price: u64,  // Current price provided by the backend
    ) -> Result<()> {
        let position_account = &mut ctx.accounts.position_account;
        let user_account = &mut ctx.accounts.user_account;

        require!(
            position_account.status == PositionStatus::Active,
            ErrorCode::PositionNotActive
        );

        require!(
            position_account.owner == ctx.accounts.user.key(),
            ErrorCode::Unauthorized
        );

        // Check that the pair_index corresponds
        require!(
            position_account.pair_index == user_account.pair_index,
            ErrorCode::PairMismatch
        );

        close_position_logic(
            position_account,
            user_account,
            current_price,
            CloseReason::Manual,
        )?;

        Ok(())
    }

    // ============= TOURNAMENT INSTRUCTIONS =============

    /// Create a new tournament
    /// Anyone can create a tournament by specifying entry fee, duration, and cooldown
    pub fn create_tournament(
        ctx: Context<CreateTournament>,
        tournament_id: u64,
        entry_fee: u64,           // Entry fee in lamports (SOL)
        duration_seconds: i64,    // How long the tournament lasts
        cooldown_seconds: i64,    // How long before tournament starts (registration period)
    ) -> Result<()> {
        require!(entry_fee >= 10_000_000, ErrorCode::EntryFeeTooLow); // Min 0.01 SOL
        require!(duration_seconds >= 300, ErrorCode::DurationTooShort); // Min 5 minutes
        require!(cooldown_seconds >= 60, ErrorCode::CooldownTooShort); // Min 1 minute

        let tournament = &mut ctx.accounts.tournament;
        let clock = Clock::get()?;

        tournament.id = tournament_id;
        tournament.creator = ctx.accounts.creator.key();
        tournament.entry_fee = entry_fee;
        tournament.prize_pool = 0;
        tournament.cooldown_end = clock.unix_timestamp + cooldown_seconds;
        tournament.end_time = clock.unix_timestamp + cooldown_seconds + duration_seconds;
        tournament.status = TournamentStatus::Pending;
        tournament.participant_count = 0;
        tournament.created_at = clock.unix_timestamp;
        tournament.bump = ctx.bumps.tournament;

        emit!(TournamentCreated {
            tournament_id,
            creator: ctx.accounts.creator.key(),
            entry_fee,
            cooldown_end: tournament.cooldown_end,
            end_time: tournament.end_time,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Enter a tournament - pay entry fee and get 10k USDT balance
    pub fn enter_tournament(ctx: Context<EnterTournament>) -> Result<()> {
        let clock = Clock::get()?;

        // Check tournament is in registration period
        require!(
            ctx.accounts.tournament.status == TournamentStatus::Pending,
            ErrorCode::TournamentNotOpen
        );
        require!(
            clock.unix_timestamp < ctx.accounts.tournament.cooldown_end,
            ErrorCode::RegistrationClosed
        );

        let entry_fee = ctx.accounts.tournament.entry_fee;

        // Transfer entry fee to tournament account (prize pool)
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.tournament.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, entry_fee)?;

        // Update prize pool
        let tournament = &mut ctx.accounts.tournament;
        let participant = &mut ctx.accounts.participant;
        tournament.prize_pool = tournament
            .prize_pool
            .checked_add(entry_fee)
            .unwrap();
        tournament.participant_count += 1;

        // Initialize participant with 10k USDT (6 decimals)
        participant.tournament = tournament.key();
        participant.user = ctx.accounts.user.key();
        participant.usdt_balance = 10_000_000_000; // 10,000 USDT with 6 decimals
        participant.sol_balance = 0;
        participant.btc_balance = 0;
        participant.eth_balance = 0;
        participant.avax_balance = 0;
        participant.link_balance = 0;
        participant.total_positions = 0;
        participant.joined_at = clock.unix_timestamp;
        participant.bump = ctx.bumps.participant;

        emit!(TournamentJoined {
            tournament_id: tournament.id,
            user: ctx.accounts.user.key(),
            entry_fee: tournament.entry_fee,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Start the tournament (called automatically or by anyone after cooldown ends)
    pub fn start_tournament(ctx: Context<StartTournament>) -> Result<()> {
        let tournament = &mut ctx.accounts.tournament;
        let clock = Clock::get()?;

        require!(
            tournament.status == TournamentStatus::Pending,
            ErrorCode::TournamentNotPending
        );
        require!(
            clock.unix_timestamp >= tournament.cooldown_end,
            ErrorCode::CooldownNotEnded
        );

        tournament.status = TournamentStatus::Active;

        emit!(TournamentStarted {
            tournament_id: tournament.id,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Tournament buy - buy token with shared USDT balance
    pub fn tournament_buy(
        ctx: Context<TournamentTrade>,
        pair_index: u8,
        amount_token_out: u64,
        price: u64,
    ) -> Result<()> {
        let tournament = &ctx.accounts.tournament;
        let participant = &mut ctx.accounts.participant;
        let clock = Clock::get()?;

        // Check tournament is active
        require!(
            tournament.status == TournamentStatus::Active,
            ErrorCode::TournamentNotActive
        );
        require!(
            clock.unix_timestamp < tournament.end_time,
            ErrorCode::TournamentEnded
        );

        // Calculate cost (all tokens use 8 decimals for token_out, 6 for USDT)
        let token_out_decimals = 8u32;
        let price_decimals = 6u32;
        let usdt_decimals = 6u32;
        let decimal_adjustment = token_out_decimals + price_decimals - usdt_decimals;

        let cost_usdt = (amount_token_out as u128)
            .checked_mul(price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        require!(
            participant.usdt_balance >= cost_usdt,
            ErrorCode::InsufficientBalance
        );

        // Deduct USDT
        participant.usdt_balance = participant.usdt_balance.checked_sub(cost_usdt).unwrap();

        // Add token to appropriate balance
        match pair_index {
            0 => participant.sol_balance = participant.sol_balance.checked_add(amount_token_out).unwrap(),
            1 => participant.btc_balance = participant.btc_balance.checked_add(amount_token_out).unwrap(),
            2 => participant.eth_balance = participant.eth_balance.checked_add(amount_token_out).unwrap(),
            3 => participant.avax_balance = participant.avax_balance.checked_add(amount_token_out).unwrap(),
            4 => participant.link_balance = participant.link_balance.checked_add(amount_token_out).unwrap(),
            _ => return Err(ErrorCode::InvalidPairIndex.into()),
        }

        emit!(TournamentTradeExecuted {
            tournament_id: tournament.id,
            user: participant.user,
            pair_index,
            trade_type: TradeType::Buy,
            amount: amount_token_out,
            price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Tournament sell - sell token for USDT
    pub fn tournament_sell(
        ctx: Context<TournamentTrade>,
        pair_index: u8,
        amount_token_out: u64,
        price: u64,
    ) -> Result<()> {
        let tournament = &ctx.accounts.tournament;
        let participant = &mut ctx.accounts.participant;
        let clock = Clock::get()?;

        // Check tournament is active
        require!(
            tournament.status == TournamentStatus::Active,
            ErrorCode::TournamentNotActive
        );
        require!(
            clock.unix_timestamp < tournament.end_time,
            ErrorCode::TournamentEnded
        );

        // Check and deduct token balance
        match pair_index {
            0 => {
                require!(participant.sol_balance >= amount_token_out, ErrorCode::InsufficientBalance);
                participant.sol_balance = participant.sol_balance.checked_sub(amount_token_out).unwrap();
            }
            1 => {
                require!(participant.btc_balance >= amount_token_out, ErrorCode::InsufficientBalance);
                participant.btc_balance = participant.btc_balance.checked_sub(amount_token_out).unwrap();
            }
            2 => {
                require!(participant.eth_balance >= amount_token_out, ErrorCode::InsufficientBalance);
                participant.eth_balance = participant.eth_balance.checked_sub(amount_token_out).unwrap();
            }
            3 => {
                require!(participant.avax_balance >= amount_token_out, ErrorCode::InsufficientBalance);
                participant.avax_balance = participant.avax_balance.checked_sub(amount_token_out).unwrap();
            }
            4 => {
                require!(participant.link_balance >= amount_token_out, ErrorCode::InsufficientBalance);
                participant.link_balance = participant.link_balance.checked_sub(amount_token_out).unwrap();
            }
            _ => return Err(ErrorCode::InvalidPairIndex.into()),
        }

        // Calculate USDT received
        let token_out_decimals = 8u32;
        let price_decimals = 6u32;
        let usdt_decimals = 6u32;
        let decimal_adjustment = token_out_decimals + price_decimals - usdt_decimals;

        let received_usdt = (amount_token_out as u128)
            .checked_mul(price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        participant.usdt_balance = participant.usdt_balance.checked_add(received_usdt).unwrap();

        emit!(TournamentTradeExecuted {
            tournament_id: tournament.id,
            user: participant.user,
            pair_index,
            trade_type: TradeType::Sell,
            amount: amount_token_out,
            price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Tournament open long position
    pub fn tournament_open_long(
        ctx: Context<TournamentOpenPosition>,
        pair_index: u8,
        amount_token_out: u64,
        entry_price: u64,
        take_profit_price: u64,
        stop_loss_price: u64,
    ) -> Result<()> {
        let tournament = &ctx.accounts.tournament;
        let participant = &mut ctx.accounts.participant;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        // Check tournament is active
        require!(
            tournament.status == TournamentStatus::Active,
            ErrorCode::TournamentNotActive
        );
        require!(
            clock.unix_timestamp < tournament.end_time,
            ErrorCode::TournamentEnded
        );

        // Validate TP/SL for long
        require!(take_profit_price > entry_price, ErrorCode::InvalidTakeProfitPrice);
        require!(stop_loss_price < entry_price, ErrorCode::InvalidStopLossPrice);

        // Calculate cost
        let token_out_decimals = 8u32;
        let price_decimals = 6u32;
        let usdt_decimals = 6u32;
        let decimal_adjustment = token_out_decimals + price_decimals - usdt_decimals;

        let cost_usdt = (amount_token_out as u128)
            .checked_mul(entry_price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        require!(
            participant.usdt_balance >= cost_usdt,
            ErrorCode::InsufficientBalance
        );

        // Deduct USDT
        participant.usdt_balance = participant.usdt_balance.checked_sub(cost_usdt).unwrap();

        // Create position
        position.tournament = tournament.key();
        position.owner = participant.user;
        position.pair_index = pair_index;
        position.position_id = participant.total_positions;
        position.position_type = PositionType::Long;
        position.amount_token_out = amount_token_out;
        position.entry_price = entry_price;
        position.take_profit_price = take_profit_price;
        position.stop_loss_price = stop_loss_price;
        position.status = PositionStatus::Active;
        position.opened_at = clock.unix_timestamp;
        position.closed_at = 0;
        position.bump = ctx.bumps.position;

        participant.total_positions += 1;

        emit!(TournamentPositionOpened {
            tournament_id: tournament.id,
            user: participant.user,
            pair_index,
            position_id: position.position_id,
            position_type: PositionType::Long,
            amount: amount_token_out,
            entry_price,
            tp_price: take_profit_price,
            sl_price: stop_loss_price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Tournament open short position
    pub fn tournament_open_short(
        ctx: Context<TournamentOpenPosition>,
        pair_index: u8,
        amount_token_out: u64,
        entry_price: u64,
        take_profit_price: u64,
        stop_loss_price: u64,
    ) -> Result<()> {
        let tournament = &ctx.accounts.tournament;
        let participant = &mut ctx.accounts.participant;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        // Check tournament is active
        require!(
            tournament.status == TournamentStatus::Active,
            ErrorCode::TournamentNotActive
        );
        require!(
            clock.unix_timestamp < tournament.end_time,
            ErrorCode::TournamentEnded
        );

        // Validate TP/SL for short (inverse of long)
        require!(take_profit_price < entry_price, ErrorCode::InvalidTakeProfitPrice);
        require!(stop_loss_price > entry_price, ErrorCode::InvalidStopLossPrice);

        // Calculate cost
        let token_out_decimals = 8u32;
        let price_decimals = 6u32;
        let usdt_decimals = 6u32;
        let decimal_adjustment = token_out_decimals + price_decimals - usdt_decimals;

        let cost_usdt = (amount_token_out as u128)
            .checked_mul(entry_price as u128)
            .unwrap()
            .checked_div(10u128.pow(decimal_adjustment))
            .unwrap() as u64;

        require!(
            participant.usdt_balance >= cost_usdt,
            ErrorCode::InsufficientBalance
        );

        // Deduct USDT
        participant.usdt_balance = participant.usdt_balance.checked_sub(cost_usdt).unwrap();

        // Create position
        position.tournament = tournament.key();
        position.owner = participant.user;
        position.pair_index = pair_index;
        position.position_id = participant.total_positions;
        position.position_type = PositionType::Short;
        position.amount_token_out = amount_token_out;
        position.entry_price = entry_price;
        position.take_profit_price = take_profit_price;
        position.stop_loss_price = stop_loss_price;
        position.status = PositionStatus::Active;
        position.opened_at = clock.unix_timestamp;
        position.closed_at = 0;
        position.bump = ctx.bumps.position;

        participant.total_positions += 1;

        emit!(TournamentPositionOpened {
            tournament_id: tournament.id,
            user: participant.user,
            pair_index,
            position_id: position.position_id,
            position_type: PositionType::Short,
            amount: amount_token_out,
            entry_price,
            tp_price: take_profit_price,
            sl_price: stop_loss_price,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Tournament close position manually
    pub fn tournament_close_position(
        ctx: Context<TournamentClosePosition>,
        current_price: u64,
    ) -> Result<()> {
        let tournament = &ctx.accounts.tournament;
        let participant = &mut ctx.accounts.participant;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        require!(
            position.status == PositionStatus::Active,
            ErrorCode::PositionNotActive
        );
        require!(
            position.owner == ctx.accounts.user.key(),
            ErrorCode::Unauthorized
        );

        // Calculate P&L and close
        tournament_close_position_logic(participant, position, current_price, CloseReason::Manual)?;

        emit!(TournamentPositionClosed {
            tournament_id: tournament.id,
            user: participant.user,
            pair_index: position.pair_index,
            position_id: position.position_id,
            close_price: current_price,
            close_reason: CloseReason::Manual,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// End tournament and mark for settlement
    pub fn end_tournament(ctx: Context<EndTournament>) -> Result<()> {
        let tournament = &mut ctx.accounts.tournament;
        let clock = Clock::get()?;

        require!(
            tournament.status == TournamentStatus::Active,
            ErrorCode::TournamentNotActive
        );
        require!(
            clock.unix_timestamp >= tournament.end_time,
            ErrorCode::TournamentNotEnded
        );

        tournament.status = TournamentStatus::Ended;

        emit!(TournamentEnded {
            tournament_id: tournament.id,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Settle tournament - distribute prizes to top 3
    /// Treasury: 5%, 1st: 50%, 2nd: 30%, 3rd: 15%
    pub fn settle_tournament(
        ctx: Context<SettleTournament>,
        first_place: Pubkey,
        second_place: Pubkey,
        third_place: Pubkey,
    ) -> Result<()> {
        let clock = Clock::get()?;

        require!(
            ctx.accounts.tournament.status == TournamentStatus::Ended,
            ErrorCode::TournamentNotEnded
        );

        let prize_pool = ctx.accounts.tournament.prize_pool;
        let tournament_id = ctx.accounts.tournament.id;
        let treasury_fee = prize_pool.checked_mul(5).unwrap().checked_div(100).unwrap();
        let first_prize = prize_pool.checked_mul(50).unwrap().checked_div(100).unwrap();
        let second_prize = prize_pool.checked_mul(30).unwrap().checked_div(100).unwrap();
        let third_prize = prize_pool.checked_mul(15).unwrap().checked_div(100).unwrap();

        // Transfer treasury fee
        **ctx.accounts.tournament.to_account_info().try_borrow_mut_lamports()? -= treasury_fee;
        **ctx.accounts.treasury.to_account_info().try_borrow_mut_lamports()? += treasury_fee;

        // Transfer prizes
        // First place
        **ctx.accounts.tournament.to_account_info().try_borrow_mut_lamports()? -= first_prize;
        **ctx.accounts.first_place_wallet.to_account_info().try_borrow_mut_lamports()? += first_prize;

        // Second place
        **ctx.accounts.tournament.to_account_info().try_borrow_mut_lamports()? -= second_prize;
        **ctx.accounts.second_place_wallet.to_account_info().try_borrow_mut_lamports()? += second_prize;

        // Third place
        **ctx.accounts.tournament.to_account_info().try_borrow_mut_lamports()? -= third_prize;
        **ctx.accounts.third_place_wallet.to_account_info().try_borrow_mut_lamports()? += third_prize;

        // Now get mutable reference to update status
        let tournament = &mut ctx.accounts.tournament;
        tournament.status = TournamentStatus::Settled;
        tournament.prize_pool = 0;

        emit!(TournamentSettled {
            tournament_id,
            first_place,
            second_place,
            third_place,
            first_prize,
            second_prize,
            third_prize,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// ============= HELPER FUNCTIONS =============

/// Common logic to close a tournament position
fn tournament_close_position_logic(
    participant: &mut TournamentParticipant,
    position: &mut TournamentPosition,
    current_price: u64,
    _close_reason: CloseReason,
) -> Result<()> {
    let clock = Clock::get()?;

    let token_out_decimals = 8u32;
    let price_decimals = 6u32;
    let usdt_decimals = 6u32;
    let decimal_adjustment = token_out_decimals + price_decimals - usdt_decimals;

    match position.position_type {
        PositionType::Long => {
            // Calculate current value
            let current_value = (position.amount_token_out as u128)
                .checked_mul(current_price as u128)
                .unwrap()
                .checked_div(10u128.pow(decimal_adjustment))
                .unwrap() as u64;

            // Return USDT to participant
            participant.usdt_balance = participant.usdt_balance.checked_add(current_value).unwrap();
        }
        PositionType::Short => {
            let entry_value = (position.amount_token_out as u128)
                .checked_mul(position.entry_price as u128)
                .unwrap()
                .checked_div(10u128.pow(decimal_adjustment))
                .unwrap() as u64;

            let current_value = (position.amount_token_out as u128)
                .checked_mul(current_price as u128)
                .unwrap()
                .checked_div(10u128.pow(decimal_adjustment))
                .unwrap() as u64;

            if entry_value > current_value {
                // Profit
                let profit = entry_value - current_value;
                participant.usdt_balance = participant
                    .usdt_balance
                    .checked_add(entry_value)
                    .unwrap()
                    .checked_add(profit)
                    .unwrap();
            } else {
                // Loss
                let loss = current_value - entry_value;
                participant.usdt_balance = participant
                    .usdt_balance
                    .checked_add(entry_value)
                    .unwrap()
                    .checked_sub(loss)
                    .unwrap();
            }
        }
    }

    position.status = PositionStatus::Closed;
    position.closed_at = clock.unix_timestamp;

    Ok(())
}

/// Common logic to close a position
fn close_position_logic(
    position_account: &mut PositionAccount,
    user_account: &mut UserAccount,
    current_price: u64,
    close_reason: CloseReason,
) -> Result<()> {
    let clock = Clock::get()?;

    let price_decimals = 6u32; // Price always has 6 decimals
    let decimal_adjustment = (user_account.token_out_decimals as u32)
        .checked_add(price_decimals)
        .unwrap()
        .checked_sub(user_account.token_in_decimals as u32)
        .unwrap();

    match position_account.position_type {
        PositionType::Long => {
            // Calculate the current value with proper decimal handling
            let current_value = (position_account.amount_token_out as u128)
                .checked_mul(current_price as u128)
                .unwrap()
                .checked_div(10u128.pow(decimal_adjustment))
                .unwrap() as u64;

            // Return the token_in to the user
            user_account.token_in_balance = user_account
                .token_in_balance
                .checked_add(current_value)
                .unwrap();
        }
        PositionType::Short => {
            let entry_value = (position_account.amount_token_out as u128)
                .checked_mul(position_account.entry_price as u128)
                .unwrap()
                .checked_div(10u128.pow(decimal_adjustment))
                .unwrap() as u64;

            let current_value = (position_account.amount_token_out as u128)
                .checked_mul(current_price as u128)
                .unwrap()
                .checked_div(10u128.pow(decimal_adjustment))
                .unwrap() as u64;

            if entry_value > current_value {
                let profit = entry_value - current_value;
                user_account.token_in_balance = user_account
                    .token_in_balance
                    .checked_add(entry_value)
                    .unwrap()
                    .checked_add(profit)
                    .unwrap();
            } else {
                let loss = current_value - entry_value;
                user_account.token_in_balance = user_account
                    .token_in_balance
                    .checked_add(entry_value)
                    .unwrap()
                    .checked_sub(loss)
                    .unwrap();
            };
        }
    }

    position_account.status = PositionStatus::Closed;
    position_account.closed_at = clock.unix_timestamp;

    emit!(PositionClosed {
        user: position_account.owner,
        pair_index: position_account.pair_index,
        position_id: position_account.position_id,
        close_price: current_price,
        close_reason,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

// ============= CONTEXTS =============

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 4 + (32 * 10) + 1, // authority + treasury + vec_len + 10 executors max + bump
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateExecutors<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, ProgramConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(pair_index: u8, entry_fee: u64, initial_token_in: u64, token_in_decimals: u8, token_out_decimals: u8)]
pub struct InitializeAccount<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<UserAccount>(),
        seeds = [
            b"user", 
            user.key().as_ref(),
            &[pair_index]  // Include the pair in the seeds
        ],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Treasury wallet that receives fees - validated against config.treasury
    #[account(mut, constraint = treasury.key() == config.treasury)]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(
        mut,
        seeds = [
            b"user", 
            user.key().as_ref(),
            &[user_account.pair_index]
        ],
        bump,
        constraint = user_account.owner == user.key() @ ErrorCode::Unauthorized
    )]
    pub user_account: Account<'info, UserAccount>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(
        mut,
        seeds = [
            b"user", 
            user.key().as_ref(),
            &[user_account.pair_index]
        ],
        bump,
        constraint = user_account.owner == user.key() @ ErrorCode::Unauthorized
    )]
    pub user_account: Account<'info, UserAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<PositionAccount>(),
        seeds = [
            b"position",
            user.key().as_ref(),
            &[user_account.pair_index],
            user_account.total_positions.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub position_account: Account<'info, PositionAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteTPSL<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [
            b"position",
            position_account.owner.as_ref(),
            &[position_account.pair_index],
            position_account.position_id.to_le_bytes().as_ref()
        ],
        bump,
    )]
    pub position_account: Account<'info, PositionAccount>,

    #[account(
        mut,
        seeds = [
            b"user", 
            position_account.owner.as_ref(),
            &[position_account.pair_index]
        ],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    /// The backend executor (must be in the whitelist)
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClosePositionManual<'info> {
    #[account(
        mut,
        seeds = [
            b"position",
            user.key().as_ref(),
            &[position_account.pair_index],
            position_account.position_id.to_le_bytes().as_ref()
        ],
        bump,
    )]
    pub position_account: Account<'info, PositionAccount>,

    #[account(
        mut,
        seeds = [
            b"user",
            user.key().as_ref(),
            &[user_account.pair_index]
        ],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub user: Signer<'info>,
}

// ============= TOURNAMENT CONTEXTS =============

#[derive(Accounts)]
#[instruction(tournament_id: u64)]
pub struct CreateTournament<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + std::mem::size_of::<Tournament>(),
        seeds = [b"tournament", tournament_id.to_le_bytes().as_ref()],
        bump
    )]
    pub tournament: Account<'info, Tournament>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnterTournament<'info> {
    #[account(
        mut,
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump
    )]
    pub tournament: Account<'info, Tournament>,

    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<TournamentParticipant>(),
        seeds = [b"participant", tournament.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub participant: Account<'info, TournamentParticipant>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartTournament<'info> {
    #[account(
        mut,
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump
    )]
    pub tournament: Account<'info, Tournament>,

    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct TournamentTrade<'info> {
    #[account(
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump
    )]
    pub tournament: Account<'info, Tournament>,

    #[account(
        mut,
        seeds = [b"participant", tournament.key().as_ref(), user.key().as_ref()],
        bump = participant.bump,
        constraint = participant.user == user.key() @ ErrorCode::Unauthorized
    )]
    pub participant: Account<'info, TournamentParticipant>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(pair_index: u8)]
pub struct TournamentOpenPosition<'info> {
    #[account(
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump
    )]
    pub tournament: Account<'info, Tournament>,

    #[account(
        mut,
        seeds = [b"participant", tournament.key().as_ref(), user.key().as_ref()],
        bump = participant.bump,
        constraint = participant.user == user.key() @ ErrorCode::Unauthorized
    )]
    pub participant: Account<'info, TournamentParticipant>,

    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<TournamentPosition>(),
        seeds = [
            b"tournament_position",
            tournament.key().as_ref(),
            user.key().as_ref(),
            &[pair_index],
            participant.total_positions.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub position: Account<'info, TournamentPosition>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TournamentClosePosition<'info> {
    #[account(
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump
    )]
    pub tournament: Account<'info, Tournament>,

    #[account(
        mut,
        seeds = [b"participant", tournament.key().as_ref(), user.key().as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, TournamentParticipant>,

    #[account(
        mut,
        seeds = [
            b"tournament_position",
            tournament.key().as_ref(),
            user.key().as_ref(),
            &[position.pair_index],
            position.position_id.to_le_bytes().as_ref()
        ],
        bump = position.bump
    )]
    pub position: Account<'info, TournamentPosition>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct EndTournament<'info> {
    #[account(
        mut,
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump
    )]
    pub tournament: Account<'info, Tournament>,

    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleTournament<'info> {
    #[account(
        mut,
        seeds = [b"tournament", tournament.id.to_le_bytes().as_ref()],
        bump = tournament.bump,
        constraint = tournament.creator == authority.key() @ ErrorCode::Unauthorized
    )]
    pub tournament: Account<'info, Tournament>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// CHECK: Treasury wallet that receives 5% fee
    #[account(mut, constraint = treasury.key() == config.treasury)]
    pub treasury: AccountInfo<'info>,

    /// CHECK: First place winner wallet
    #[account(mut)]
    pub first_place_wallet: AccountInfo<'info>,

    /// CHECK: Second place winner wallet
    #[account(mut)]
    pub second_place_wallet: AccountInfo<'info>,

    /// CHECK: Third place winner wallet
    #[account(mut)]
    pub third_place_wallet: AccountInfo<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ============= ENUMS =============

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum PositionType {
    #[default]
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum PositionStatus {
    #[default]
    Active,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum TradeType {
    Buy,
    Sell,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum CloseReason {
    TakeProfit,
    StopLoss,
    Manual,
}

// ============= EVENTS =============

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
}

#[event]
pub struct ExecutorAdded {
    pub executor: Pubkey,
}

#[event]
pub struct ExecutorRemoved {
    pub executor: Pubkey,
}

#[event]
pub struct AccountInitialized {
    pub user: Pubkey,
    pub pair_index: u8,
    pub initial_token_in: u64,
    pub timestamp: i64,
}

#[event]
pub struct TradeExecuted {
    pub user: Pubkey,
    pub pair_index: u8,
    pub trade_type: TradeType,
    pub amount: u64,
    pub price: u64,
    pub timestamp: i64,
}

#[event]
pub struct PositionOpened {
    pub user: Pubkey,
    pub pair_index: u8,
    pub position_id: u64,
    pub position_type: PositionType,
    pub amount: u64,
    pub entry_price: u64,
    pub tp_price: u64,
    pub sl_price: u64,
    pub timestamp: i64,
}

#[event]
pub struct PositionClosed {
    pub user: Pubkey,
    pub pair_index: u8,
    pub position_id: u64,
    pub close_price: u64,
    pub close_reason: CloseReason,
    pub timestamp: i64,
}

// ============= TOURNAMENT EVENTS =============

#[event]
pub struct TournamentCreated {
    pub tournament_id: u64,
    pub creator: Pubkey,
    pub entry_fee: u64,
    pub cooldown_end: i64,
    pub end_time: i64,
    pub timestamp: i64,
}

#[event]
pub struct TournamentJoined {
    pub tournament_id: u64,
    pub user: Pubkey,
    pub entry_fee: u64,
    pub timestamp: i64,
}

#[event]
pub struct TournamentStarted {
    pub tournament_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct TournamentTradeExecuted {
    pub tournament_id: u64,
    pub user: Pubkey,
    pub pair_index: u8,
    pub trade_type: TradeType,
    pub amount: u64,
    pub price: u64,
    pub timestamp: i64,
}

#[event]
pub struct TournamentPositionOpened {
    pub tournament_id: u64,
    pub user: Pubkey,
    pub pair_index: u8,
    pub position_id: u64,
    pub position_type: PositionType,
    pub amount: u64,
    pub entry_price: u64,
    pub tp_price: u64,
    pub sl_price: u64,
    pub timestamp: i64,
}

#[event]
pub struct TournamentPositionClosed {
    pub tournament_id: u64,
    pub user: Pubkey,
    pub pair_index: u8,
    pub position_id: u64,
    pub close_price: u64,
    pub close_reason: CloseReason,
    pub timestamp: i64,
}

#[event]
pub struct TournamentEnded {
    pub tournament_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct TournamentSettled {
    pub tournament_id: u64,
    pub first_place: Pubkey,
    pub second_place: Pubkey,
    pub third_place: Pubkey,
    pub first_prize: u64,
    pub second_prize: u64,
    pub third_prize: u64,
    pub timestamp: i64,
}

// ============= ERRORS =============

#[error_code]
pub enum ErrorCode {
    #[msg("Entry fee is too low")]
    EntryFeeTooLow,

    #[msg("Insufficient mock balance")]
    InsufficientBalance,

    #[msg("Invalid take profit price")]
    InvalidTakeProfitPrice,

    #[msg("Invalid stop loss price")]
    InvalidStopLossPrice,

    #[msg("Position is not active")]
    PositionNotActive,

    #[msg("TP/SL condition not met")]
    ConditionNotMet,

    #[msg("Unauthorized access")]
    Unauthorized,

    #[msg("Executor is not authorized to execute TP/SL")]
    UnauthorizedExecutor,

    #[msg("Executor already exists in the whitelist")]
    ExecutorAlreadyExists,

    #[msg("Pair index mismatch between position and user account")]
    PairMismatch,

    // Tournament errors
    #[msg("Tournament duration is too short (minimum 5 minutes)")]
    DurationTooShort,

    #[msg("Cooldown period is too short (minimum 1 minute)")]
    CooldownTooShort,

    #[msg("Tournament is not open for registration")]
    TournamentNotOpen,

    #[msg("Tournament registration period has ended")]
    RegistrationClosed,

    #[msg("Tournament is not in pending status")]
    TournamentNotPending,

    #[msg("Cooldown period has not ended yet")]
    CooldownNotEnded,

    #[msg("Tournament is not active")]
    TournamentNotActive,

    #[msg("Tournament has already ended")]
    TournamentEnded,

    #[msg("Tournament has not ended yet")]
    TournamentNotEnded,

    #[msg("Invalid trading pair index")]
    InvalidPairIndex,
}