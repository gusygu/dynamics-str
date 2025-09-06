-- base tables are left as-is (no assumptions)

-- opening snapshot
create table if not exists str_aux_opening (
  app_session_id   text not null,
  pair_id          bigint not null,
  ts_ms            bigint not null,
  benchmark        double precision not null,
  pct24h           double precision not null,
  pct_drv          double precision not null,
  layout_hash      text,
  primary key (app_session_id, pair_id)
);

-- stream state
create table if not exists str_aux_stream (
  app_session_id   text not null,
  pair_id          bigint not null,
  benchmark_prev   double precision not null default 0,
  benchmark_cur    double precision not null default 0,
  benchmark_great  double precision not null default 0,
  pct24h_prev      double precision not null default 0,
  pct24h_cur       double precision not null default 0,
  pct24h_great     double precision not null default 0,
  pct_drv_prev     double precision not null default 0,
  pct_drv_cur      double precision not null default 0,
  pct_drv_great    double precision not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (app_session_id, pair_id)
);

-- analysis snapshots (use 'win' instead of reserved word 'window')
create table if not exists str_aux_analysis_snapshots (
  app_session_id   text not null,
  pair_id          bigint not null,
  win             text not null check (win in ('30m','1h','3h')),
  ts_ms            bigint not null,

  included_rate    double precision not null,
  z_abs            double precision not null,
  sigma            double precision not null,
  v_inner          double precision not null,
  v_outer          double precision not null,
  gfm              double precision not null,
  delta_gfm        double precision not null,
  shift_level      integer not null,
  shifted_at_ms    bigint,

  nuclei_bins      smallint[] not null,
  nuclei_density   double precision[] not null,

  primary key (app_session_id, pair_id, win, ts_ms)
);

create index if not exists idx_stream_updated_at
  on str_aux_stream (updated_at desc);

create index if not exists idx_snapshots_lookup
  on str_aux_analysis_snapshots (pair_id, win, ts_ms desc);


-- src/db/ddl-str.sql

-- 1) Create table (fresh install path)
create table if not exists str_aux_docs (
  id text primary key,
  pair_base text not null,
  pair_quote text not null,
  window_key text not null,          -- NOTE: not "window"
  app_session_id text not null,
  opening jsonb not null,
  nuclei jsonb not null,
  stats jsonb not null,
  stream jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2) If an older schema exists with "window", rename it to window_key
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'str_aux_docs' and column_name = 'window'
  ) then
    execute 'alter table str_aux_docs rename column "window" to window_key';
  end if;
end$$;

-- 3) Helpful index for lookups
create index if not exists idx_str_aux_lookup
  on str_aux_docs(pair_base, pair_quote, window_key, app_session_id, updated_at desc);


CREATE SCHEMA IF NOT EXISTS strategy_aux;

-- main document
CREATE TABLE IF NOT EXISTS strategy_aux.str_aux_doc (
  id             TEXT PRIMARY KEY,            -- base:quote:window:layoutHash
  pair_base      TEXT NOT NULL,
  pair_quote     TEXT NOT NULL,
  window_key     TEXT NOT NULL,               -- "30m" | "1h" | "3h"
  app_session_id TEXT NOT NULL,
  opening        JSONB NOT NULL,
  nuclei         JSONB NOT NULL,
  stats          JSONB NOT NULL,
  stream         JSONB NOT NULL,
  updated_ms     BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION strategy_aux.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_str_aux_doc_touch ON strategy_aux.str_aux_doc;
CREATE TRIGGER trg_str_aux_doc_touch
BEFORE UPDATE ON strategy_aux.str_aux_doc
FOR EACH ROW EXECUTE FUNCTION strategy_aux.touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_str_aux_doc_key
  ON strategy_aux.str_aux_doc (pair_base, pair_quote, window_key, app_session_id);

-- write-through snapshots (append-only)
CREATE TABLE IF NOT EXISTS strategy_aux.str_aux_snapshot (
  snapshot_id    BIGSERIAL PRIMARY KEY,
  doc_id         TEXT NOT NULL,               -- matches str_aux_doc.id
  pair_base      TEXT NOT NULL,
  pair_quote     TEXT NOT NULL,
  window_key     TEXT NOT NULL,
  app_session_id TEXT NOT NULL,
  payload        JSONB NOT NULL,              -- full doc snapshot
  updated_ms     BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_str_aux_snapshot_lookup
  ON strategy_aux.str_aux_snapshot (pair_base, pair_quote, window_key, app_session_id, updated_ms DESC);

-- optional retention helper (no-op unless you call it from a job)
CREATE OR REPLACE FUNCTION strategy_aux.prune_snapshots(retain_per_key INT DEFAULT 500)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  WITH ranked AS (
    SELECT snapshot_id,
           ROW_NUMBER() OVER (
             PARTITION BY pair_base, pair_quote, window_key, app_session_id
             ORDER BY updated_ms DESC
           ) AS rn
    FROM strategy_aux.str_aux_snapshot
  )
  DELETE FROM strategy_aux.str_aux_snapshot s
  USING ranked r
  WHERE s.snapshot_id = r.snapshot_id AND r.rn > retain_per_key;
create schema if not exists strategy_aux;

create table if not exists strategy_aux.str_aux_session (
  id               bigserial primary key,
  pair_base        text not null,
  pair_quote       text not null default 'USDT',
  window_key       text not null,
  app_session_id   text not null,

  opening_stamp    boolean not null default false, -- <== your “opening stamp”
  opening_ts       bigint  not null,
  opening_price    double precision not null,

  price_min        double precision not null,
  price_max        double precision not null,
  bench_pct_min    double precision not null,
  bench_pct_max    double precision not null,

  swaps            integer not null default 0,
  shifts           integer not null default 0,

  gfm_anchor_price double precision,
  above_count      integer not null default 0,
  below_count      integer not null default 0,

  eta_pct          double precision not null,
  eps_shift_pct    double precision not null,
  k_cycles         integer not null,

  last_price       double precision,
  last_update_ms   bigint not null,

  snap_prev        jsonb,
  snap_cur         jsonb,

  greatest_bench_abs double precision not null default 0,
  greatest_drv_abs   double precision not null default 0,

  unique (pair_base, pair_quote, window_key, app_session_id)
);

create table if not exists strategy_aux.str_aux_event (
  id          bigserial primary key,
  session_id  bigint not null references strategy_aux.str_aux_session(id) on delete cascade,
  kind        text not null, -- 'opening' | 'shift' | 'swap'
  payload     jsonb,
  created_ms  bigint not null
);
-- add to your existing table
alter table strategy_aux.str_aux_session
  add column if not exists shift_stamp boolean not null default false,
  add column if not exists gfm_delta_last double precision;

-- (table already has opening_stamp boolean as per previous DDL)


END $$;

