import { NextRequest, NextResponse } from 'next/server';
import { fetchMultiKlines } from '@/sources/binanceKlines';
import {
  computeIdhrBinsN,
  computeFloatingModeIDHR,
  serializeIdhr,
} from '@/str-aux/idhr';
import {
  getOrInitSymbolSession,
  updateSymbolSession,
  exportStreams,
} from '@/str-aux/session';
import type { MarketPoint, OpeningExact } from '@/str-aux/types';

// ✅ use the helpers that already exist in your binance.ts
import { fetch24hAll, mapTickerBySymbol } from '@/sources/binance';

export const dynamic = 'force-dynamic';

function mapWindowToLimit(window: '30m' | '1h' | '3h') {
  if (window === '3h') return { interval: '1m' as const, limit: 210 };
  if (window === '1h') return { interval: '1m' as const, limit: 75 };
  return { interval: '1m' as const, limit: 40 };
}

// optional DB persistence — loads only if DATABASE_URL is set
let _sessionDb: any | null = null;
async function persistSessionSafely(args: {
  symbol: string;
  windowSel: '30m' | '1h' | '3h';
  sessionId: string;
  ss: any;
  last: { price: number; ts: number };
  isShift: boolean;
}) {
  if (!process.env.DATABASE_URL) return;
  try {
    if (!_sessionDb) {
      const mod = await import('@/lib/str-aux/sessionDb');
      _sessionDb = mod.sessionDb;
    }
    const base = args.symbol.replace(/USDT$/i, '');
    const key = {
      base,
      quote: 'USDT',
      window: args.windowSel,
      appSessionId: args.sessionId,
    };

    const openingStamp =
      args.ss.shifts === 0 &&
      args.ss.swaps === 0 &&
      args.ss.priceMin === args.ss.openingPrice &&
      args.ss.priceMax === args.ss.openingPrice;

    const sid = await _sessionDb.upsertSession(
  key,
  args.ss,
  openingStamp
);
// Immediately mark shift rows (separate event log too)
if (args.isShift) {
  await _sessionDb.insertEvent(sid, 'shift', { price: args.last.price, ts: args.last.ts }, args.last.ts);
  // Toggle shift_stamp in-place for this tick:
  await _sessionDb.upsertSession(key, { ...args.ss }, openingStamp /* ignored */);
}
  } catch (e) {
    console.error('sessionDb upsert failed:', e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const coinsStr =
      searchParams.get('coins') ?? process.env.COINS ?? 'BTC,ETH,SOL,ADA';
    const windowSel = (searchParams.get('window') ?? '30m') as
      | '30m'
      | '1h'
      | '3h';
    const N = Math.max(
      8,
      Math.min(1024, Number(searchParams.get('bins') ?? 128)),
    );
    const sessionId = searchParams.get('sessionId') ?? 'default-session';

    // thresholds — defaults + optional overrides
    const defaultEtaPct = 0.05;      // swaps epsilon (%)
    const defaultEpsShiftPct = 0.3;  // shifts epsilon (% of GFM anchor)
    const defaultK = Math.max(1, Math.min(128, Math.round(N / 4))); // 128 -> 32

    const etaPct = Number.isFinite(Number(searchParams.get('etaPct')))
      ? Number(searchParams.get('etaPct'))
      : defaultEtaPct;
    const epsShiftPct = Number.isFinite(Number(searchParams.get('epsShiftPct')))
      ? Number(searchParams.get('epsShiftPct'))
      : defaultEpsShiftPct;
    const K = Number.isFinite(Number(searchParams.get('K')))
      ? Math.max(1, Math.min(128, Number(searchParams.get('K'))))
      : defaultK;

    const bases = coinsStr
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const symbols = bases.map((b) => `${b}USDT`);

    const { interval, limit } = mapWindowToLimit(windowSel);

    // windowed klines
    const klinesMap = await fetchMultiKlines(symbols, interval, limit);

    // ✅ true 24h (all symbols) then map by symbol
    const t24rows = await fetch24hAll();
    const t24map = mapTickerBySymbol(t24rows); // Map<string, { priceChangePercent: string, ... }>

    const nowTs = Date.now();
    const out: Record<string, any> = {};

    for (const sym of symbols) {
      const pts: MarketPoint[] = (klinesMap[sym] ?? []).filter(
        (p) => Number.isFinite(p.price) && p.price > 0,
      );
      if (pts.length < 3) {
        out[sym] = { ok: false, error: 'no-data' };
        continue;
      }

      // session opening (first visit sets it)
      const openingPriceCandidate = pts[0].price;
      const ss = getOrInitSymbolSession(
        sessionId,
        sym,
        openingPriceCandidate,
        pts[0].ts,
        etaPct,
        epsShiftPct,
        K,
      );

      // calculators benchmark = session opening
      const opening: OpeningExact = {
        benchmark: ss.openingPrice,
        pct24h: 0, // not used
        id_pct: 0, // type only
        ts: ss.openingTs,
        layoutHash: 'str-aux:bins:session',
      };

      const idhr = computeIdhrBinsN(pts, opening, { topN: 3 }, N);
      const fm = computeFloatingModeIDHR(pts, opening, {
        totalBins: N,
        topN: 3,
      });

      const last = pts[pts.length - 1];

      // price-mode GFM for UI & shift logic
      const gfmPrice = ss.openingPrice * Math.exp(fm.gfm);

      // ✅ get true 24h %, parsed to number; default 0 if not present
      const t = t24map.get(sym);
      const pct24hNow = t ? Number(t.priceChangePercent) : 0;

      const upd = updateSymbolSession(
        ss,
        last.price,
        last.ts,
        gfmPrice,
        pct24hNow,
      );

      await persistSessionSafely({
        symbol: sym,
        windowSel,
        sessionId,
        ss,
        last,
        isShift: upd.isShift,
      });

      out[sym] = {
        ok: true,
        n: pts.length,
        window: windowSel,
        bins: N,

        openingSet: { benchmark: ss.openingPrice, openingTs: ss.openingTs },
        opening: ss.openingPrice, // legacy top-card

        sessionStats: {
          priceMin: ss.priceMin,
          priceMax: ss.priceMax,
          benchPctMin: ss.benchPctMin,
          benchPctMax: ss.benchPctMax,
        },
        // legacy alias so current UI MIN/MAX renders
        stats: { minPrice: ss.priceMin, maxPrice: ss.priceMax },

        fm: {
          gfm_r: fm.gfm,
          gfm_price: gfmPrice,
          sigma: fm.sigmaGlobal,
          zAbs: fm.zMeanAbs,
          vInner: fm.vInner,
          vOuter: fm.vOuter,
          inertia: fm.inertia,
          disruption: fm.disruption,
          nuclei: fm.nuclei ?? [],
        },
        hist: serializeIdhr(idhr),

        swaps: ss.swaps,
        shifts: ss.shifts,
        shiftsLegacy: {
          nShifts: ss.shifts,
          timelapseSec: Math.round((pts[pts.length - 1].ts - pts[0].ts) / 1000),
          latestTs: last.ts,
        },

        streams: exportStreams(ss),

        instant: {
          benchPct: upd.benchPct,
          pct_drv: upd.pctDrv,
          pct24h: upd.pct24h,
        },
        gfmDelta: {
          absPct: upd.gfmDeltaAbsPct,
          anchorPrice: ss.gfmAnchorPrice ?? null,
          price: last.price,
        },

        // ✅ flag this response as a shift tick
        shift_stamp: !!upd.isShift,  
      };
    }
    
    return NextResponse.json({ ok: true, ts: nowTs, symbols, out });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
