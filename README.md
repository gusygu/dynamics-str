Dynamics — Matrices (CryptoPi)

A minimal, fast, direct-only market matrices dashboard.

5 matrices over an 
𝑁
×
𝑁
N×N coin set:

benchmark — last price (A/B), inverse-filled

delta — absolute 24h change, antisymmetric fill

pct24h — 24h change %, shown as percent

id_pct — instantaneous % from previous benchmark

pct_drv — first difference of id_pct; highlights sign flips (−→+ blue / +→− orange)

40s non-overlapping poller → writes snapshots into Postgres

Polished UI (Tailwind + Inter + JetBrains Mono), 2 matrices per row, rounded “pill” cells with heatmap

Strict direct-only sourcing from Binance /api/v3/ticker/24hr — no USDT bridging

Flags: yellow ≈ 0, purple = frozen (no change vs previous cycle), pct_drv blue/orange ring = id_pct sign flip

Quickstart
pnpm i

# 1) Configure DB and coins
copy .env.example .env
# edit .env -> DATABASE_URL, COINS (comma-separated tickers)

# 2) Create tables
pnpm run ddl

# 3) Start the poller (writes every ~40s)
pnpm run poller

# 4) Run the web app
pnpm dev
# http://localhost:3000


You can also embed the poller inside the app: set EMBED_POLLER=true in .env and open /api/status once to start it.

.env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/dynamics
COINS=BTC,ETH,BNB,SOL,ADA,XRP,DOGE,USDT

# poll cadence
POLL_INTERVAL_MS=40000
EMBED_POLLER=false

# sources
BINANCE_BASE_URL=https://api.binance.com

# id_pct sign-flip tolerance (optional)
SIGN_EPS_ABS=1e-9
SIGN_EPS_REL=1e-3


Keep your real .env out of git. See .env.example.

Scripts
# Apply / re-apply schema
pnpm run ddl

# Start the 40s writer loop (standalone)
pnpm run poller

# Inspect DB structure
pnpm run db:inspect
pnpm run db:inspect dyn_matrix_values

# Peek latest values for a pair (defaults BTC ETH)
pnpm run peek BTC ETH

# (optional) one-shot write from the app
curl -X POST http://localhost:3000/api/pipeline/run-once

API

GET /api/status
Health + latest timestamps + row counts per matrix.

GET /api/matrices/latest
Latest snapshot payload (coins, matrices, flags, ts).

GET /api/matrices/server
Same as above; separated for internal/automation use.

POST /api/pipeline/run-once
Force a single snapshot write immediately.

GET /api/coverage
Boolean matrix indicating which direct A/B symbols exist on Binance for your COINS.

Note: The /api/export route is currently disabled. We’ll re-enable CSV/JSON snapshot export in a follow-up.

Data model

Table: dyn_matrix_values

column	type	notes
ts_ms	BIGINT (ms)	snapshot timestamp
matrix_type	TEXT	one of: benchmark, delta, pct24h, id_pct, pct_drv
base	TEXT	coin A
quote	TEXT	coin B
value	DOUBLE PRECISION	cell value
meta	JSONB	metadata (mode, coins, etc.)

PK (ts_ms, matrix_type, base, quote)

Index (matrix_type, base, quote, ts_ms DESC)

Rows per snapshot: up to 
𝑁
×
(
𝑁
−
1
)
N×(N−1).
With direct-only sourcing, missing markets remain NULL (rendered as dashes).

Math (what each matrix means)

Let 
𝑃
𝐴
/
𝐵
P
A/B
	​

 be last traded price for symbol A B on Binance.

benchmark

Direct rows: 
𝑃
𝐴
/
𝐵
P
A/B
	​

 from ticker

Fill inverse: 
𝑃
𝐵
/
𝐴
=
1
/
𝑃
𝐴
/
𝐵
P
B/A
	​

=1/P
A/B
	​


Diagonal: null

delta (absolute 24h change)

Direct rows: priceChange

Antisymmetric fill: 
Δ
𝐵
/
𝐴
=
−
Δ
𝐴
/
𝐵
Δ
B/A
	​

=−Δ
A/B
	​


No further normalization

pct24h

Direct rows: priceChangePercent / 100 (stored as decimal)

Antisymmetric fill: 
𝑝
𝐵
/
𝐴
=
−
𝑝
𝐴
/
𝐵
p
B/A
	​

=−p
A/B
	​


Rendered as % (e.g., 1.23%)

id_pct

id_pct
𝑡
(
𝐴
/
𝐵
)
=
𝑃
𝑡
(
𝐴
/
𝐵
)
−
𝑃
𝑡
−
1
(
𝐴
/
𝐵
)
𝑃
𝑡
−
1
(
𝐴
/
𝐵
)
id_pct
t
	​

(A/B)=
P
t−1
	​

(A/B)
P
t
	​

(A/B)−P
t−1
	​

(A/B)
	​


computed after benchmark inverse fill.
Rendered as raw 7 decimals.

pct_drv

pct_drv
𝑡
(
𝐴
/
𝐵
)
=
id_pct
𝑡
(
𝐴
/
𝐵
)
−
id_pct
𝑡
−
1
(
𝐴
/
𝐵
)
pct_drv
t
	​

(A/B)=id_pct
t
	​

(A/B)−id_pct
t−1
	​

(A/B)

Rendered as raw 7 decimals.
Sign-flip overlay (pct_drv only): compare signs of 
id_pct
𝑡
id_pct
t
	​

 and 
id_pct
𝑡
−
1
id_pct
t−1
	​

 with tolerance:

blue ring: 
−
→
+
−→+

orange ring: 
+
→
−
+→−
Tolerances: SIGN_EPS_ABS, SIGN_EPS_REL.

Flags

frozen (purple): value unchanged vs previous snapshot

near zero (yellow): small magnitude band

Architecture
src/
  app/                      # Next.js app router (pages & API routes)
    api/
      status/
      matrices/
        latest/
        server/
      pipeline/
        run-once/
      coverage/
    (UI pages)
  components/               # Matrix, Legend, StatusCard, TimerBar
  core/
    pipeline.ts             # 40s loop; build → persist
    db.ts                   # PG pool + queries
    matricesLatest.ts       # server builder for latest payload
  math/
    utils.ts                # invertGrid, antisymmetrize, newGrid
    matrices.ts             # buildPrimaryDirect + buildDerived
  sources/
    binance.ts              # fetch 24h ticker and map
  scripts/
    ddl.ts                  # apply DDL
    poller.ts               # start loop (standalone)
    db-inspect.ts           # print columns/indexes
    peek-latest.ts          # CLI peek for a pair
db/
  ddl.sql                   # schema for dyn_matrix_values

UI

Two matrices per row, responsive

Rounded pill cells, subtle inner border, smooth transitions

Inter for text; JetBrains Mono for numbers/timers

Colors: green/red heat, yellow ≈0, purple frozen, pct_drv blue/orange sign flip

pct24h prints as %; others print 7 decimals

Development

Requirements

Node 22+

pnpm 9+

Postgres 16+ running locally

Run

pnpm i
pnpm run ddl
pnpm run poller     # or EMBED_POLLER=true + open /api/status
pnpm dev


Troubleshooting

SCRAM ... client password must be a string → DATABASE_URL missing/invalid; ensure .env is loaded (scripts use dotenv/config).

column "ts_ms" does not exist → you likely have a legacy table. This app uses dyn_matrix_values; re-run pnpm run ddl.

Empty cells/dashes → no direct market on Binance for that pair (by design). Check /api/coverage.

Roadmap

Re-enable /api/export (CSV/JSON, tidy vs matrix)

Date picker to view historical /api/matrices/at?ts=...

Tiny rate-limit for public routes

Unit tests for invertGrid/antisymmetrize/derived math

Optional Docker (db + app) for parity

Snapshot toolbar (download CSV, copy timestamp)

Theme switch (dark cobalt ↔ slate)

License

TBD (project-internal).
Add a license when you’re ready.

Credits

Built fast with ❤️ under the CryptoPi umbrella. Direct-only by default for clean semantics

/// README.md written by g, from chatGPT;

I've done this project with help and guidance of chatGPT genAI, it took me some months for pre-training and for scratching basic logic of TS and Python (not used here). This last version has been made in a couple of hours. Which has been a huge progress for me and the genAI.
This present repo is mostly a shard of a bigger project (CryptoPi (please don't ruin the name)) (as signalized above ^^^^, by g) and is a stepping stone for a complete dashboard, before moving to the actual app.
It aims providing orientation for those who search trading techniques in cryptoasset market. For now t dispose only of the combination of BTC, ETH, BNB, SOL, ADA, XRP, PEPE, USDT; but it'll soon be updated to have a coin selector for free pairing.
It'll soon be updated.
I don't know exactly what anyone would think of the project, or if it has any value at all. 
But if you took interest enough to read this .md, it means something. And that makes me happy.
Ty you guys that also found it cool. ^~^

by gus