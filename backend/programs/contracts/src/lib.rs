use anchor_lang::prelude::*;
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

declare_id!("GTyA9zS7YrRJ7LQCqeKAYZa4yL2CSCaH6SmEALEWAXAk");

// ============= CONSTANTS =============

/// Starting paper balance: 100,000 USDT (6 decimals)
pub const INITIAL_BALANCE: u64 = 100_000_000_000;

/// Maintenance margin rate: 50 basis points = 0.5%
pub const MAINTENANCE_MARGIN_BPS: u128 = 50;

// ============= ACCOUNT STRUCTS =============

/// Global program configuration
#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub authorized_executors: Vec<Pubkey>,
    pub bump: u8,
}

/// One unified account per user — single USDT balance covering all pairs
#[account]
#[derive(Default, InitSpace)]
pub struct UserAccount {
    pub owner: Pubkey,
    /// Total USDT balance including locked margin (6 decimals)
    pub usdt_balance: u64,
    /// Margin currently locked in active/pending positions (6 decimals)
    pub locked_margin_usd: u64,
    /// Monotonically increasing counter — used as PDA seed for positions
    pub total_positions: u64,
    pub created_at: i64,
    pub bump: u8,
}

/// A single position — unified for spot and perp, market and limit
#[account]
#[derive(Default, InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub position_id: u64,
    /// 0=SOL, 1=BTC, 2=ETH, 3=AVAX, 4=LINK
    pub pair_index: u8,

    pub trade_mode: TradeMode,
    pub direction: Direction,
    pub order_type: OrderType,

    /// Notional value = margin_usd * leverage (6 decimals)
    pub size_usd: u64,
    /// Margin locked from balance (6 decimals)
    pub margin_usd: u64,
    /// 1 for spot; 2–50 for perp
    pub leverage: u8,

    /// All prices use 6 decimals (e.g. 150_500_000 = $150.50)
    pub entry_price: u64,
    /// Target fill price for limit orders (0 for market orders)
    pub limit_price: u64,
    /// 0 = not set
    pub take_profit_price: u64,
    /// 0 = not set
    pub stop_loss_price: u64,
    /// 0 for spot positions
    pub liquidation_price: u64,

    pub status: PositionStatus,
    pub opened_at: i64,
    /// 0 until filled (relevant for limit orders)
    pub filled_at: i64,
    /// 0 until closed
    pub closed_at: i64,

    pub close_price: u64,
    /// Signed realized PnL in USDT (6 decimals) — set on close
    pub realized_pnl: i64,
    pub close_reason: CloseReason,

    pub bump: u8,
}

// ============= ENUMS =============

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum TradeMode {
    #[default]
    Spot,
    Perp,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum Direction {
    #[default]
    Long,
    Short,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum OrderType {
    #[default]
    Market,
    Limit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum PositionStatus {
    /// Limit order waiting to be filled by executor bot
    #[default]
    PendingFill,
    /// Position is open and being monitored
    Active,
    /// Closed normally (manual, TP, or SL)
    Closed,
    /// Perp position liquidated
    Liquidated,
    /// Limit order cancelled before fill
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, InitSpace)]
pub enum CloseReason {
    #[default]
    None,
    Manual,
    TakeProfit,
    StopLoss,
    Liquidation,
}

// ============= PROGRAM =============

#[program]
pub mod paper_trading {
    use super::*;

    // ─── Admin ────────────────────────────────────────────────────────────────

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

    pub fn remove_executor(ctx: Context<UpdateExecutors>, executor: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authorized_executors.retain(|&x| x != executor);
        emit!(ExecutorRemoved { executor });
        Ok(())
    }

    // ─── User account ─────────────────────────────────────────────────────────

    /// Create the user's unified paper-trading account.
    /// Pays a small real SOL entry fee to the treasury, receives 100k virtual USDT.
    /// NOTE: intentionally NOT session-protected — paying real SOL requires the real wallet.
    pub fn initialize_user_account(
        ctx: Context<InitializeUserAccount>,
        entry_fee: u64,
    ) -> Result<()> {
        require!(entry_fee >= 100_000_000, ErrorCode::EntryFeeTooLow); // min 0.1 SOL

        let clock = Clock::get()?;
        let ua = &mut ctx.accounts.user_account;
        ua.owner = ctx.accounts.user.key();
        ua.usdt_balance = INITIAL_BALANCE;
        ua.locked_margin_usd = 0;
        ua.total_positions = 0;
        ua.created_at = clock.unix_timestamp;
        ua.bump = ctx.bumps.user_account;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, entry_fee)?;

        emit!(AccountInitialized {
            user: ua.owner,
            initial_balance: INITIAL_BALANCE,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }

    // ─── User trading instructions (session-key protected) ────────────────────

    /// Open a market position (fills immediately at `entry_price`).
    /// Session key: user approves once per session, trades execute without popups.
    #[session_auth_or(
        ctx.accounts.user_account.owner == ctx.accounts.user.key(),
        SessionError::InvalidToken
    )]
    pub fn open_market_position(
        ctx: Context<OpenPositionCtx>,
        pair_index: u8,
        trade_mode: TradeMode,
        direction: Direction,
        margin_usd: u64,
        leverage: u8,
        take_profit_price: u64,
        stop_loss_price: u64,
        entry_price: u64,
    ) -> Result<()> {
        validate_pair_index(pair_index)?;
        validate_leverage(&trade_mode, leverage)?;
        require!(margin_usd > 0, ErrorCode::InvalidMargin);
        require!(entry_price > 0, ErrorCode::InvalidPrice);

        let ua = &mut ctx.accounts.user_account;
        let available = ua
            .usdt_balance
            .checked_sub(ua.locked_margin_usd)
            .ok_or(ErrorCode::InsufficientBalance)?;
        require!(available >= margin_usd, ErrorCode::InsufficientBalance);

        let size_usd = (margin_usd as u128)
            .checked_mul(leverage as u128)
            .unwrap() as u64;

        if take_profit_price > 0 || stop_loss_price > 0 {
            validate_tp_sl(&direction, entry_price, take_profit_price, stop_loss_price)?;
        }

        let liquidation_price = if trade_mode == TradeMode::Perp {
            compute_liquidation_price(entry_price, leverage, &direction)
        } else {
            0
        };

        ua.locked_margin_usd = ua.locked_margin_usd.checked_add(margin_usd).unwrap();

        let clock = Clock::get()?;
        let position_id = ua.total_positions;
        let pos = &mut ctx.accounts.position;

        pos.owner = ua.owner;
        pos.position_id = position_id;
        pos.pair_index = pair_index;
        pos.trade_mode = trade_mode.clone();
        pos.direction = direction.clone();
        pos.order_type = OrderType::Market;
        pos.size_usd = size_usd;
        pos.margin_usd = margin_usd;
        pos.leverage = leverage;
        pos.entry_price = entry_price;
        pos.limit_price = 0;
        pos.take_profit_price = take_profit_price;
        pos.stop_loss_price = stop_loss_price;
        pos.liquidation_price = liquidation_price;
        pos.status = PositionStatus::Active;
        pos.opened_at = clock.unix_timestamp;
        pos.filled_at = clock.unix_timestamp;
        pos.closed_at = 0;
        pos.close_price = 0;
        pos.realized_pnl = 0;
        pos.close_reason = CloseReason::None;
        pos.bump = ctx.bumps.position;

        ua.total_positions = ua.total_positions.checked_add(1).unwrap();

        emit!(PositionOpened {
            user: ua.owner,
            position_id,
            pair_index,
            trade_mode,
            direction,
            order_type: OrderType::Market,
            size_usd,
            margin_usd,
            leverage,
            entry_price,
            limit_price: 0,
            take_profit_price,
            stop_loss_price,
            liquidation_price,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Place a limit order. Margin is locked immediately.
    #[session_auth_or(
        ctx.accounts.user_account.owner == ctx.accounts.user.key(),
        SessionError::InvalidToken
    )]
    pub fn open_limit_order(
        ctx: Context<OpenPositionCtx>,
        pair_index: u8,
        trade_mode: TradeMode,
        direction: Direction,
        margin_usd: u64,
        leverage: u8,
        limit_price: u64,
        take_profit_price: u64,
        stop_loss_price: u64,
    ) -> Result<()> {
        validate_pair_index(pair_index)?;
        validate_leverage(&trade_mode, leverage)?;
        require!(margin_usd > 0, ErrorCode::InvalidMargin);
        require!(limit_price > 0, ErrorCode::InvalidLimitPrice);

        let ua = &mut ctx.accounts.user_account;
        let available = ua
            .usdt_balance
            .checked_sub(ua.locked_margin_usd)
            .ok_or(ErrorCode::InsufficientBalance)?;
        require!(available >= margin_usd, ErrorCode::InsufficientBalance);

        if take_profit_price > 0 || stop_loss_price > 0 {
            validate_tp_sl(&direction, limit_price, take_profit_price, stop_loss_price)?;
        }

        let size_usd = (margin_usd as u128)
            .checked_mul(leverage as u128)
            .unwrap() as u64;

        ua.locked_margin_usd = ua.locked_margin_usd.checked_add(margin_usd).unwrap();

        let clock = Clock::get()?;
        let position_id = ua.total_positions;
        let pos = &mut ctx.accounts.position;

        pos.owner = ua.owner;
        pos.position_id = position_id;
        pos.pair_index = pair_index;
        pos.trade_mode = trade_mode.clone();
        pos.direction = direction.clone();
        pos.order_type = OrderType::Limit;
        pos.size_usd = size_usd;
        pos.margin_usd = margin_usd;
        pos.leverage = leverage;
        pos.entry_price = 0;
        pos.limit_price = limit_price;
        pos.take_profit_price = take_profit_price;
        pos.stop_loss_price = stop_loss_price;
        pos.liquidation_price = 0;
        pos.status = PositionStatus::PendingFill;
        pos.opened_at = clock.unix_timestamp;
        pos.filled_at = 0;
        pos.closed_at = 0;
        pos.close_price = 0;
        pos.realized_pnl = 0;
        pos.close_reason = CloseReason::None;
        pos.bump = ctx.bumps.position;

        ua.total_positions = ua.total_positions.checked_add(1).unwrap();

        emit!(PositionOpened {
            user: ua.owner,
            position_id,
            pair_index,
            trade_mode,
            direction,
            order_type: OrderType::Limit,
            size_usd,
            margin_usd,
            leverage,
            entry_price: 0,
            limit_price,
            take_profit_price,
            stop_loss_price,
            liquidation_price: 0,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Cancel a pending limit order. Returns locked margin to available balance.
    #[session_auth_or(
        ctx.accounts.user_account.owner == ctx.accounts.user.key(),
        SessionError::InvalidToken
    )]
    pub fn cancel_limit_order(ctx: Context<UserPositionAction>) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        let ua = &mut ctx.accounts.user_account;

        require!(
            pos.status == PositionStatus::PendingFill,
            ErrorCode::PositionNotPending
        );

        ua.locked_margin_usd = ua
            .locked_margin_usd
            .checked_sub(pos.margin_usd)
            .unwrap_or(0);

        let clock = Clock::get()?;
        pos.status = PositionStatus::Cancelled;
        pos.closed_at = clock.unix_timestamp;

        emit!(PositionCancelled {
            user: pos.owner,
            position_id: pos.position_id,
            pair_index: pos.pair_index,
            margin_returned: pos.margin_usd,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Manually close an active position at the current market price.
    #[session_auth_or(
        ctx.accounts.user_account.owner == ctx.accounts.user.key(),
        SessionError::InvalidToken
    )]
    pub fn close_position(
        ctx: Context<UserPositionAction>,
        current_price: u64,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        let ua = &mut ctx.accounts.user_account;

        require!(pos.status == PositionStatus::Active, ErrorCode::PositionNotActive);
        require!(current_price > 0, ErrorCode::InvalidPrice);

        settle_position(pos, ua, current_price, CloseReason::Manual)?;
        Ok(())
    }

    // ─── Executor bot instructions ────────────────────────────────────────────

    pub fn fill_limit_order(ctx: Context<ExecutorAction>, current_price: u64) -> Result<()> {
        require!(
            ctx.accounts.config.authorized_executors
                .contains(&ctx.accounts.executor.key()),
            ErrorCode::UnauthorizedExecutor
        );

        let pos = &mut ctx.accounts.position;
        require!(pos.status == PositionStatus::PendingFill, ErrorCode::PositionNotPending);
        require!(current_price > 0, ErrorCode::InvalidPrice);

        let fill_condition_met = match pos.direction {
            Direction::Long  => current_price <= pos.limit_price,
            Direction::Short => current_price >= pos.limit_price,
        };
        require!(fill_condition_met, ErrorCode::FillConditionNotMet);

        let clock = Clock::get()?;
        pos.entry_price = current_price;
        pos.filled_at = clock.unix_timestamp;
        pos.status = PositionStatus::Active;

        if pos.trade_mode == TradeMode::Perp {
            pos.liquidation_price =
                compute_liquidation_price(current_price, pos.leverage, &pos.direction);
        }

        emit!(LimitOrderFilled {
            user: pos.owner,
            position_id: pos.position_id,
            pair_index: pos.pair_index,
            fill_price: current_price,
            liquidation_price: pos.liquidation_price,
            timestamp: clock.unix_timestamp,
        });
        Ok(())
    }

    pub fn execute_tp_sl(ctx: Context<ExecutorAction>, current_price: u64) -> Result<()> {
        require!(
            ctx.accounts.config.authorized_executors
                .contains(&ctx.accounts.executor.key()),
            ErrorCode::UnauthorizedExecutor
        );

        let pos = &mut ctx.accounts.position;
        let ua = &mut ctx.accounts.user_account;

        require!(pos.status == PositionStatus::Active, ErrorCode::PositionNotActive);
        require!(current_price > 0, ErrorCode::InvalidPrice);

        let close_reason = match pos.direction {
            Direction::Long => {
                if pos.take_profit_price > 0 && current_price >= pos.take_profit_price {
                    CloseReason::TakeProfit
                } else if pos.stop_loss_price > 0 && current_price <= pos.stop_loss_price {
                    CloseReason::StopLoss
                } else {
                    return Err(ErrorCode::ConditionNotMet.into());
                }
            }
            Direction::Short => {
                if pos.take_profit_price > 0 && current_price <= pos.take_profit_price {
                    CloseReason::TakeProfit
                } else if pos.stop_loss_price > 0 && current_price >= pos.stop_loss_price {
                    CloseReason::StopLoss
                } else {
                    return Err(ErrorCode::ConditionNotMet.into());
                }
            }
        };

        settle_position(pos, ua, current_price, close_reason)?;
        Ok(())
    }

    pub fn liquidate_position(ctx: Context<ExecutorAction>, current_price: u64) -> Result<()> {
        require!(
            ctx.accounts.config.authorized_executors
                .contains(&ctx.accounts.executor.key()),
            ErrorCode::UnauthorizedExecutor
        );

        let pos = &mut ctx.accounts.position;
        let ua = &mut ctx.accounts.user_account;

        require!(pos.status == PositionStatus::Active, ErrorCode::PositionNotActive);
        require!(pos.trade_mode == TradeMode::Perp, ErrorCode::NotAPerpPosition);
        require!(current_price > 0, ErrorCode::InvalidPrice);

        let liq_condition_met = match pos.direction {
            Direction::Long  => current_price <= pos.liquidation_price,
            Direction::Short => current_price >= pos.liquidation_price,
        };
        require!(liq_condition_met, ErrorCode::LiquidationConditionNotMet);

        settle_position(pos, ua, current_price, CloseReason::Liquidation)?;
        Ok(())
    }
}

// ============= HELPER FUNCTIONS =============

fn validate_pair_index(pair_index: u8) -> Result<()> {
    require!(pair_index <= 4, ErrorCode::InvalidPairIndex);
    Ok(())
}

fn validate_leverage(trade_mode: &TradeMode, leverage: u8) -> Result<()> {
    match trade_mode {
        TradeMode::Spot => {
            require!(leverage == 1, ErrorCode::InvalidLeverage);
        }
        TradeMode::Perp => {
            let valid = matches!(leverage, 2 | 3 | 5 | 10 | 15 | 20 | 25 | 50);
            require!(valid, ErrorCode::InvalidLeverage);
        }
    }
    Ok(())
}

fn validate_tp_sl(
    direction: &Direction,
    ref_price: u64,
    take_profit_price: u64,
    stop_loss_price: u64,
) -> Result<()> {
    match direction {
        Direction::Long => {
            if take_profit_price > 0 {
                require!(take_profit_price > ref_price, ErrorCode::InvalidTakeProfitPrice);
            }
            if stop_loss_price > 0 {
                require!(stop_loss_price < ref_price, ErrorCode::InvalidStopLossPrice);
            }
        }
        Direction::Short => {
            if take_profit_price > 0 {
                require!(take_profit_price < ref_price, ErrorCode::InvalidTakeProfitPrice);
            }
            if stop_loss_price > 0 {
                require!(stop_loss_price > ref_price, ErrorCode::InvalidStopLossPrice);
            }
        }
    }
    Ok(())
}

fn compute_liquidation_price(entry_price: u64, leverage: u8, direction: &Direction) -> u64 {
    let lev   = leverage as u128;
    let entry = entry_price as u128;
    let denom = lev * 10_000;

    match direction {
        Direction::Long => {
            let numerator = lev * 10_000 - 10_000 + MAINTENANCE_MARGIN_BPS;
            (entry * numerator / denom) as u64
        }
        Direction::Short => {
            let numerator = lev * 10_000 + 10_000 - MAINTENANCE_MARGIN_BPS;
            (entry * numerator / denom) as u64
        }
    }
}

fn compute_pnl(
    direction: &Direction,
    size_usd: u64,
    entry_price: u64,
    close_price: u64,
) -> i64 {
    let size  = size_usd as u128;
    let entry = entry_price as u128;
    let close = close_price as u128;

    match direction {
        Direction::Long => {
            if close >= entry {
                let profit = size * (close - entry) / entry;
                profit.min(i64::MAX as u128) as i64
            } else {
                let loss = size * (entry - close) / entry;
                -(loss.min(i64::MAX as u128) as i64)
            }
        }
        Direction::Short => {
            if entry >= close {
                let profit = size * (entry - close) / entry;
                profit.min(i64::MAX as u128) as i64
            } else {
                let loss = size * (close - entry) / entry;
                -(loss.min(i64::MAX as u128) as i64)
            }
        }
    }
}

fn settle_position(
    pos: &mut Position,
    ua: &mut UserAccount,
    close_price: u64,
    close_reason: CloseReason,
) -> Result<()> {
    let pnl = compute_pnl(&pos.direction, pos.size_usd, pos.entry_price, close_price);

    let returned_usdt = ((pos.margin_usd as i64)
        .checked_add(pnl)
        .unwrap_or(0))
        .max(0) as u64;

    ua.locked_margin_usd = ua.locked_margin_usd.checked_sub(pos.margin_usd).unwrap_or(0);
    ua.usdt_balance = ua
        .usdt_balance
        .checked_sub(pos.margin_usd)
        .unwrap_or(0)
        .checked_add(returned_usdt)
        .unwrap_or(ua.usdt_balance);

    let clock = Clock::get()?;
    pos.status = match close_reason {
        CloseReason::Liquidation => PositionStatus::Liquidated,
        _ => PositionStatus::Closed,
    };
    pos.close_price = close_price;
    pos.realized_pnl = pnl;
    pos.close_reason = close_reason.clone();
    pos.closed_at = clock.unix_timestamp;

    emit!(PositionClosed {
        user: pos.owner,
        position_id: pos.position_id,
        pair_index: pos.pair_index,
        trade_mode: pos.trade_mode.clone(),
        direction: pos.direction.clone(),
        size_usd: pos.size_usd,
        margin_usd: pos.margin_usd,
        entry_price: pos.entry_price,
        close_price,
        realized_pnl: pnl,
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
        space = 8 + 32 + 32 + 4 + (32 * 10) + 1,
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

/// PDA seeded with user.key() at creation time — no session here, pays real SOL.
#[derive(Accounts)]
pub struct InitializeUserAccount<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut)]
    pub user: Signer<'info>,
    /// CHECK: Validated against config.treasury
    #[account(mut, constraint = treasury.key() == config.treasury)]
    pub treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Used for open_market_position and open_limit_order.
/// PDA derived from owner stored in user_account — works with both real wallet and session keypair.
#[derive(Accounts, Session)]
pub struct OpenPositionCtx<'info> {
    #[account(
        mut,
        seeds = [b"user", user_account.owner.as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(
        init,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [
            b"position",
            user_account.owner.as_ref(),
            user_account.total_positions.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub position: Account<'info, Position>,
    #[session(signer = user, authority = user_account.owner.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Used for cancel_limit_order and close_position.
#[derive(Accounts, Session)]
pub struct UserPositionAction<'info> {
    #[account(
        mut,
        seeds = [b"user", user_account.owner.as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(
        mut,
        seeds = [
            b"position",
            user_account.owner.as_ref(),
            position.position_id.to_le_bytes().as_ref()
        ],
        bump = position.bump,
        constraint = position.owner == user_account.owner @ ErrorCode::Unauthorized
    )]
    pub position: Account<'info, Position>,
    pub user: Signer<'info>,
    #[session(signer = user, authority = user_account.owner.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
}

/// Used by the executor bot — no session key needed (uses whitelist).
#[derive(Accounts)]
pub struct ExecutorAction<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        mut,
        seeds = [
            b"position",
            position.owner.as_ref(),
            position.position_id.to_le_bytes().as_ref()
        ],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [b"user", position.owner.as_ref()],
        bump = user_account.bump
    )]
    pub user_account: Account<'info, UserAccount>,
    pub executor: Signer<'info>,
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
    pub initial_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct PositionOpened {
    pub user: Pubkey,
    pub position_id: u64,
    pub pair_index: u8,
    pub trade_mode: TradeMode,
    pub direction: Direction,
    pub order_type: OrderType,
    pub size_usd: u64,
    pub margin_usd: u64,
    pub leverage: u8,
    pub entry_price: u64,
    pub limit_price: u64,
    pub take_profit_price: u64,
    pub stop_loss_price: u64,
    pub liquidation_price: u64,
    pub timestamp: i64,
}

#[event]
pub struct LimitOrderFilled {
    pub user: Pubkey,
    pub position_id: u64,
    pub pair_index: u8,
    pub fill_price: u64,
    pub liquidation_price: u64,
    pub timestamp: i64,
}

#[event]
pub struct PositionClosed {
    pub user: Pubkey,
    pub position_id: u64,
    pub pair_index: u8,
    pub trade_mode: TradeMode,
    pub direction: Direction,
    pub size_usd: u64,
    pub margin_usd: u64,
    pub entry_price: u64,
    pub close_price: u64,
    pub realized_pnl: i64,
    pub close_reason: CloseReason,
    pub timestamp: i64,
}

#[event]
pub struct PositionCancelled {
    pub user: Pubkey,
    pub position_id: u64,
    pub pair_index: u8,
    pub margin_returned: u64,
    pub timestamp: i64,
}

// ============= ERRORS =============

#[error_code]
pub enum ErrorCode {
    #[msg("Entry fee is too low (minimum 0.1 SOL)")]
    EntryFeeTooLow,

    #[msg("Insufficient available balance")]
    InsufficientBalance,

    #[msg("Margin must be greater than zero")]
    InvalidMargin,

    #[msg("Price must be greater than zero")]
    InvalidPrice,

    #[msg("Limit price must be greater than zero")]
    InvalidLimitPrice,

    #[msg("Invalid take profit price for this direction")]
    InvalidTakeProfitPrice,

    #[msg("Invalid stop loss price for this direction")]
    InvalidStopLossPrice,

    #[msg("Invalid leverage — spot must be 1x; perp valid tiers: 2,3,5,10,15,20,25,50")]
    InvalidLeverage,

    #[msg("Invalid pair index (0=SOL, 1=BTC, 2=ETH, 3=AVAX, 4=LINK)")]
    InvalidPairIndex,

    #[msg("Position is not active")]
    PositionNotActive,

    #[msg("Position is not in PendingFill status")]
    PositionNotPending,

    #[msg("TP/SL condition not met at current price")]
    ConditionNotMet,

    #[msg("Fill condition not met at current price")]
    FillConditionNotMet,

    #[msg("Liquidation condition not met at current price")]
    LiquidationConditionNotMet,

    #[msg("This position is not a perp — cannot liquidate")]
    NotAPerpPosition,

    #[msg("Unauthorized access")]
    Unauthorized,

    #[msg("Executor is not in the authorized whitelist")]
    UnauthorizedExecutor,

    #[msg("Executor already exists in the whitelist")]
    ExecutorAlreadyExists,
}
