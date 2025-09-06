// src/app/api/str-aux/bins/route.ts
import { NextRequest, NextResponse } from 'next/server';

// Be liberal with imports, but keep them type-loose to avoid compile churn
import * as binance from '@/sources/binance';
import * as SessionDb from '@/lib/str-aux/sessionDb';

// Use the same types module the DB/session layer uses
import type { SymbolSession, Snapshot} from '@/str-aux/session';

// computeFM(points: MarketPoint[], opening: OpeningExact, cfg?: Partial<IdhrConfig>)
import { computeFM } from '@/str-aux/idhr';
import { upsertSession } from '@/lib/str-aux/sessionDb';

// ---------- helpers
// --- symbol + coins helpers --------------------------------------------------

export const QUOTE_ASSETS = [
  'USDT', // common quotes first
  'BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'XRP', 'PEPE'
] as const;

export const DEFAULT_COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'XRP', 'PEPE', 'USDT'] as const;

export const QUOTE = 'USDT' as const;

export type WindowKey = '30m' | '1h' | '3h';

const QUOTES_SORTED = [...QUOTE_ASSETS].sort((a, b) => b.length - a.length);

export function parsePair(symbol: string): { base: string; quote: string } {
  const S = symbol.toUpperCase();
  for (const q of QUOTES_SORTED) {
    if (S.endsWith(q)) {
      const base = S.slice(0, S.length - q.length);
      if (base) return { base, quote: q };
    }
  }
  // Fallback
  return { base: S, quote: 'USDT' };
}

export function makeSymbol(base: string, quote = QUOTE): string {
  const B = base.toUpperCase();
  const Q = String(quote).toUpperCase();
  return B.endsWith(Q) ? B : B + Q;
}

export function isQuoteAsset(asset: string, quote = QUOTE): boolean {
  return asset?.toUpperCase() === String(quote).toUpperCase();
}

export function toSymbols(coins: readonly string[], quote = QUOTE): string[] {
  return coins.map((c) => (isQuoteAsset(c, quote) ? c.toUpperCase() : makeSymbol(c, quote)));
}

export type NormalizedSymbolRow = {
  base: string;
  quote: string;
  symbol: string;
  pair_base: string;   // legacy alias, for UI migration
  pair_quote: string;  // legacy alias, for UI migration
  window_key?: WindowKey;
  app_session?: string;
};

export function normalizeSymbolRow<T extends Record<string, any>>(row: T): T & NormalizedSymbolRow {
  // Prefer explicit fields; otherwise derive from symbol; otherwise fallback.
  let base = (row.base ?? row.pair_base ?? '').toString().toUpperCase();
  let quote = (row.quote ?? row.pair_quote ?? '').toString().toUpperCase();
  const symbol = (row.symbol ?? (base && quote ? base + quote : undefined)) as string | undefined;

  if ((!base || !quote) && symbol) {
    const p = parsePair(symbol);
    base ||= p.base;
    quote ||= p.quote;
  }
  if (!quote) quote = QUOTE;

  return {
    ...row,
    base, quote,
    symbol: symbol ?? base + quote,
    pair_base: base,
    pair_quote: quote,
    window_key: (row.window ?? row.window_key) as WindowKey | undefined,
    app_session: (row.appSessionId ?? row.app_session) as string | undefined,
  };
}

// --- ticker normalization -----------------------------------------------------

type TickerLike = Partial<{
  // Binance REST/WebSocket variants
  symbol: string;
  lastPrice: string | number;  // REST 24h
  price: string | number;
  close: string | number;
  c: string | number;
  last: string | number;
  priceChangePercent: string | number; // REST 24h
  P: string | number;                  // WS agg
  pct24h: string | number;
  priceChange: string | number;
}>;

export function num(x: any, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/** Return FRACTION (0.0123 === +1.23%) */
export function pctFromTicker24h(t: TickerLike): number {
  const raw = t?.priceChangePercent ?? t?.P ?? t?.pct24h ?? 0;
  return num(raw) / 100;
}

export function lastPriceFromTicker(t: TickerLike): number {
  return num(t?.lastPrice ?? t?.price ?? t?.close ?? t?.c ?? t?.last);
}

export function normalizeTicker(symOrBase: string, raw: TickerLike, quote = QUOTE) {
  const symbol = makeSymbol(symOrBase, quote);
  const price = lastPriceFromTicker(raw);
  const pct24h = pctFromTicker24h(raw);
  // Some payloads include priceChange; if not, derive from pct
  const priceChange = num(raw?.priceChange, price * pct24h);
  return { symbol, price, pct24h, priceChange, raw };
}

// --- window/interval mapping -------------------------------------------------

export const WINDOW_TO_INTERVAL: Record<WindowKey, string> = {
  '30m': '30m',
  '1h': '1h',
  '3h': '3h',
};

// --- Binance wrappers (safe, name-agnostic) ----------------------------------
// import * as binance from '@/sources/binance'; // make sure this exists where you use these

export async function fetchTicker24hSafe(binanceMod: any, symOrBase: string, quote = QUOTE) {
  const symbol = makeSymbol(symOrBase, quote);
  const fn =
    binanceMod?.fetchTicker24h ??
    binanceMod?.fetch24hTicker ??
    binanceMod?.ticker24h ??
    binanceMod?.fetch24hTickers;

  if (typeof fn !== 'function') {
    throw new Error('binance.fetchTicker24h-like function not available');
  }

  const raw = await fn(symbol);
  return normalizeTicker(symbol, raw, quote);
}

export async function fetchKlinesSafe(
  binanceMod: any,
  symOrBase: string,
  window: WindowKey,
  limit: number,
  quote = QUOTE
): Promise<any[]> {
  const symbol = makeSymbol(symOrBase, quote);
  const interval = WINDOW_TO_INTERVAL[window];
  const fn =
    binanceMod?.fetchKlines ??
    binanceMod?.fetchKLines ??
    binanceMod?.klines ??
    binanceMod?.fetchCandles;

  if (typeof fn !== 'function') {
    throw new Error('binance.fetchKlines-like function not available');
  }
  return fn(symbol, interval, limit);
}

export async function fetchManyTicker24hSafe(binanceMod: any, coins: readonly string[], quote = QUOTE) {
  const symbols = toSymbols(coins, quote);
  return Promise.all(
    symbols.map(async (s) => {
      try {
        const raw = await (binanceMod?.fetchTicker24h ?? binanceMod?.fetch24hTicker ?? binanceMod?.ticker24h)(s);
        return normalizeTicker(s, raw, quote);
      } catch (err) {
        return { symbol: s, error: err };
      }
    })
  );
}


// Load previous session if your SessionDb exposes it (name-tolerant)
async function loadPrevSession(symbol: string): Promise<SymbolSession | undefined> {
  try {
    const mod: any = SessionDb;
    const fn =
      mod.readSession ??
      mod.getSession ??
      mod.loadSession ??
      mod.fetchSession;
    if (!fn) return undefined;
    const s = await fn(symbol);
    return s ?? undefined;
  } catch {
    return undefined;
  }
}

// Persist with best-effort; tolerate one-arg or two-arg signatures
async function persistSessionSafely(
  symbol: string,
  ss: SymbolSession,
  opts: { windowKey: '30m' | '1h' | '3h'; appSessionId?: string; openingStamp?: boolean; shiftStamp?: boolean }
): Promise<void> {
  const { windowKey } = opts;
  const appSession = opts.appSessionId ?? 'ui';

  // DB upsert key, typed from upsertSession signature
  const key: Parameters<typeof upsertSession>[0] = {
    base: symbol,        // e.g., BTC
    quote: QUOTE,        // e.g., USDT
    window: windowKey,    // e.g., "30m"
    appSessionId: appSession,  // e.g., "ui"
  };

  // Stamps: allow the caller to override; otherwise choose sensible defaults
  const openingStamp = opts.openingStamp ?? false;
  const shiftStamp   = opts.shiftStamp   ?? ((ss.gfmDeltaAbsPct ?? 0) !== 0);

  try {
    await upsertSession(key, ss, openingStamp, shiftStamp, ss.gfmDeltaAbsPct);
  } catch (e) {
    // keep this quiet but visible in dev so the API route still responds
    console.error('sessionDb upsert failed:', e);
  }
}

// ---------- main route

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const coinsParam = (url.searchParams.get('coins') || '').trim();
  const windowParam = (url.searchParams.get('window') || '30m').trim();
  const binsParam = num(url.searchParams.get('bins'), 128);
  const sessionId = (url.searchParams.get('sessionId') || 'ui').trim();
  const windowKey: WindowKey =
  windowParam === "30m" || windowParam === "1h" || windowParam === "3h"
    ? (windowParam as WindowKey)
    : "30m";

  // Normalize coin list
  const coins =
    coinsParam.length > 0
      ? coinsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : [...DEFAULT_COINS];

  // For now, drive histogram from 1m klines; ensure we have enough points
  // You can later map windowParam -> interval/limit matrix.
  const interval = '1m';
  const limit = Math.max(128, binsParam * 2); // extra slack

  const out: Record<string, any> = {};
  const now = Date.now();

  // Fetch all tickers first (parallel), but **skip real calls for the quote asset (USDT)**
  const tickers = await Promise.all(
    coins.map(async (sym) => {
      const pair = parsePair(sym);
      if (isQuoteAsset(sym)) {
        // Synthetic stable reference for USDT to avoid 400s like "USDT" (not a trading pair)
        return {
          sym,
          pair,
          t: { lastPrice: 1, priceChangePercent: 0 },
          synthetic: true,
          err: null as string | null,
        };
      }
      try {
        const t = await fetchTicker24hSafe(pair, interval);
        return { sym, pair, t, synthetic: false, err: null as string | null };
      } catch (e: any) {
        // Keep going even if a single ticker fails; we'll fall back to klines
        return {
          sym,
          pair,
          t: null as any,
          synthetic: false,
          err: String(e?.message ?? e),
        };
      }
    })
  );

  for (const { sym, pair, t, synthetic, err } of tickers) {
    try {
      // If ticker failed, we'll try to infer last price from klines
      const tOk = !!t && !err;

      // For USDT (synthetic), force price=1, pct24h=0
      const lastPriceFromT = tOk ? lastPriceFromTicker(t) : (isQuoteAsset(sym) ? 1 : NaN);
      const pct24hFromT = tOk ? pctFromTicker24h(t) : 0;

      // Get klines and build MarketPoint[] (skip network for USDT)
      let kl: any[] = [];
      if (!isQuoteAsset(sym)) {
        try {
          kl = await fetchKlinesSafe(pair, interval, windowKey, limit);
        } catch {
          kl = [];
        }
      }

      // Expected kline row: [openTime, open, high, low, close, volume, closeTime, ...]
      const points: any[] = (Array.isArray(kl) ? kl : []).map((row: any) => {
        const openTime = num(row?.[0]);
        const close = num(row?.[4]);
        const vol = num(row?.[5]);
        const closeTime = num(row?.[6]);
        return {
          ts: closeTime || openTime || now,
          price: close,
          volume: vol,
        };
      });

      // last price from klines if we need a fallback
      const lastFromKlines = points.length ? num(points[points.length - 1]?.price) : NaN;
      const lastPrice = Number.isFinite(lastPriceFromT)
        ? lastPriceFromT
        : (Number.isFinite(lastFromKlines) ? lastFromKlines : 0);

      // Ensure at least one point exists; add a synthetic one if needed
      if (points.length === 0) {
        points.push({ ts: now, price: lastPrice, volume: 0 });
      } else if (points[points.length - 1].ts < now - 45_000) {
        // If last kline is stale, append a fresh tick so computeFM sees "now"
        points.push({ ts: now, price: lastPrice, volume: 0 });
      }

      const prev = await loadPrevSession(sym);

      // Opening reference: prefer prev.opening*, else first point
      const openingPrice = num(prev?.openingPrice, points[0]?.price ?? lastPrice);
      const openingTs = num(prev?.openingTs, points[0]?.ts ?? now);

      // session-relative benchmark percent right now (fraction)
      const benchPctNow = openingPrice > 0 ? lastPrice / openingPrice - 1 : 0;

      // Compute FM (pass minimal opening shape)
      const fm = computeFM(points as any[], { openingTs, openingPrice } as any);
      const gfmCalc = num((fm as any)?.gfm, lastPrice); // GFMc

      // Reference GFMr: previous reference if present; else bootstrap from first compute
      const gfmr = num(prev?.gfmRefPrice, gfmCalc);

      // Deviation vs GFMr for current price
      const gfmDeltaAbsPct = gfmr > 0 ? Math.abs(lastPrice - gfmr) / gfmr : 0;

      // Shift detection params (use prev or defaults)
      const epsShiftPct = num(prev?.epsShiftPct, 0.002); // 0.2%
      const K = num(prev?.K, 32);

      // Sustained-above/below counters
      let aboveCount = num(prev?.aboveCount, 0);
      let belowCount = num(prev?.belowCount, 0);

      const upper = gfmr * (1 + epsShiftPct);
      const lower = gfmr * (1 - epsShiftPct);

      let shiftHappened = false;

      if (lastPrice >= upper) {
        aboveCount += 1;
        belowCount = 0;
      } else if (lastPrice <= lower) {
        belowCount += 1;
        aboveCount = 0;
      } else {
        aboveCount = 0;
        belowCount = 0;
      }

      // Swap detection (sign change with eta threshold)
      const etaPct = num(prev?.etaPct, 0.0005); // 0.05%
      const prevLastPrice = num(prev?.lastPrice, openingPrice);
      const benchDelta = lastPrice - prevLastPrice;
      const benchDeltaPct = prevLastPrice > 0 ? benchDelta / prevLastPrice : 0;
      const benchSign = benchDelta >= 0 ? 1 : -1;
      let swaps = num(prev?.swaps, 0);
      const lastBenchSign = num(prev?.lastBenchSign, benchSign);
      if (benchSign !== lastBenchSign && Math.abs(benchDeltaPct) >= etaPct) {
        swaps += 1;
      }

      // Min/Max tracking within session (prices)
      const priceMin = Math.min(num(prev?.priceMin, openingPrice), lastPrice);
      const priceMax = Math.max(num(prev?.priceMax, openingPrice), lastPrice);

      // 24h change (fraction): from ticker if OK, else 0
      const pct24h = pct24hFromT;

      // Bench % extrema in session (fraction)
      const benchPctMin = Math.min(num(prev?.benchPctMin, benchPctNow), benchPctNow);
      const benchPctMax = Math.max(num(prev?.benchPctMax, benchPctNow), benchPctNow);

      // Greatest absolutes (helpers)
      const greatestPct24hAbs = Math.max(num(prev?.greatestPct24hAbs, Math.abs(pct24h)), Math.abs(pct24h));
      const greatestBenchAbs = Math.max(num(prev?.greatestBenchAbs, Math.abs(lastPrice)), Math.abs(lastPrice));
      const greatestDrvAbs = num(prev?.greatestDrvAbs, 0); // keep until pct_drv is wired

      // Stream snapshots (prev/cur). Use prev.snapCur as new prev if exists.
      const snapPrev: Snapshot =
        prev?.snapCur ??
        ({
          price: openingPrice,
          benchPct: 0,     // at session open, benchPct = 0
          pct24h,
          pctDrv: 0,
          ts: openingTs,
        } as Snapshot);

      const snapCur: Snapshot = {
        price: lastPrice,
        benchPct: benchPctNow,
        pct24h,
        pctDrv: 0,
        ts: now,
      };

      // Shift declaration if any sustained counter reached K
      let shifts = num(prev?.shifts, 0);
      let gfmRefPrice = num(prev?.gfmRefPrice, gfmr);
      let gfmAnchorPrice = prev?.gfmAnchorPrice as number | undefined;
      let uiEpoch = num(prev?.uiEpoch, 0);

      if (aboveCount >= K || belowCount >= K) {
        shiftHappened = true;
        shifts += 1;
        // Update GFMr to the just-computed GFMc (price space)
        gfmRefPrice = gfmCalc;
        gfmAnchorPrice = lastPrice;
        // Reset counters after a shift
        aboveCount = 0;
        belowCount = 0;
        // Advance UI epoch (frontend only rerenders on change)
        uiEpoch += 1;
      }

      // Assemble session state to persist
      const ss: SymbolSession = {
        openingTs,
        openingPrice,
        priceMin,
        priceMax,
        benchPctMin,
        benchPctMax,
        swaps,
        shifts,
        etaPct,
        epsShiftPct,
        K,
        greatestBenchAbs,
        greatestDrvAbs,
        greatestPct24hAbs,
        lastPrice,
        uiEpoch,
        aboveCount,
        belowCount,
        gfmRefPrice,
        gfmAnchorPrice,
        lastBenchSign: benchSign,
        snapPrev,
        snapCur,
        gfmDeltaAbsPct: gfmDeltaAbsPct,
      };

      // Persist (best-effort)
      await persistSessionSafely(sym, ss, { windowKey, appSessionId: sessionId });

      // Prepare API payload per-coin
      out[sym] = {
        ok: true,
        symbol: sym,
        price: lastPrice,
        pct24h,
        fm: {
          gfm: gfmCalc,
          sigma: num((fm as any)?.sigmaGlobal ?? (fm as any)?.sigma),
          zAbs: num((fm as any)?.zMeanAbs ?? (fm as any)?.zAbs),
          vInner: num((fm as any)?.vInner),
          vOuter: num((fm as any)?.vOuter),
          inertia: num((fm as any)?.inertia),
          disruption: num((fm as any)?.disruption),
        },
        gfmr: gfmRefPrice,
        gfmDeltaAbsPct,
        uiEpoch,
        stream: {
          prev: { benchmark: ss.snapPrev.price, pct24h: ss.snapPrev.pct24h, pct_drv: ss.snapPrev.pctDrv },
          cur: { benchmark: ss.snapCur.price, pct24h: ss.snapCur.pct24h, pct_drv: ss.snapCur.pctDrv },
        },
        debug: {
          sessionId,
          pair,
          bins: binsParam,
          window: windowParam,
          shiftHappened,
          upper,
          lower,
          tickerErr: err,
          synthetic,
        },
      };
    } catch (err: any) {
      out[sym] = {
        ok: false,
        symbol: sym,
        price: 0,
        pct24h: 0,
        debug: { error: String(err?.message ?? err) },
      };
    }
  }

  return NextResponse.json({
    ok: true,
    coins,
    bins: binsParam,
    window: windowParam,
    sessionId,
    out,
    meta: { at: now },
  });
}
