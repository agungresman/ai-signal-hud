/**
 * Engine analisa lokal cepat & responsif untuk expiry 1 menit (candle 15s):
 * - Warm-up cepat: 12 candle tutup (~3 menit di 15s), memakai EMA 5 / EMA 12, BB(12, 2), RSI(9).
 * - Fokus utama: TREND_CONTINUATION (searah tren & momentum) + RANGE_REVERSAL ketat hanya saat benar-benar sideways.
 * - Anti-repaint: indikator dihitung dari candle yang sudah tutup.
 */
(function (root) {
  "use strict";

  const MIN_CLOSED_CANDLES = 12;

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

  function rsiSeries(closes, period) {
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

  function bollingerAt(closes, endIdx, period, mult) {
    if (endIdx < 0 || endIdx + 1 < period) return null;
    const slice = closes.slice(endIdx - period + 1, endIdx + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
    const stdDev = Math.sqrt(variance);
    return { upper: mean + mult * stdDev, middle: mean, lower: mean - mult * stdDev, stdDev };
  }

  function atrOf(candles, period) {
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

  function efficiencyRatio(closes, n) {
    if (closes.length < n + 1) return 0;
    const last = closes.length - 1;
    const change = Math.abs(closes[last] - closes[last - n]);
    let vol = 0;
    for (let i = last - n + 1; i <= last; i++) vol += Math.abs(closes[i] - closes[i - 1]);
    return vol > 0 ? change / vol : 0;
  }

  function describeCandle(c, atr) {
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const color = c.close > c.open ? "GREEN" : c.close < c.open ? "RED" : "DOJI";
    let rejection = "NONE";
    if (range > 0) {
      if (lowerWick >= range * 0.48 && lowerWick >= body * 1.4) rejection = "LOWER_WICK_REJECTION";
      else if (upperWick >= range * 0.48 && upperWick >= body * 1.4) rejection = "UPPER_WICK_REJECTION";
    }
    return {
      color,
      rejection,
      bodyPct: range > 0 ? body / range : 0,
      rangeAtr: atr > 0 ? range / atr : 0
    };
  }

  class MarketAnalyzer {
    constructor(options = {}) {
      this.candleDurationMs = (options.candleSeconds || 15) * 1000;
      this.maxCandles = 120;
      this.maxTicks = 150;
      this.ticks = [];
      this.candles = [];
      this.currentCandle = null;
      this.closedSeq = 0;
    }

    reset() {
      this.ticks = [];
      this.candles = [];
      this.currentCandle = null;
      this.closedSeq = 0;
    }

    setCandleSeconds(seconds) {
      const nextMs = Math.max(3, Number(seconds) || 15) * 1000;
      if (nextMs !== this.candleDurationMs) {
        this.candleDurationMs = nextMs;
        const existingTicks = [...this.ticks];
        this.reset();
        for (const t of existingTicks) this.addTick(t.price, t.time);
      }
    }

    addTick(price, timestamp = Date.now()) {
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        return { closedCandle: false };
      }

      const prevTick = this.ticks.length > 0 ? this.ticks[this.ticks.length - 1] : null;
      this.ticks.push({ price, time: timestamp, delta: prevTick ? price - prevTick.price : 0 });
      if (this.ticks.length > this.maxTicks) this.ticks.shift();

      const bucketStart = Math.floor(timestamp / this.candleDurationMs) * this.candleDurationMs;
      let closedCandle = false;

      if (!this.currentCandle) {
        this.currentCandle = { time: bucketStart, open: price, high: price, low: price, close: price, tickCount: 1 };
      } else if (bucketStart > this.currentCandle.time) {
        this.candles.push({ ...this.currentCandle });
        if (this.candles.length > this.maxCandles) this.candles.shift();
        this.closedSeq += 1;
        closedCandle = true;
        const open = this.currentCandle.close;
        this.currentCandle = {
          time: bucketStart,
          open,
          high: Math.max(open, price),
          low: Math.min(open, price),
          close: price,
          tickCount: 1
        };
      } else {
        this.currentCandle.high = Math.max(this.currentCandle.high, price);
        this.currentCandle.low = Math.min(this.currentCandle.low, price);
        this.currentCandle.close = price;
        this.currentCandle.tickCount += 1;
      }

      return { closedCandle };
    }

    getAllCandles() {
      if (!this.currentCandle) return [...this.candles];
      return [...this.candles, { ...this.currentCandle }];
    }

    _momentum(closes) {
      if (closes.length < 4) return null;
      const last = closes.length - 1;
      const lookback = Math.min(6, last);
      const diff = closes[last] - closes[last - lookback];
      const rocPct = closes[last - lookback] !== 0 ? (diff / closes[last - lookback]) * 100 : 0;
      const shortDiff = closes[last] - closes[last - 2];
      const shortRocPct = closes[last - 2] !== 0 ? (shortDiff / closes[last - 2]) * 100 : 0;

      let streak = 0;
      let streakDir = "FLAT";
      for (let i = last; i > 0; i--) {
        const d = closes[i] - closes[i - 1];
        if (d === 0) break;
        const dir = d > 0 ? "UP" : "DOWN";
        if (streak === 0) {
          streakDir = dir;
          streak = 1;
        } else if (dir === streakDir) streak += 1;
        else break;
      }

      let upTicks = 0;
      let downTicks = 0;
      for (const t of this.ticks.slice(-15)) {
        if (t.delta > 0) upTicks++;
        else if (t.delta < 0) downTicks++;
      }

      let bias = "NEUTRAL";
      if (diff > 0 && shortDiff > 0) bias = "BULLISH_ACCELERATING";
      else if (diff < 0 && shortDiff < 0) bias = "BEARISH_ACCELERATING";
      else if (diff > 0 && shortDiff < 0) bias = "BULLISH_WEAKENING";
      else if (diff < 0 && shortDiff > 0) bias = "BEARISH_WEAKENING";

      return { lookback, diff, rocPct, shortDiff, shortRocPct, streak, streakDir, upTicks, downTicks, bias };
    }

    _bollingerInfo(closes) {
      const last = closes.length - 1;
      const bb = bollingerAt(closes, last, 12, 2);
      if (!bb) return null;
      const range = bb.upper - bb.lower;
      const price = closes[last];
      const percentB = range > 0 ? (price - bb.lower) / range : 0.5;
      const bandwidthPct = bb.middle > 0 ? (range / bb.middle) * 100 : 0;

      let zone = "MIDDLE";
      if (price > bb.upper) zone = "ABOVE_UPPER_BREAKOUT";
      else if (percentB >= 0.82) zone = "NEAR_UPPER_OVERBOUGHT";
      else if (price < bb.lower) zone = "BELOW_LOWER_BREAKOUT";
      else if (percentB <= 0.18) zone = "NEAR_LOWER_OVERSOLD";

      let squeeze = false;
      const prev = bollingerAt(closes, last - 4, 12, 2);
      if (prev && prev.middle > 0) {
        const prevBw = ((prev.upper - prev.lower) / prev.middle) * 100;
        if (prevBw > 0 && bandwidthPct < prevBw * 0.78) squeeze = true;
      }

      return { period: 12, ...bb, percentB, bandwidthPct, zone, squeeze };
    }

    _confluence(ctx) {
      const { closed, closes, atr, er, trend, rsi, bb, momentum, candleSummary } = ctx;
      const n = closes.length;
      const base = {
        bias: "NO_SETUP",
        score: 0,
        buyScore: 0,
        sellScore: 0,
        setupType: "-",
        regime: trend ? trend.state : "WARMUP",
        er,
        atr,
        signals: [],
        warnings: [],
        blockers: []
      };

      if (n < MIN_CLOSED_CANDLES || !trend || !rsi || !bb) {
        base.regime = "WARMUP";
        base.blockers.push(`Warm-up ${n}/${MIN_CLOSED_CANDLES} candle`);
        return base;
      }
      if (atr <= 0 || bb.stdDev <= 0) {
        base.regime = "DEAD";
        base.blockers.push("Pasar mati (volatilitas nol)");
        return base;
      }

      const last = n - 1;
      const L = closed[last];
      const P = closed[last - 1];
      const dL = candleSummary[candleSummary.length - 1];

      if (dL.rangeAtr > 2.8) {
        base.regime = "SPIKE";
        base.blockers.push("Candle spike > 2.8x ATR");
        return base;
      }
      if (dL.color === "DOJI" || dL.bodyPct < 0.18) {
        base.blockers.push("Candle terakhir doji/ragu");
        return base;
      }

      const regime = trend.state;
      const r = rsi.value;
      const rPrev = rsi.prev;
      const ema5 = trend.ema9;   // fast EMA(5)
      const ema12 = trend.ema21; // slow EMA(12)
      let dir = null;
      let type = "-";
      const fails = [];

      // 1) TREND FOLLOWING (Utama — ikut arah tren & momentum, bukan melawan tren)
      if (regime === "TREND_UP") {
        const bullishClose = dL.color === "GREEN" && L.close > ema5 && L.close > ema12;
        const rsiHealthy = r >= 50 && r <= 88;
        const notClimax = dL.rejection !== "UPPER_WICK_REJECTION";
        const momOk = momentum && momentum.shortDiff > 0;
        if (!bullishClose) fails.push("candle belum hijau di atas EMA5");
        if (!rsiHealthy) fails.push(`RSI ${r.toFixed(0)} di luar 50-88`);
        if (!notClimax) fails.push("ada upper-wick rejection");
        if (!momOk) fails.push("momentum jangka pendek belum naik");
        if (fails.length === 0) {
          dir = "BUY";
          type = Math.min(L.low, P.low) <= ema5 + 0.25 * atr ? "TREND_PULLBACK" : "TREND_CONTINUATION";
          base.signals.push("Uptrend kuat (EMA5>EMA12)", `Momentum naik, RSI ${r.toFixed(0)}`);
        }
      } else if (regime === "TREND_DOWN") {
        const bearishClose = dL.color === "RED" && L.close < ema5 && L.close < ema12;
        const rsiHealthy = r >= 12 && r <= 50;
        const notClimax = dL.rejection !== "LOWER_WICK_REJECTION";
        const momOk = momentum && momentum.shortDiff < 0;
        if (!bearishClose) fails.push("candle belum merah di bawah EMA5");
        if (!rsiHealthy) fails.push(`RSI ${r.toFixed(0)} di luar 12-50`);
        if (!notClimax) fails.push("ada lower-wick rejection");
        if (!momOk) fails.push("momentum jangka pendek belum turun");
        if (fails.length === 0) {
          dir = "SELL";
          type = Math.max(L.high, P.high) >= ema5 - 0.25 * atr ? "TREND_PULLBACK" : "TREND_CONTINUATION";
          base.signals.push("Downtrend kuat (EMA5<EMA12)", `Momentum turun, RSI ${r.toFixed(0)}`);
        }
      } else if (regime === "RANGE") {
        // 2) RANGE REVERSAL ketat — hanya saat benar-benar sideways (ER < 0.20) + rejection + RSI ekstrem berbalik
        const bbPrev = bollingerAt(closes, last - 1, 12, 2);
        const touchedLow = L.low <= bb.lower || (bbPrev && P.low <= bbPrev.lower);
        const touchedHigh = L.high >= bb.upper || (bbPrev && P.high >= bbPrev.upper);

        if (touchedLow && !bb.squeeze) {
          const inside = L.close > bb.lower;
          const reject = dL.rejection === "LOWER_WICK_REJECTION" || (dL.color === "GREEN" && dL.bodyPct >= 0.4);
          const rsiTurn = r <= 30 && r > rPrev;
          if (!inside) fails.push("masih di bawah lower band");
          if (!reject) fails.push("belum ada penolakan kuat dari bawah");
          if (!rsiTurn) fails.push(`RSI ${r.toFixed(0)} belum <=30 & berbalik naik`);
          if (fails.length === 0) {
            dir = "BUY";
            type = "RANGE_REVERSAL";
            base.signals.push("Sideways: pantul kuat lower band", `RSI ${r.toFixed(0)} berbalik naik`);
          }
        } else if (touchedHigh && !bb.squeeze) {
          const inside = L.close < bb.upper;
          const reject = dL.rejection === "UPPER_WICK_REJECTION" || (dL.color === "RED" && dL.bodyPct >= 0.4);
          const rsiTurn = r >= 70 && r < rPrev;
          if (!inside) fails.push("masih di atas upper band");
          if (!reject) fails.push("belum ada penolakan kuat dari atas");
          if (!rsiTurn) fails.push(`RSI ${r.toFixed(0)} belum >=70 & berbalik turun`);
          if (fails.length === 0) {
            dir = "SELL";
            type = "RANGE_REVERSAL";
            base.signals.push("Sideways: pantul kuat upper band", `RSI ${r.toFixed(0)} berbalik turun`);
          }
        } else {
          fails.push("sideways di area tengah / squeeze");
        }
      } else {
        fails.push(`transisi/choppy (ER ${er.toFixed(2)})`);
      }

      if (!dir) {
        base.blockers.push(`${regime}: ${fails.join(", ")}`);
        return base;
      }

      let score = 68;
      if (type === "TREND_PULLBACK") score += 6;
      if (type !== "RANGE_REVERSAL") {
        score += Math.min(10, Math.max(0, (er - 0.25) * 30));
        if (dL.bodyPct >= 0.5) {
          score += 5;
          base.signals.push("Body candle kuat");
        }
      } else {
        if (dL.rejection !== "NONE") score += 8;
      }

      if (momentum) {
        const tickBias = momentum.upTicks - momentum.downTicks;
        const tickAgree = dir === "BUY" ? tickBias > 0 : tickBias < 0;
        if (tickAgree) {
          score += 5;
          base.signals.push("Tekanan tick searah");
        } else if (Math.abs(tickBias) >= 3) {
          score -= 8;
          base.warnings.push("Tekanan tick berlawanan");
        }
      }

      score = Math.max(0, Math.min(92, Math.round(score)));
      base.bias = dir === "BUY" ? "BUY_SETUP" : "SELL_SETUP";
      base.setupType = type;
      base.score = score;
      base.buyScore = dir === "BUY" ? score : 0;
      base.sellScore = dir === "SELL" ? score : 0;
      return base;
    }

    getSnapshot() {
      const closed = this.candles;
      const closes = closed.map((c) => c.close);
      const n = closes.length;
      const last = n - 1;
      const lastTick = this.ticks.length > 0 ? this.ticks[this.ticks.length - 1] : null;

      const atr = atrOf(closed, 10);
      const er = efficiencyRatio(closes, 8);
      const bb = this._bollingerInfo(closes);
      const momentum = this._momentum(closes);

      const rsiArr = rsiSeries(closes, 9);
      let rsi = null;
      if (n > 0 && rsiArr[last] !== null) {
        const v = rsiArr[last];
        const prev = rsiArr[last - 1] !== null && rsiArr[last - 1] !== undefined ? rsiArr[last - 1] : v;
        let zone = "NEUTRAL";
        if (v >= 74) zone = "EXTREME_OVERBOUGHT";
        else if (v >= 66) zone = "OVERBOUGHT";
        else if (v <= 26) zone = "EXTREME_OVERSOLD";
        else if (v <= 34) zone = "OVERSOLD";
        else if (v >= 55) zone = "BULLISH";
        else if (v <= 45) zone = "BEARISH";
        rsi = { period: 9, value: v, prev, zone };
      }

      const eFast = emaSeries(closes, 5);
      const eSlow = emaSeries(closes, 12);
      let trend = null;
      if (n >= MIN_CLOSED_CANDLES && eSlow[last] !== null && eSlow[last - 2] !== null) {
        const ema9 = eFast[last];
        const ema21 = eSlow[last];
        const slope9 = ema9 - eFast[last - 2];
        const slope21 = ema21 - eSlow[last - 2];
        let state = "TRANSITION";
        if (er >= 0.42 && ema9 > ema21 && slope9 > 0 && slope21 > 0) state = "TREND_UP";
        else if (er >= 0.42 && ema9 < ema21 && slope9 < 0 && slope21 < 0) state = "TREND_DOWN";
        else if (er < 0.22) state = "RANGE";
        trend = {
          ema9,
          ema21,
          slope9,
          slope21,
          er,
          state,
          spreadZ: bb && bb.stdDev > 0 ? (ema9 - ema21) / bb.stdDev : 0,
          priceAboveEma9: closes[last] > ema9,
          priceAboveEma21: closes[last] > ema21
        };
      }

      const candleSummary = closed.slice(-4).map((c) => describeCandle(c, atr));
      const confluence = this._confluence({ closed, closes, atr, er, trend, rsi, bb, momentum, candleSummary });

      return {
        timestamp: Date.now(),
        currentPrice: lastTick ? lastTick.price : null,
        lastDelta: lastTick ? lastTick.delta : 0,
        tickCount: this.ticks.length,
        candleCount: this.getAllCandles().length,
        closedCandleCount: n,
        closedSeq: this.closedSeq,
        minClosedCandles: MIN_CLOSED_CANDLES,
        lastClosedClose: n > 0 ? closes[last] : null,
        lastClosedAt: n > 0 ? closed[last].time + this.candleDurationMs : 0,
        candleSeconds: Math.round(this.candleDurationMs / 1000),
        seriesSource: "closed_candles",
        bollinger: bb,
        momentum,
        trend,
        rsi,
        candleSummary,
        confluence,
        recentCandles: closed.slice(-12).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, n: c.tickCount })),
        recentPrices: this.ticks.slice(-25).map((t) => t.price)
      };
    }
  }

  function evaluateSmartTrigger(snapshot, minScore = 68) {
    if (!snapshot || !snapshot.confluence) return { shouldTrigger: false, reason: "WARMUP" };
    const c = snapshot.confluence;
    if (c.bias === "NO_SETUP") return { shouldTrigger: false, reason: c.blockers[0] || "NO_SETUP" };
    if (c.score < minScore) return { shouldTrigger: false, reason: `Skor ${c.score} < ${minScore}` };
    return { shouldTrigger: true, reason: `${c.bias} ${c.setupType} (${c.score})` };
  }

  function parsePriceText(rawText) {
    if (!rawText || typeof rawText !== "string") return null;
    const cleaned = rawText.trim().replace(/\s+/g, "");
    const match = cleaned.match(/-?\d[\d.,]*\d|\d/);
    if (!match) return null;

    let numStr = match[0];
    const hasComma = numStr.includes(",");
    const hasDot = numStr.includes(".");

    if (hasComma && hasDot) {
      if (numStr.lastIndexOf(",") > numStr.lastIndexOf(".")) {
        numStr = numStr.replace(/\./g, "").replace(",", ".");
      } else {
        numStr = numStr.replace(/,/g, "");
      }
    } else if (hasComma && !hasDot) {
      const parts = numStr.split(",");
      if (parts.length === 2 && parts[1].length !== 3) {
        numStr = numStr.replace(",", ".");
      } else {
        numStr = numStr.replace(/,/g, "");
      }
    }

    const val = Number(numStr);
    return Number.isFinite(val) && val > 0 ? val : null;
  }

  const exported = { MarketAnalyzer, evaluateSmartTrigger, parsePriceText, MIN_CLOSED_CANDLES };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  } else {
    if (typeof root !== "undefined") root.StockityIndicators = exported;
    if (typeof window !== "undefined") window.StockityIndicators = exported;
    if (typeof globalThis !== "undefined") globalThis.StockityIndicators = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
