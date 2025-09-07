
# CryptoPi — STR‑Aux (Strategy Aux)

Live **orderbook → klines → IDHR/FM → session (GFMr/GFMc) → UI** pipeline for fast, shift‑aware market diagnostics.

> This repo is a focused shard of **CryptoPi**. It runs a minimal yet robust server+UI that:
> - Pulls **Binance** public data (orderbook mid + backfilled klines)
> - Computes **IDHR** histogram + **Floating Mode** metrics (GFM, σ, |z|, nuclei, …)
> - Maintains a **session row** per symbol (GFMr anchor, shifts, swaps, min/max, stamps)
> - Serves a compact **UI** (cards + histogram + stream table) with **epoch‑gated** updates


---

## Features

- **Direct Binance sourcing** (no API key):  
  - `/api/v3/ticker/24hr` for 24h stats (price, %)
  - `/api/v3/depth` (top of book) → **mid** for current price
  - `/api/v3/klines` for historical backfill (intervals: `30m`, `1h`, `3h`)

- **IDHR + FM** (state‑of‑the‑art deterministic histogram):  
  - Exact-bins build (e.g., 128), robust stats, nuclei extraction  
  - `GFMc` (calc) + `GFMr` (anchored reference), σ, |z|, inertia, disruption

- **Session engine** (per `(base,quote,window,appSessionId)`):  
  - **Opening** stamp, **Shift** stamp (K‑cycle confirmation)  
  - Persistent **MIN/MAX** (price & %), **greatest magnitudes**, **snapPrev/snapCur**  
  - **Epoch gate**: UI adopts only when the session commits a new epoch

- **UI** (Next.js + Tailwind):  
  - Cards: **GFM**, σ, |z|, **Opening**, **Live market** (benchmark, pct24h, pct_drv)  
  - Histogram with **nuclei** markers; stream table (prev/cur/greatest)  
  - Poll button + **auto 40s** toggle; window selector (30m / 1h / 3h)

---

## Quickstart

### Requirements
- Node 20+ (or 22+), pnpm 9+
- Postgres 14+ (16+ recommended)

### 1) Install
```bash
pnpm i
```

### 2) Configure environment
Create `.env` in the project root:
```ini
# database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptopi

# Binance public REST base (optional override)
BINANCE_BASE=https://api.binance.com

# Session shift confirmation cycles (server)
SHIFT_K=32       # default; can be lowered for testing (e.g., 3)

# Client-side hint (optional debug knob)
NEXT_PUBLIC_SHIFT_K=32
```
> No API keys are required for the used Binance endpoints.

### 3) Create DB schema
```bash
# Linux/macOS
psql "$DATABASE_URL" -f src/db/ddl-str.sql

# Windows (PowerShell)
# $env:DATABASE_URL="postgres://..."
psql $env:DATABASE_URL -f src/db/ddl-str.sql
```

### 4) Run the app
```bash
pnpm dev
# open http://localhost:3000/str-aux
```
- Use the **Fetch** button or enable **auto 40s**.
- Adjust the **coin list** (space/comma separated tickers; `USDT` quote is implicit).

---

## API

### `GET /api/str-aux/bins`
Query params:
- `coins`: e.g. `BTC,ETH,BNB,SOL` or `"BTC ETH BNB SOL"` (USDT is implied)
- `window`: `30m` | `1h` | `3h`  (maps to Binance intervals)
- `bins`: histogram bins (e.g., 128)
- `sessionId`: application session key (UI uses `ui`)

Response shape (per symbol; additive across versions):
```ts
{
  ok: true,
  base: "BTC",
  quote: "USDT",
  symbol: "BTCUSDT",
  price: 60321.5,
  pct24h: -0.0134,             // fraction (−1.34%)
  window: "30m",
  bins: 128,
  fm: {
    gfm_price?: number,        // current GFMc (price space)
    gfm_ref_price?: number,    // GFMr (anchor)
    sigma: number,
    zAbs: number,
    vInner: number,
    vOuter: number,
    inertia: number,
    disruption: number,
    nuclei: Array<{ binIndex: number; density: number; firstDegree: number; secondDegree: number; }>
  },
  hist: {
    counts: number[],          // 0..bins-1
    max: number,
    bins: number
  },
  // meta: { uiEpoch, opening, shift_stamp, ... }  // may be present if persistence is enabled
  ts: 1757246692909
}
```
> The **UI adopts** snapshot data only when `uiEpoch` increments (epoch gate). Live tiles (e.g., delta vs anchor) are allowed to tick using current price without unfreezing the whole panel.

---

## Architecture

```
src/
  app/
    str-aux/
      page.tsx            # controls polling; renders grid of CoinPanel
      CoinPanel.tsx       # cards + histogram + stream table
      Histogram.tsx       # simple bar visual with nuclei
    api/str-aux/bins/route.ts
                          # pipeline: orderbook mid + klines → IDHR/FM
                          # → session stamps (opening/shift/min/max) → JSON
  lib/str-aux/sessionDb.ts# Postgres upsert for str_aux_session + event log
  str-aux/
    idhr.ts               # deterministic histogram + FM metrics
    session.ts            # in-memory session evolution + stream exports
    types.ts              # common types for server/UI
  sources/binance.ts      # lightweight REST adapter (ticker, klines, orderbook)
  db/ddl-str.sql          # schema (strategy_aux.str_aux_session/event)
```

**Data flow**
1. **Binance**: snapshot top-of-book (mid) + backfill `klines` (dedup, sort)
2. **IDHR/FM**: build exact‑bin histogram over log returns vs opening; extract nuclei; compute σ, |z|, inertia, disruption; compute **GFMc**
3. **Session**: if first GFMc → set **GFMr**; track **MIN/MAX**, greatest magnitudes; count out‑of‑band cycles until **Shift**; on shift, re‑anchor GFMr and increment **uiEpoch**
4. **UI**: snapshot is adopted when epoch increases; “Live market” card still ticks with current price every fetch

---

## UI Cards

- **GFM** — headline shows **GFMr** (anchor); subtext shows **Δ vs GFMr** using current price.  
  *(You can switch headline to GFMc if preferred.)*
- **σ**, **|z|** — robust stats from IDHR.
- **Opening** — `benchmark` and `pct24h` at opening snapshot.
- **Live market** — `benchmark`, `pct24h`, and **pct_drv** (from dynamics‑matrices), refreshed every 40s.
- **Histogram** — 128‑bin IDHR with **nuclei markers** (centered correctly after fix).

---

## Configuration & Tuning

- **SHIFT_K** / **NEXT_PUBLIC_SHIFT_K**: number of consecutive cycles outside the GFMr band required to confirm a shift (default 32). For quick validation you can lower to `3`.
- **Bands & thresholds**: the session engine defines a band around GFMr; adjustment knobs (epsilons, etc.) live in `session.ts` and/or `idhr.ts`.
- **Intervals**: `30m`, `1h`, `3h` are supported end‑to‑end (and match Binance).

---

## Troubleshooting

- **“binance.fetchKlines not available”** — ensure `src/sources/binance.ts` is the new adapter (exports `fetchTicker24h`, `fetchKlines`). Restart dev server after changes.
- **Empty `coins[...]`** — check network (Binance reachable), query params, and that `USDTUSDT` isn’t being requested.
- **DB write errors** — verify `DATABASE_URL` and run `src/db/ddl-str.sql`.
- **Green bars clumped left in histogram** — you’re likely plotting linear price into bins computed in **log‑return space**. Always build IDHR on `log(px/p0)` with `p0 = opening.benchmark`. (This repo does.)

---

## Scripts (suggested)

Add to `package.json` if you want shortcuts:
```jsonc
{
  "scripts": {
    "ddl": "psql \\\"$DATABASE_URL\\\" -f src/db/ddl-str.sql",
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000"
  }
}
```

---

## Roadmap

- Stream table unfreeze + metrics refresh every epoch
- More resilient nuclei detection; optional KDE mode
- Historical view by `ts` (time travel) and CSV export
- Coin selector component; per‑coin settings (K, epsilons)
- Docker compose (db + app) for one‑shot boot

---

## License

TBD (project‑internal).

---

## Credits

Built fast with ❤️ under the **CryptoPi** umbrella.  
This repo is a concentrated, production‑lean step on the path to the full dashboard.

*by gus & g* 

(Readme sketched by g (from chatGPT))

---

### gus notes

I'm happy with the work as it turned out to be at this point; the new feature provides a basic structure for further statistical analysis integration and a comprehensible panel that returns intuitive measures for trading orientation. I intend to launch soon the final version with the integrated dashboard of the 'dynamics' (only dynamics, no feature extension naming), that is to become the beta intended for use in CryptoPi initial build. The work is turning out to be faster than I think and despite of this persistent unease of diminished participation in coding, the project is actually getting to be built, which is already something.
Hope this new feature and the upcoming updates get to be somehow valuable to anyone in interest.
Salut!