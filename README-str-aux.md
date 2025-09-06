
# dynamics-str · str-aux

Real-time “STR Auxiliary” (str-aux) panels for crypto symbols.  
Backed by live Binance data, IDHR histogram math, and session logic (opening/min/max, swaps, shifts, streams).

---

## ✨ What’s here

- **UI**: `/str-aux` dashboard rendering 4+ coins, dark neon aesthetic.
- **API**: `GET /api/str-aux/bins` → live windowed klines, IDHR histogram, FM (GFM), session stats, streams.
- **Math**:
  - **IDHR** (N-bin log-return histogram) + **Floating Mode** GFM.
  - **Shifts**: price leaves ±ε band around **GFM anchor** for **K** consecutive cycles ⇒ snapshot & re-anchor.
  - **Swaps**: sign changes of benchmark variation with tiny hysteresis.
- **Persistence (optional)**: Postgres session table with `opening_stamp`, `shift_stamp`, `gfm_delta_last` etc.
- **Smokes**: quick CLI checks for lab math and API.

---

## 🗂 Project layout (relevant)

```
src/
  app/
    str-aux/                 # UI
      components/
        CoinPanel.tsx
        StreamsTable.tsx
    api/
      str-aux/
        bins/route.ts        # API (core endpoint)
  core/
    str-aux/
      idhr.ts                # IDHR & FloatingMode
      session.ts             # session store (swaps, shifts, streams)
      stats.ts
      circular.ts
      types.ts
    lib/
      sessionDb.ts           # Postgres write-through (optional)
      layoutHash.ts
  sources/
    binanceKlines.ts         # klines fetch
    binance.ts               # fetch24hAll(), mapTickerBySymbol()
```

> If your repo still uses `@/lab/...` imports, this README applies the same concepts—only paths differ.

---

## 🚀 Quick start

```bash
pnpm i
pnpm dev
# open http://localhost:3000/str-aux
```

Environment (create `.env.local`):

```bash
# UI / API
COINS=BTC,ETH,SOL,ADA

# Optional: Postgres for persistence
DATABASE_URL=postgres://user:pass@host:5432/db
```

---

## 🔌 API

`GET /api/str-aux/bins?coins=BTC,ETH,SOL&window=30m&bins=128&sessionId=str-aux-ui`

**Query params**
- `coins`: comma list (e.g. `BTC,ETH,SOL`)
- `window`: `30m` | `1h` | `3h` (maps to 40/75/210 1m candles)
- `bins`: histogram bins (default 128)
- `sessionId`: stick to a fixed id during a UI session (accumulates state)
- Threshold overrides (dev/tuning):
  - `etaPct` (swaps hysteresis %, default **0.05**)
  - `epsShiftPct` (shift band %, default **0.2**)
  - `K` (consecutive cycles, default **8**)

**Response (per symbol, abridged)**
```jsonc
{
  "opening": 61234.56,
  "sessionStats": { "priceMin": 61000, "priceMax": 62050, "benchPctMin": -0.22, "benchPctMax": 0.35 },
  "fm": { "gfm_r": -0.0012, "gfm_price": 61160.1, "sigma": 0.0095, "zAbs": 0.86, "nuclei": [...] },
  "hist": { "counts": [ ... 128 ... ] },
  "swaps": 3,
  "shifts": 1,
  "shift_stamp": false,             // true exactly on the tick a shift is confirmed
  "gfmDelta": { "absPct": 0.03, "anchorPrice": 61160.1, "price": 61178.5 },
  "streams": {
    "benchmark": { "prev": 61120.0, "cur": 61160.1, "greatest": 62050.0 },  // PRICE
    "pct24h":    { "prev": -0.42,   "cur": -0.35,   "greatest": 1.25 },     // true 24h %
    "pct_drv":   { "prev":  0.01,   "cur":  0.03,   "greatest": 0.10 }      // 1-step %
  }
}
```

---

## 🧮 Math (concise)

- **Returns**: \( r_t = \ln(p_t/p_0) \) where \(p_0\) is session opening.
- **IDHR**: histogram of \(r_t\) over N bins; **GFM** is mode bin center.
- **GFM (price mode)**: \( \text{gfm\_price} = p_0 \cdot e^{\text{gfm\_r}} \)
- **Shift rule**:
  - Let anchor \(A\) be current **GFM anchor in price**.
  - Define band \( [A(1-\epsilon), A(1+\epsilon)] \), with \(\epsilon = \text{epsShiftPct}/100\).
  - If price stays above or below the band for **K** consecutive cycles ⇒ **shift**:
    - Snapshot streams: `prev ← cur`, `cur ← snapshot(now)`.
    - `shifts += 1`, `shift_stamp = true` for that tick.
    - **Re-anchor**: \( A \leftarrow \text{current } \text{gfm\_price} \).
- **Swaps**: sign changes of session benchmark % with η hysteresis.
- **GFMΔ**:
  - Absolute %: \( |p/A - 1| \cdot 100 \) → `gfmDelta.absPct`
  - Absolute price: `|p − A|` (rendered under GFM in UI)

**Defaults**: `etaPct=0.05%`, `epsShiftPct=0.2%`, `K=8` (unless overridden by query).

---

## 🗄️ Database (optional)

**Schema (Postgres)**

```sql
create schema if not exists strategy_aux;

create table if not exists strategy_aux.str_aux_session (
  id                 bigserial primary key,
  pair_base          text not null,
  pair_quote         text not null default 'USDT',
  window_key         text not null,
  app_session_id     text not null,

  opening_stamp      boolean not null default false,  -- set true on first persist of session tuple
  shift_stamp        boolean not null default false,  -- set true exactly on a shift tick

  opening_ts         bigint  not null,
  opening_price      double precision not null,

  price_min          double precision not null,
  price_max          double precision not null,
  bench_pct_min      double precision not null,
  bench_pct_max      double precision not null,

  swaps              integer not null default 0,
  shifts             integer not null default 0,

  gfm_anchor_price   double precision,
  above_count        integer not null default 0,
  below_count        integer not null default 0,

  eta_pct            double precision not null,
  eps_shift_pct      double precision not null,
  k_cycles           integer not null,

  last_price         double precision,
  last_update_ms     bigint not null,

  snap_prev          jsonb,
  snap_cur           jsonb,

  greatest_bench_abs double precision not null default 0,
  greatest_drv_abs   double precision not null default 0,
  greatest_pct24h_abs double precision not null default 0,

  gfm_delta_last     double precision,

  unique (pair_base, pair_quote, window_key, app_session_id)
);

create table if not exists strategy_aux.str_aux_event (
  id          bigserial primary key,
  session_id  bigint not null references strategy_aux.str_aux_session(id) on delete cascade,
  kind        text not null, -- 'opening' | 'shift' | 'swap'
  payload     jsonb,
  created_ms  bigint not null
);
```

**Write-through**: `src/core/lib/sessionDb.ts` safely upserts a row each tick (only if `DATABASE_URL` present) and records shift events.

---

## 🧪 Smokes

```bash
# IDHR/FM offline & live
pnpm tsx -r dotenv/config -r tsconfig-paths/register src/scripts/smoke-idhr.mts
pnpm tsx -r dotenv/config -r tsconfig-paths/register src/scripts/smoke-idhr.mts --live BTCUSDT 1m 90

# System smoke
pnpm tsx -r dotenv/config -r tsconfig-paths/register src/scripts/smoke-str.mts

# (optional) Lab smoke
pnpm tsx -r dotenv/config -r tsconfig-paths/register src/scripts/smoke-lab.mts
```

---

## 🛠 Dev tips

- Use a **fixed** `sessionId` in the UI to accumulate state: `sessionId=str-aux-ui`.
- For quick shift testing: `&epsShiftPct=0.1&K=2` (dev only).
- HMR-safe store: session map is hoisted on `globalThis` (keeps counters across reloads).
- Streams table shows:
  - `benchmark`: **price** (prev/cur/greatest)
  - `pct24h`: true Binance 24h %
  - `pct_drv`: 1-step %

---

## 🧯 Troubleshooting

- **No shifts**: check Network → Preview → `gfmDelta.absPct` (must stay > ε for K cycles), ensure fixed `sessionId`, and `fm.gfm_price` is finite.
- **MIN/MAX blank**: UI expects `stats.minPrice/maxPrice` → API provides both `sessionStats` and `stats` alias.
- **pct24h equals benchmark**: ensure API uses `fetch24hAll() + mapTickerBySymbol()` and UI refreshes.

---

## 📜 License
Internal / WIP (project CryptoPi).
