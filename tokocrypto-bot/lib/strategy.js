"use strict";

/**
 * Engine Strategi Spot Trading (Long-Only: BUY -> HOLD -> SELL TP/SL/Trailing/Exit)
 * Menggunakan data OHLCV asli dari bursa (candle yang sudah TUTUP — anti-repaint).
 * Indikator: EMA 9 / EMA 21 / EMA 50, RSI(14 Wilder), Bollinger Bands(20, 2), ATR(14), Volume Ratio, Efficiency Ratio.
 */

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const calc = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = calc(avgG, avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = calc(avgG, avgL);
  }
  return out;
}

function bollingerAt(closes, endIdx, period = 20, mult = 2) {
  if (endIdx < 0 || endIdx + 1 < period) return null;
  const slice = closes.slice(endIdx - period + 1, endIdx + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: mean + mult * stdDev, middle: mean, lower: mean - mult * stdDev, stdDev };
}

function atrOf(candles, period = 14) {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  let sum = 0;
  let n = 0;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    n++;
  }
  return n ? sum / n : 0;
}

function efficiencyRatio(closes, n = 10) {
  if (closes.length < n + 1) return 0;
  const last = closes.length - 1;
  const change = Math.abs(closes[last] - closes[last - n]);
  let vol = 0;
  for (let i = last - n + 1; i <= last; i++) vol += Math.abs(closes[i] - closes[i - 1]);
  return vol > 0 ? change / vol : 0;
}

function analyzeCandles(rawCandles, hasOpenPosition = false) {
  // Abaikan candle paling akhir yang masih berjalan (belum tutup) agar anti-repaint
  const closed = rawCandles.length > 2 ? rawCandles.slice(0, -1) : rawCandles;
  const n = closed.length;
  if (n < 52) {
    return {
      ready: false,
      proposal: "WAIT",
      score: 0,
      reason: `Data candle kurang (${n}/52).`
    };
  }

  const last = n - 1;
  const closes = closed.map((c) => c.close);
  const volumes = closed.map((c) => c.volume);
  const L = closed[last];
  const P = closed[last - 1];

  const e9 = emaSeries(closes, 9);
  const e21 = emaSeries(closes, 21);
  const e50 = emaSeries(closes, 50);
  const rsiArr = rsiSeries(closes, 14);
  const bb = bollingerAt(closes, last, 20, 2);
  const atr = atrOf(closed, 14);
  const er = efficiencyRatio(closes, 10);

  const ema9 = e9[last];
  const ema21 = e21[last];
  const ema50 = e50[last];
  const slope21 = ema21 - e21[last - 3];
  const rsi = rsiArr[last];
  const rsiPrev = rsiArr[last - 1];

  const avgVol20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol20 > 0 ? L.volume / avgVol20 : 1;

  const range = L.high - L.low;
  const body = Math.abs(L.close - L.open);
  const lowerWick = Math.min(L.open, L.close) - L.low;
  const upperWick = L.high - Math.max(L.open, L.close);
  const isGreen = L.close > L.open;
  const isRed = L.close < L.open;
  const lowerRejection = range > 0 && lowerWick >= range * 0.45 && lowerWick >= body * 1.3;
  const upperRejection = range > 0 && upperWick >= range * 0.45 && upperWick >= body * 1.3;

  const percentB = bb && bb.upper > bb.lower ? (L.close - bb.lower) / (bb.upper - bb.lower) : 0.5;
  const atrPct = L.close > 0 ? (atr / L.close) * 100 : 0;
  const recent20 = closed.slice(-20);
  const support20 = Math.min(...recent20.map((c) => c.low));
  const resistance20 = Math.max(...recent20.map((c) => c.high));
  const distToResistancePct = L.close > 0 ? ((resistance20 - L.close) / L.close) * 100 : 0;
  const distToSupportPct = L.close > 0 ? ((L.close - support20) / L.close) * 100 : 0;

  let trend = "SIDEWAYS";
  if (ema9 > ema21 && ema21 > ema50 && slope21 > 0) trend = "STRONG_UPTREND";
  else if (ema9 > ema21 && slope21 >= 0) trend = "UPTREND";
  else if (ema9 < ema21 && ema21 < ema50 && slope21 < 0) trend = "STRONG_DOWNTREND";
  else if (ema9 < ema21) trend = "DOWNTREND";

  const signals = [];
  const warnings = [];
  let proposal = "WAIT";
  let setupType = "NO_SETUP";
  let score = 0;

  if (!hasOpenPosition) {
    // --- Cari Setup BUY Spot (hanya beli saat probabilitas naik sehat) ---
    const isSpike = atr > 0 && range > atr * 3.0;
    if (isSpike) {
      warnings.push("Candle spike > 3x ATR, tunda entry");
    } else if ((trend === "STRONG_UPTREND" || trend === "UPTREND") && isGreen && L.close > ema9 && L.close > ema21) {
      const pullbackHit = Math.min(L.low, P.low) <= ema9 + 0.3 * atr;
      if (rsi >= 45 && rsi <= 68 && !upperRejection) {
        proposal = "BUY";
        setupType = pullbackHit ? "SPOT_UPTREND_PULLBACK" : "SPOT_UPTREND_CONTINUATION";
        score = 68;
        signals.push(`${trend} (EMA9>EMA21>EMA50)`, `Candle hijau di atas EMA9, RSI ${rsi.toFixed(1)}`);
        if (pullbackHit) {
          score += 7;
          signals.push("Pullback sehat ke EMA9");
        }
        if (volRatio >= 1.15) {
          score += 6;
          signals.push(`Volume kuat (${volRatio.toFixed(2)}x rata-rata)`);
        }
        if (lowerRejection) {
          score += 5;
          signals.push("Lower-wick rejection (buyer kuat)");
        }
        if (er >= 0.35) score += 4;
        if (distToResistancePct >= 1.5) {
          score += 4;
          signals.push(`Ruang naik ke resistance 20-candle masih ${distToResistancePct.toFixed(2)}%`);
        } else if (distToResistancePct < 0.6) {
          score -= 6;
          warnings.push(`Dekat resistance 20-candle (${distToResistancePct.toFixed(2)}%), rawan tertolak`);
        }
      } else {
        warnings.push(`Uptrend tapi RSI ${rsi.toFixed(0)} atau ada upper-wick rejection`);
      }
    } else if (trend !== "STRONG_DOWNTREND" && percentB <= 0.18 && rsi <= 34 && rsi > rsiPrev && (isGreen || lowerRejection)) {
      // Mean-reversion pantulan oversold di lower Bollinger Band
      proposal = "BUY";
      setupType = "SPOT_OVERSOLD_BOUNCE";
      score = 66;
      signals.push(`Oversold bounce di Lower BB (%B ${(percentB * 100).toFixed(0)}%)`, `RSI ${rsi.toFixed(1)} berbalik naik`);
      if (lowerRejection) {
        score += 8;
        signals.push("Lower-wick rejection kuat");
      }
      if (volRatio >= 1.2) {
        score += 6;
        signals.push(`Volume rebound (${volRatio.toFixed(2)}x)`);
      }
    } else {
      warnings.push(`Belum ada setup BUY (${trend}, RSI ${rsi.toFixed(0)}, %B ${(percentB * 100).toFixed(0)}%)`);
    }
  } else {
    // --- Sedang HOLD koin: cek apakah perlu SELL dini sebelum TP/SL ---
    const brokenTrend = L.close < ema21 && ema9 < ema21 && isRed;
    const extremeOverbought = rsi >= 76 && (upperRejection || isRed);
    if (brokenTrend) {
      proposal = "SELL";
      setupType = "TREND_BREAK_EXIT";
      score = 78;
      signals.push("Harga patah di bawah EMA21 & EMA9 cross turun");
    } else if (extremeOverbought) {
      proposal = "SELL";
      setupType = "OVERBOUGHT_TAKE_PROFIT";
      score = 75;
      signals.push(`RSI Overbought ekstrem (${rsi.toFixed(1)}) + penolakan atas`);
    } else {
      signals.push("Posisi aman di-hold (TP/SL/Trailing aktif)");
    }
  }

  score = Math.max(0, Math.min(95, Math.round(score)));

  return {
    ready: true,
    closedCandleTime: L.closeTime,
    lastClose: L.close,
    trend,
    ema9,
    ema21,
    ema50,
    rsi,
    rsiPrev,
    bollinger: bb ? { ...bb, percentB } : null,
    atr,
    atrPct,
    er,
    volRatio,
    support20,
    resistance20,
    distToResistancePct,
    distToSupportPct,
    candleColor: isGreen ? "GREEN" : isRed ? "RED" : "DOJI",
    rejection: lowerRejection ? "LOWER_WICK" : upperRejection ? "UPPER_WICK" : "NONE",
    proposal,
    setupType,
    score,
    signals,
    warnings
  };
}

module.exports = { analyzeCandles };
