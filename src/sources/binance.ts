// src/sources/binance.ts
export type Ticker24h = {
  symbol: string;
  priceChangePercent: string;
  lastPrice: string;
  weightedAvgPrice: string;
  volume: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
  openTime: number;
  closeTime: number;
};

// Minimal shape used across the app for 24h ticker snapshots
export type T24 = {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
};

const BASE = process.env.BINANCE_BASE_URL ?? 'https://api.binance.com';

export async function fetch24hAll(): Promise<T24[]> {
  const res = await fetch(`${BASE}/api/v3/ticker/24hr`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Binance 24h fetch failed: ${res.status}`);
  const j = (await res.json()) as any[];
  // Normalize just what we use, keep direct symbols only (no bridging logic here)
  return j.map((r) => ({
    symbol: String(r.symbol).toUpperCase(),
    lastPrice: String(r.lastPrice),
    priceChange: String(r.priceChange),
    priceChangePercent: String(r.priceChangePercent),
  }));
}

export function mapTickerBySymbol(rows: T24[]) {
  const map = new Map<string, T24>();
  for (const r of rows) map.set(r.symbol, r);
  return map;
}

export async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`binance 24hr ${symbol} HTTP ${res.status}`);
  return (await res.json()) as Ticker24h;
}
