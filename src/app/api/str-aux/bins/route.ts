// src/app/api/str-aux/bins/route.ts
import { NextResponse } from 'next/server';
import * as binance from '@/sources/binance';
import { computeFM, type IdhrConfig, type MarketPoint, type Opening } from '@/str-aux/idhr';
import type { WindowKey } from '@/str-aux/types';
import { upsertSession } from '@/lib/str-aux/sessionDb';
import type { Snapshot } from '@/str-aux/session';

// ----------------------------- helpers --------------------------------------

const QUOTE = 'USDT' as const;

function num(x: any, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function toWindowKey(s: string | null | undefined): WindowKey {
  if (s === '30m' || s === '1h' || s === '3h') return s;
  return '30m';
}

function sanitizeCoinsParam(s: string | null | undefined): string[] {
  if (!s) return ['BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'XRP', 'PEPE', 'USDT'];
  return s.split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
}

function makeSymbol(base: string, quote = QUOTE): string {
  return /USDT$/i.test(base) ? base.toUpperCase() : `${base.toUpperCase()}${quote}`;
}

function lastPriceFromTicker(t: any): number {
  return num(t?.lastPrice ?? t?.price ?? t?.close ?? t?.c ?? t?.last, 0);
}
function pctFromTicker24h(t: any): number {
  // fraction: +1.23% => 0.0123
  const raw = t?.priceChangePercent ?? t?.P ?? t?.pct24h ?? 0;
  return num(raw, 0) / 100;
}
function priceChangeFromTicker(t: any): number {
  return num(t?.priceChange ?? t?.p ?? 0, 0);
}

async function fetchTicker24hSafe(
  binanceMod: any,
  symOrBase: string,
  quote: 'USDT' = QUOTE
) {
  const symbol = makeSymbol(symOrBase, quote);
  const m: any = binanceMod;
  const fn =
    m.fetchTicker24h ??
    m.fetch24hTicker ??
    m.ticker24h ??
    m.fetch24hTickers; // last-resort (some repos had plural)
  if (!fn) throw new Error('binance.fetchTicker24h not available');
  const raw = await fn(symbol);
  return {
    symbol,
    price: lastPriceFromTicker(raw),
    pct24h: pctFromTicker24h(raw), // fraction
    priceChange: priceChangeFromTicker(raw),
    raw,
  };
}

async function fetchKlinesSafe(
  binanceMod: any,
  symOrBase: string,
  window: WindowKey,
  limit: number,
  quote: 'USDT' = QUOTE
): Promise<MarketPoint[]> {
  const symbol = makeSymbol(symOrBase, quote);
  const interval = window; // our WindowKey matches Binance intervals
  const m: any = binanceMod;
  const fn = m.fetchKlines ?? m.fetchKLines ?? m.klines ?? m.fetchCandles;
  if (!fn) throw new Error('binance.fetchKlines not available');
  const arr: any[] = await fn(symbol, interval, limit);
  // [openTime, open, high, low, close, volume, closeTime, ...]
  return arr.map(k => ({
    ts: num(k?.[6] ?? k?.closeTime ?? k?.[0] ?? Date.now()),
    price: num(k?.[4] ?? k?.close ?? k?.price ?? k?.[1]),
    volume: num(k?.[5] ?? k?.volume ?? 0),
  }));
}

function priceHistogram(points: MarketPoint[], bins: number) {
  if (!points.length) return { counts: Array(bins).fill(0), min: 0, max: 0 };
  const min = points.reduce((a, p) => Math.min(a, p.price), points[0].price);
  const max = points.reduce((a, p) => Math.max(a, p.price), points[0].price);
  const width = max > min ? (max - min) / bins : 1;
  const counts = Array(bins).fill(0);
  for (const p of points) {
    let idx = Math.floor((p.price - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    counts[idx] += 1;
  }
  return { counts, min, max };
}

async function persistSessionSafely(
  base: string,
  quote: string,
  windowKey: WindowKey,
  appSessionId: string,
  ss: any,
  openingStamp: boolean,
  shiftStamp: boolean,
  gfmDelta?: number
) {
  try {
    const key = { base, quote, window: windowKey, appSessionId };
    await upsertSession(key as any, ss as any, openingStamp, shiftStamp, gfmDelta);
  } catch (err) {
    console.error('sessionDb upsert failed:', err);
  }
}

// -------------------------------- GET ---------------------------------------

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const coinsParam = sanitizeCoinsParam(url.searchParams.get('coins'));
    const windowKey = toWindowKey(url.searchParams.get('window'));
    const binsParam = num(url.searchParams.get('bins'), 128);
    const appSessionId = (url.searchParams.get('sessionId') ?? 'ui').toString();

    const bases = coinsParam
      .map(s => s.replace(/USDT$/i, ''))
      .filter(b => b && b !== 'USDT'); // never query USDTUSDT

    const results: Record<string, any> = {};
    const now = Date.now();

    for (const base of bases) {
      try {
        const [ticker, points] = await Promise.all([
          fetchTicker24hSafe(binance, base, QUOTE),
          fetchKlinesSafe(binance, base, windowKey, binsParam, QUOTE),
        ]);

        const price = ticker.price;
        const pct24h = ticker.pct24h; // fraction
        const symbol = makeSymbol(base, QUOTE);

        const { counts, min, max } = priceHistogram(
          points,
          Math.max(32, Math.min(binsParam, 256))
        );

        const opening: Opening = {
          benchmark: 0,
          pct24h,
          pct_drv: 0,
          ts: now,
          layoutHash: `${symbol}:${windowKey}`,
        };

        // IDHR / FM with the constants we standardized on:
        const cfg: Partial<IdhrConfig> = { K: 32 };
        const fmRaw = computeFM(points, opening, cfg);

        // Normalize to the schema the UI reads today:
        const fm = {
          gfm: fmRaw.gfm,
          sigma: (fmRaw as any).sigmaGlobal ?? 0,
          zAbs: (fmRaw as any).zMeanAbs ?? 0,
          vInner: fmRaw.vInner,
          vOuter: fmRaw.vOuter,
          inertia: fmRaw.inertia,
          disruption: fmRaw.disruption,
          nuclei: (fmRaw as any).nuclei ?? [],
        };

        // minimal session (enough for persistence & future streaming)
        const snap: Snapshot = {
          price,
          benchPct: pct24h,
          pctDrv: Math.abs(pct24h),
          pct24h,
          ts: now,
        } as any;

        const ss: any = {
          openingTs: points[0]?.ts ?? now,
          openingPrice: points[0]?.price ?? price,
          priceMin: min,
          priceMax: max,
          benchPctMin: pct24h,
          benchPctMax: pct24h,
          swaps: 0,
          shifts: 0,
          etaPct: 0.0005,
          epsShiftPct: 0.002,
          K: 32,
          greatestBenchAbs: Math.abs(pct24h),
          greatestDrvAbs: Math.abs(pct24h),
          greatestPct24hAbs: Math.abs(pct24h),
          lastPrice: price,
          uiEpoch: 0,
          aboveCount: 0,
          belowCount: 0,
          gfmRefPrice: undefined,
          gfmAnchorPrice: price,
          lastBenchSign: Math.sign(pct24h) || 0,
          snapPrev: snap,
          snapCur: snap,
          gfmDeltaAbsPct: Math.abs(pct24h),
        };

        // Best-effort persistence; non-fatal on failure.
        await persistSessionSafely(
          base,
          QUOTE,
          windowKey,
          appSessionId,
          ss,
          false,
          false,
          ss.gfmDeltaAbsPct
        );

        results[symbol] = {
          ok: true,
          base,
          quote: QUOTE,
          symbol,
          price,
          pct24h,
          window: windowKey,
          bins: binsParam,
          fm,
          hist: { counts, max: Math.max(...counts), bins: counts.length },
          streams: [], // can be wired to exportStreams(ss) later
          ts: now,
        };
      } catch (coinErr) {
        const symbol = makeSymbol(base, QUOTE);
        console.error('coin failed', base, coinErr);
        results[symbol] = { ok: false, error: String(coinErr) };
      }
    }

    return NextResponse.json({ ok: true, coins: results, window: windowKey, ts: now });
  } catch (err) {
    console.error('bins route failed', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
