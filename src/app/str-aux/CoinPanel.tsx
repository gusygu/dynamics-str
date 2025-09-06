'use client';

import React from 'react';
import StreamsTable from '@/app/str-aux/StreamTable';

function pretty(n: number | undefined | null, digits = 6) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  return Math.abs(v) >= 1e-6 ? v.toFixed(digits) : v.toExponential(2);
}
function prettyPct(n: number | undefined | null, digits = 2) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  return Math.abs(v) >= 1e-6 ? v.toFixed(digits) : v.toExponential(2);
}

export default function CoinPanel({
  symbol,
  coin,
  histogram,
}: {
  symbol: string;
  coin?: {
    ok?: boolean;
    n?: number;
    bins?: number;

    opening?: number;
    openingSet?: { benchmark: number; openingTs: number };

    sessionStats?: { priceMin: number; priceMax: number; benchPctMin: number; benchPctMax: number };
    stats?: { minPrice: number; maxPrice: number }; // legacy alias

    fm?: {
      gfm_r: number;
      gfm_price: number;
      sigma: number;
      zAbs: number;
      vInner: number;
      vOuter: number;
      inertia: number;
      disruption: number;
      nuclei?: { binIndex: number }[];
    };

    swaps?: number;
    shifts?: { nShifts: number; timelapseSec: number; latestTs: number };
    shiftsBlock?: { nShifts: number; timelapseSec: number; latestTs: number };
    shiftsLegacy?: { nShifts: number; timelapseSec: number; latestTs: number };

    // from API
    gfmDelta?: { absPct?: number; anchorPrice?: number | null; price?: number };
    shift_stamp?: boolean;

    streams?: {
      benchmark?: { prev: number; cur: number; greatest: number }; // price
      pct24h?: { prev: number; cur: number; greatest: number };    // %
      pct_drv?: { prev: number; cur: number; greatest: number };   // %
    };

    hist?: { counts: number[] };
    lastUpdateTs?: number;
  } | null;
  histogram?: React.ReactNode;
}) {
  const ok = !!coin?.ok;
  const openingVal = coin?.opening ?? coin?.openingSet?.benchmark;
  const minPrice = coin?.sessionStats?.priceMin ?? coin?.stats?.minPrice;
  const maxPrice = coin?.sessionStats?.priceMax ?? coin?.stats?.maxPrice;
  const shifts = coin?.shifts ?? coin?.shiftsBlock ?? coin?.shiftsLegacy;
  const latest = (shifts?.latestTs ?? coin?.lastUpdateTs)
    ? new Date((shifts?.latestTs ?? coin?.lastUpdateTs)!).toLocaleTimeString()
    : '—';

  // GFM delta parts
  const anchorPrice = coin?.gfmDelta?.anchorPrice ?? null;
  const livePrice = coin?.gfmDelta?.price ?? null;
  const deltaAbsPrice =
    anchorPrice !== null && livePrice !== null ? Math.abs(livePrice - anchorPrice) : null;
  const deltaAbsPct = coin?.gfmDelta?.absPct ?? null;

  // Build the tiny subline: "GFMΔ = 1000 (0.03%)"
  const gfmSub =
    deltaAbsPrice !== null && deltaAbsPct !== null
      ? (
          <div className="mt-0.5 text-[10px] leading-tight text-[var(--muted)]">
            GFMΔ = {pretty(deltaAbsPrice, 6)} ({prettyPct(deltaAbsPct, 2)}%)
          </div>
        )
      : null;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset] p-4">
      {/* header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-md text-xs font-semibold bg-[var(--panel-2)] border border-[var(--border)]">
            {symbol}
          </span>
          <span className="text-xs text-[var(--muted)]">n={coin?.n ?? '—'} · bins={coin?.bins ?? '—'}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>updated {latest}</span>
          {coin?.shift_stamp ? (
            <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-400/30 font-medium">SHIFT</span>
          ) : null}
        </div>
      </div>

      {!ok ? (
        <div className="text-sm text-[var(--muted)]">no data</div>
      ) : (
        <>
          {/* top metric row */}
          <div className="grid grid-cols-4 gap-3 mb-3">
            <Metric label="GFM" value={pretty(coin?.fm?.gfm_price)} accent="violet" sub={gfmSub} />
            <Metric label="σ" value={pretty(coin?.fm?.sigma)} accent="cyan" />
            <Metric label="|z|" value={pretty(coin?.fm?.zAbs)} accent="pink" />
            <Metric label="opening" value={pretty(openingVal)} accent="lime" />
          </div>

          {/* chart */}
          <div className="rounded-xl bg-[var(--panel-2)] border border-[var(--border)] p-2 mb-3">
            {histogram}
          </div>

          {/* MIN/MAX + Shifts + Opening card */}
          <div className="grid grid-cols-3 gap-3 mb-3">
            <Card title="MIN / MAX" subtitle="price (session)">
              <div className="text-sm grid grid-cols-2 gap-x-3">
                <div className="text-[var(--muted)]">min</div>
                <div className="tabular-nums">{pretty(minPrice)}</div>
                <div className="text-[var(--muted)]">max</div>
                <div className="tabular-nums">{pretty(maxPrice)}</div>
              </div>
            </Card>

            <Card title="Shifts" subtitle="confirmed K-cycles">
              <div className="text-sm grid grid-cols-2 gap-x-3">
                <div className="text-[var(--muted)]">nShifts</div>
                <div className="tabular-nums">{shifts?.nShifts ?? '—'}</div>
                <div className="text-[var(--muted)]">swaps</div>
                <div className="tabular-nums">{coin?.swaps ?? '—'}</div>
                <div className="text-[var(--muted)]">timelapse</div>
                <div className="tabular-nums">{shifts ? `${shifts.timelapseSec}s` : '—'}</div>
              </div>
            </Card>

            <Card title="Opening" subtitle="benchmark">
              <div className="text-sm grid grid-cols-2 gap-x-3">
                <div className="text-[var(--muted)]">benchmark</div>
                <div className="tabular-nums">{pretty(openingVal)}</div>
              </div>
            </Card>
          </div>

          {/* streams */}
          <StreamsTable streams={coin?.streams} />

          {/* matrix-style detail */}
          <div className="mt-3 grid grid-cols-3 gap-y-1 text-sm">
            <Row k="vInner" v={pretty(coin?.fm?.vInner, 2)} />
            <Row k="vOuter" v={pretty(coin?.fm?.vOuter, 2)} />
            <Row k="inertia" v={pretty(coin?.fm?.inertia, 3)} />
            <Row k="disruption" v={pretty(coin?.fm?.disruption, 3)} />
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent: 'violet' | 'cyan' | 'pink' | 'lime';
  sub?: React.ReactNode; // 👈 optional tiny subline
}) {
  const ring =
    accent === 'violet'
      ? 'shadow-[0_0_0_1px_rgba(155,100,255,0.25)_inset]'
      : accent === 'cyan'
      ? 'shadow-[0_0_0_1px_rgba(88,255,255,0.25)_inset]'
      : accent === 'pink'
      ? 'shadow-[0_0_0_1px_rgba(255,120,180,0.25)_inset]'
      : 'shadow-[0_0_0_1px_rgba(70,255,140,0.25)_inset]';
  return (
    <div className={`rounded-xl bg-[var(--panel-2)] border border-[var(--border)] ${ring} p-3`}>
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-base font-medium tabular-nums">{value}</div>
      {sub}
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-[var(--panel-2)] border border-[var(--border)] p-3">
      <div className="text-xs text-[var(--muted)]">{title}</div>
      {subtitle && <div className="text-[10px] text-[var(--muted)]/70 mb-1">{subtitle}</div>}
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <div className="text-[var(--muted)]">{k}</div>
      <div className="col-span-2 tabular-nums">{v}</div>
    </>
  );
}
