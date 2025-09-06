import { Pool } from "pg";
import type { SymbolSession, Snapshot } from "@/str-aux/session";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000 });

type Key = { base: string; quote: string; window: "30m"|"1h"|"3h"; appSessionId: string };

// …imports, pool, types…

// add shiftStamp + gfmDelta to API
export async function upsertSession(
  key: Key,
  ss: SymbolSession,
  openingStamp: boolean,
  shiftStamp: boolean,              // NEW
  gfmDelta?: number                 // NEW
) {
  const q = `
    insert into strategy_aux.str_aux_session
      (pair_base, pair_quote, window_key, app_session_id,
       opening_stamp, shift_stamp,
       opening_ts, opening_price,
       price_min, price_max, bench_pct_min, bench_pct_max,
       swaps, shifts, gfm_anchor_price, above_count, below_count,
       eta_pct, eps_shift_pct, k_cycles,
       last_price, last_update_ms, snap_prev, snap_cur,
       greatest_bench_abs, greatest_drv_abs, greatest_pct24h_abs,
       gfm_delta_last)
    values
      ($1,$2,$3,$4,
       $5,$6,
       $7,$8,
       $9,$10,$11,$12,
       $13,$14,$15,$16,$17,
       $18,$19,$20,
       $21,$22,$23,$24,
       $25,$26,$27,
       $28)
    on conflict (pair_base,pair_quote,window_key,app_session_id)
    do update set
      opening_stamp       = strategy_aux.str_aux_session.opening_stamp or EXCLUDED.opening_stamp,
      shift_stamp         = EXCLUDED.shift_stamp,                -- <- tick-level flag
      price_min           = least(strategy_aux.str_aux_session.price_min, EXCLUDED.price_min),
      price_max           = greatest(strategy_aux.str_aux_session.price_max, EXCLUDED.price_max),
      bench_pct_min       = least(strategy_aux.str_aux_session.bench_pct_min, EXCLUDED.bench_pct_min),
      bench_pct_max       = greatest(strategy_aux.str_aux_session.bench_pct_max, EXCLUDED.bench_pct_max),
      swaps               = EXCLUDED.swaps,
      shifts              = EXCLUDED.shifts,
      gfm_anchor_price    = EXCLUDED.gfm_anchor_price,
      above_count         = EXCLUDED.above_count,
      below_count         = EXCLUDED.below_count,
      eta_pct             = EXCLUDED.eta_pct,
      eps_shift_pct       = EXCLUDED.eps_shift_pct,
      k_cycles            = EXCLUDED.k_cycles,
      last_price          = EXCLUDED.last_price,
      last_update_ms      = EXCLUDED.last_update_ms,
      snap_prev           = EXCLUDED.snap_prev,
      snap_cur            = EXCLUDED.snap_cur,
      greatest_bench_abs  = greatest(strategy_aux.str_aux_session.greatest_bench_abs, EXCLUDED.greatest_bench_abs),
      greatest_drv_abs    = greatest(strategy_aux.str_aux_session.greatest_drv_abs, EXCLUDED.greatest_drv_abs),
      greatest_pct24h_abs = greatest(strategy_aux.str_aux_session.greatest_pct24h_abs, EXCLUDED.greatest_pct24h_abs),
      gfm_delta_last      = EXCLUDED.gfm_delta_last
    returning id
  `;
  const v = [
    key.base, key.quote, key.window, key.appSessionId,
    openingStamp, shiftStamp,
    ss.openingTs, ss.openingPrice,
    ss.priceMin, ss.priceMax, ss.benchPctMin, ss.benchPctMax,
    ss.swaps, ss.shifts, ss.gfmAnchorPrice ?? null, ss.aboveCount, ss.belowCount,
    ss.etaPct, ss.epsShiftPct, ss.K,
    ss.lastPrice ?? null, Date.now(), JSON.stringify(ss.snapPrev), JSON.stringify(ss.snapCur),
    ss.greatestBenchAbs, ss.greatestDrvAbs, ss.greatestPct24hAbs,
    gfmDelta ?? ss.gfmDeltaAbsPct,
  ];
  const r = await pool.query(q, v);
  return r.rows[0]?.id as number;
}

