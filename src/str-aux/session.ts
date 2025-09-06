// Session model + snapshot logic with:
// - shifts: price stays beyond ±epsShiftPct of GFM anchor for K cycles
// - anchor update to CURRENT GFM price when a shift confirms
// - separate swap hysteresis (etaPct)
// - pct24h integrated into snapshots
// - exposes GFMdelta (abs % between live price and GFM anchor)

export type Snapshot = {
  ts: number;
  price: number;
  benchPct: number;   // 100 * (price / opening - 1)
  pctDrv: number;     // 100 * (p_t / p_{t-1} - 1)
  pct24h: number;     // Binance 24h priceChangePercent
};

export type Streams = {
  benchmark: { prev: number; cur: number; greatest: number }; // PRICE
  pct24h:    { prev: number; cur: number; greatest: number }; // %
  pct_drv:   { prev: number; cur: number; greatest: number }; // %
};

export type SymbolSession = {
  openingTs: number;
  openingPrice: number;

  priceMin: number;
  priceMax: number;
  benchPctMin: number;
  benchPctMax: number;

  swaps: number;
  shifts: number;

  etaPct: number;       // swap hysteresis (% of opening) — tiny (e.g., 0.05)
  epsShiftPct: number;  // shift band (% of GFM anchor) — e.g., 0.2
  K: number;            // consecutive cycles to confirm shift — e.g., 8

  lastBenchSign: number;

  gfmAnchorPrice?: number; // established GFM price (updated on each confirmed shift)
  aboveCount: number;      // consecutive cycles above +eps
  belowCount: number;      // consecutive cycles below -eps

  snapPrev: Snapshot;
  snapCur: Snapshot;

  greatestBenchAbs: number;
  greatestDrvAbs: number;
  greatestPct24hAbs: number;

  gfmDeltaAbsPct: number;  // last computed |price/anchor - 1| * 100

  lastPrice?: number;
};

// HMR-proof store
declare global {
  // eslint-disable-next-line no-var
  var __STR_AUX_SESS__: Map<string, SymbolSession> | undefined;
}
const SESS: Map<string, SymbolSession> =
  globalThis.__STR_AUX_SESS__ ?? new Map<string, SymbolSession>();
if (!globalThis.__STR_AUX_SESS__) {
  globalThis.__STR_AUX_SESS__ = SESS;
}

function sgn(x: number, eps = 0) {
  if (x > eps) return 1;
  if (x < -eps) return -1;
  return 0;
}

export function getOrInitSymbolSession(
  sessionId: string,
  symbol: string,
  openingPrice: number,
  nowTs: number,
  etaPct = 0.05,     // swaps: ±0.05%
  epsShiftPct = 0.2, // shifts: ±0.2% (default per your new spec)
  K = 8              // confirm after 8 cycles (~5m20s in your cadence)
): SymbolSession {
  const key = `${sessionId}:${symbol}`;
  const cur = SESS.get(key);
  if (cur) return cur;

  const snap0: Snapshot = { ts: nowTs, price: openingPrice, benchPct: 0, pctDrv: 0, pct24h: 0 };

  const ss: SymbolSession = {
    openingTs: nowTs,
    openingPrice,

    priceMin: openingPrice,
    priceMax: openingPrice,
    benchPctMin: 0,
    benchPctMax: 0,

    swaps: 0,
    shifts: 0,

    etaPct,
    epsShiftPct,
    K,

    lastBenchSign: 0,

    gfmAnchorPrice: undefined,
    aboveCount: 0,
    belowCount: 0,

    snapPrev: snap0,
    snapCur: snap0,

    greatestBenchAbs: 0,
    greatestDrvAbs: 0,
    greatestPct24hAbs: 0,

    gfmDeltaAbsPct: 0,

    lastPrice: openingPrice,
  };
  SESS.set(key, ss);
  return ss;
}

/**
 * Update session with latest: live price/ts, CURRENT gfmPrice, CURRENT pct24h.
 * - Initializes anchor from first valid gfmPrice.
 * - Counts consecutive cycles outside the ±eps band around anchor.
 * - On confirmation (>=K), snapshots, increments shifts, and RE-ANCHORS at current gfmPrice.
 * Returns: instantaneous benchPct, pctDrv, pct24h, isShift, and gfmDeltaAbsPct.
 */
export function updateSymbolSession(
  ss: SymbolSession,
  price: number,
  ts: number,
  gfmPrice: number,
  pct24hNow: number
) {
  // init anchor
  if (ss.gfmAnchorPrice === undefined && Number.isFinite(gfmPrice) && gfmPrice > 0) {
    ss.gfmAnchorPrice = gfmPrice;
  }

  // instantaneous
  const benchPct = ((price / ss.openingPrice) - 1) * 100;
  const prevPrice = ss.lastPrice ?? price;
  const pctDrv = ((price / prevPrice) - 1) * 100;
  ss.lastPrice = price;

  // session extrema
  ss.priceMin = Math.min(ss.priceMin, price);
  ss.priceMax = Math.max(ss.priceMax, price);
  ss.benchPctMin = Math.min(ss.benchPctMin, benchPct);
  ss.benchPctMax = Math.max(ss.benchPctMax, benchPct);

  // swaps (sign flips) with small hysteresis on benchPct
  const s = sgn(benchPct, ss.etaPct);
  if (s !== 0 && ss.lastBenchSign !== 0 && s !== ss.lastBenchSign) ss.swaps += 1;
  if (s !== 0) ss.lastBenchSign = s;

  // GFMdelta (abs % distance from ANCHOR)
  if (ss.gfmAnchorPrice && ss.gfmAnchorPrice > 0) {
    ss.gfmDeltaAbsPct = Math.abs((price / ss.gfmAnchorPrice) - 1) * 100;
  } else {
    ss.gfmDeltaAbsPct = 0;
  }

  // shift detection around anchor ± eps
  let justShifted = false;
  if (ss.gfmAnchorPrice && ss.gfmAnchorPrice > 0) {
    const up = ss.gfmAnchorPrice * (1 + ss.epsShiftPct / 100);
    const dn = ss.gfmAnchorPrice * (1 - ss.epsShiftPct / 100);

    if (price >= up) { ss.aboveCount++; ss.belowCount = 0; }
    else if (price <= dn) { ss.belowCount++; ss.aboveCount = 0; }
    else { ss.aboveCount = 0; ss.belowCount = 0; }

    if (ss.aboveCount >= ss.K) {
      // snapshot WHOLE doc state we track
      snapshotOnShift(ss, price, ts, benchPct, pctDrv, pct24hNow);
      // RE-ANCHOR at CURRENT GFM PRICE (inter-relate GFM and nShifts)
      ss.gfmAnchorPrice = gfmPrice;
      ss.aboveCount = 0; ss.belowCount = 0;
      ss.shifts += 1;
      justShifted = true;
    } else if (ss.belowCount >= ss.K) {
      snapshotOnShift(ss, price, ts, benchPct, pctDrv, pct24hNow);
      ss.gfmAnchorPrice = gfmPrice;
      ss.aboveCount = 0; ss.belowCount = 0;
      ss.shifts += 1;
      justShifted = true;
    }
  }

  // greatest magnitudes
  ss.greatestBenchAbs  = Math.max(ss.greatestBenchAbs, Math.abs(benchPct));
  ss.greatestDrvAbs    = Math.max(ss.greatestDrvAbs,   Math.abs(pctDrv));
  ss.greatestPct24hAbs = Math.max(ss.greatestPct24hAbs, Math.abs(pct24hNow));

  return { benchPct, pctDrv, pct24h: pct24hNow, isShift: justShifted, gfmDeltaAbsPct: ss.gfmDeltaAbsPct };
}

function snapshotOnShift(
  ss: SymbolSession,
  price: number,
  ts: number,
  benchPct: number,
  pctDrv: number,
  pct24h: number
) {
  ss.snapPrev = ss.snapCur;
  ss.snapCur = { ts, price, benchPct, pctDrv, pct24h };
}

// Streams:
// - benchmark is PRICE (prev/cur from snapshots, greatest = session price max)
// - pct24h is true 24h percent
// - pct_drv is 1-step percent
export function exportStreams(ss: SymbolSession): Streams {
  return {
    benchmark: { prev: ss.snapPrev.price, cur: ss.snapCur.price, greatest: ss.priceMax },
    pct24h:    { prev: ss.snapPrev.pct24h, cur: ss.snapCur.pct24h, greatest: ss.greatestPct24hAbs },
    pct_drv:   { prev: ss.snapPrev.pctDrv, cur: ss.snapCur.pctDrv, greatest: ss.greatestDrvAbs },
  };
}
