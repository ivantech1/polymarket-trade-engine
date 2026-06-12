import type { Strategy } from "./types.ts";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const SIGNAL_PATH = join(import.meta.dir, "../../../signal.json");
const TRADE_LOG_PATH = join(import.meta.dir, "../../logs/trades.csv");
const TRADE_LOG_HEADER = "timestamp,window,direction,entry_price,exit_price,shares,pnl,exit_reason,score,confidence,duration_s\n";
const SCORE_THRESHOLD = 0.55;   // 0.45 flooded us with marginal coin-flips that got whipsawed
const CONFIDENCE_THRESHOLD = 0.62;
const REPRICE_TARGET = 0.20;
const MAX_BUY_PRICE = 0.65;
const MIN_BUY_PRICE = 0.45;        // skip the uncertain 0.30-0.45 zone — book flips too easily there

// Flip-catch: enter when price is at an extreme (e.g. 0.20) and reversing hard.
// Separate from normal entry — needs stronger signal and confirmed rising bids.
const FLIP_CATCH_MAX_PRICE = 0.38;       // only flip-catch when token is priced below this
const FLIP_CATCH_SCORE = 0.65;           // stronger score required — contrarian play
const FLIP_CATCH_CONFIDENCE = 0.72;      // higher confidence bar
const FLIP_CATCH_MIN_BID_RISE = 0.04;    // bid must have risen at least this much across last 4 polls
const FLIP_CATCH_MAX_SHARES = 3;         // smaller position — risk is higher at extremes
const FLIP_CATCH_DUMP_MARGIN = 0.08;     // wider dump exit — low prices have more natural noise
const SIGNAL_MAX_AGE_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;
const MIN_REMAINING_MS = 90_000;
const MIN_GAP_USD = -75;           // skip BUY_UP if BTC is more than $75 below strike
const HOLD_GAP_THRESHOLD = 150;    // hold to resolution instead of selling when gap >= $150
const BAIL_OUT_GAP = 30;           // bail out of hold-to-resolution if gap drops below $30
const LATE_HOLD_PRICE = 0.90;      // switch to hold-to-resolution if bid >= this with <60s left
const PARTIAL_SELL_RATIO = 1.0;    // sell everything at target — no resolution gamble
const REQUIRED_CONSECUTIVE = 2;    // require 2 back-to-back qualifying signals before entry
const MAX_BID_SWING = 0.08;        // skip if book swung this much across last 4 polls
const BID_HISTORY_SIZE = 4;

// Sniper constants — last-minute "already decided" entries
const SNIPER_THRESHOLD = 0.95;     // enter when a side's bid is at or above this
const SNIPER_MAX_ASK = 0.93;       // never pay more than this — risk/reward is unplayable above it
const SNIPER_BAIL = 0.90;          // sell immediately if price drops below this after entry
const SNIPER_WINDOW_MS = 90_000;   // only snipe in the last 90 seconds
const SNIPER_SHARES = 10;          // size up — risk is tiny at 0.95+
const SNIPER_POLL_MS = 2_000;      // check every 2s in the sniper window

type Signal = {
  action: "BUY_UP" | "BUY_DOWN" | "NO_TRADE";
  score: number;
  confidence: number;
  label: string;
  regime: string;
  timestamp: number;
};

function readSignal(): Signal | null {
  try {
    const raw = readFileSync(SIGNAL_PATH, "utf-8");
    const signal = JSON.parse(raw) as Signal;
    if (Date.now() - signal.timestamp > SIGNAL_MAX_AGE_MS) return null;
    return signal;
  } catch {
    return null;
  }
}

function logTrade(data: {
  window: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  exitReason: string;
  score: number;
  confidence: number;
  durationMs: number;
}) {
  try {
    const dir = join(import.meta.dir, "../../logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(TRADE_LOG_PATH)) appendFileSync(TRADE_LOG_PATH, TRADE_LOG_HEADER);
    const pnl = (data.exitPrice - data.entryPrice) * data.shares;
    const row = [
      new Date().toISOString(),
      data.window,
      data.direction,
      data.entryPrice.toFixed(4),
      data.exitPrice.toFixed(4),
      data.shares.toFixed(4),
      pnl.toFixed(4),
      data.exitReason,
      data.score.toFixed(4),
      data.confidence.toFixed(4),
      (data.durationMs / 1000).toFixed(1),
    ].join(",") + "\n";
    appendFileSync(TRADE_LOG_PATH, row);
  } catch {
    // non-critical
  }
}

export const orderflowSignalStrategy: Strategy = async (ctx) => {
  const timers: NodeJS.Timeout[] = [];
  let inPosition = false;
  let destroyed = false;
  let countdownActive = false;
  let lastBid: number | null = null;
  let consecutiveQualifying = 0;
  let windowTraded = false;   // block re-entry after a win in the same window
  let lastSignalAction: string | null = null;  // reset tracking state when direction flips
  const bidHistory: number[] = [];

  // Trades held to resolution can't be logged at window close — the outcome
  // isn't known yet. They're buffered here and flushed once closePrice arrives
  // (via poller, or via cleanup since resolution can land ~ms before destroy).
  type PendingResolution = {
    side: "UP" | "DOWN";
    entryPrice: number;
    shares: number;
    entryTime: number;
    exitReason: string;
    score: number;
    confidence: number;
    lastBid: number | null;
  };
  const pendingResolutions: PendingResolution[] = [];

  function flushResolutionLogs(final: boolean): void {
    if (pendingResolutions.length === 0) return;
    const windowId = String((ctx.slotEndMs - 300_000) / 1000);
    const result = ctx.getMarketResult();
    const close = result?.closePrice ?? null;

    if (result && close !== null) {
      const winner = close >= result.openPrice ? "UP" : "DOWN";
      while (pendingResolutions.length > 0) {
        const p = pendingResolutions.shift()!;
        const won = winner === p.side;
        if (!won) log(`[resolution] ${p.side} LOST — resolved at 0.00`, "red");
        logTrade({
          window: windowId,
          direction: p.side,
          entryPrice: p.entryPrice,
          exitPrice: won ? 1.0 : 0.0,
          shares: p.shares,
          exitReason: won ? p.exitReason : `${p.exitReason} loss`,
          score: p.score,
          confidence: p.confidence,
          durationMs: Date.now() - p.entryTime,
        });
      }
      return;
    }

    // Close price never arrived and we're tearing down — log best estimate
    // rather than silently dropping the trade. Marked so it's visible in the CSV.
    if (final) {
      while (pendingResolutions.length > 0) {
        const p = pendingResolutions.shift()!;
        logTrade({
          window: windowId,
          direction: p.side,
          entryPrice: p.entryPrice,
          exitPrice: p.lastBid ?? 1.0,
          shares: p.shares,
          exitReason: `${p.exitReason} (unconfirmed)`,
          score: p.score,
          confidence: p.confidence,
          durationMs: Date.now() - p.entryTime,
        });
      }
    }
  }

  const resolutionFlushPoll = setInterval(() => flushResolutionLogs(false), 2_000);
  timers.push(resolutionFlushPoll as unknown as NodeJS.Timeout);

  // Dynamic thresholds based on gap (BTC price minus strike price).
  // Large positive gap = BTC already winning → lower confidence bar, bigger target.
  // Negative gap = BTC needs to reverse → raise confidence bar, take profits quicker.
  function thresholdsFromGap(gap: number | null): { confidenceThreshold: number; repriceTarget: number } {
    if (gap === null) return { confidenceThreshold: CONFIDENCE_THRESHOLD, repriceTarget: REPRICE_TARGET };
    if (gap >= 150)  return { confidenceThreshold: 0.50, repriceTarget: 0.25 }; // well above — near-certainty, go bigger
    if (gap >= 50)   return { confidenceThreshold: 0.52, repriceTarget: 0.22 }; // comfortably above
    if (gap >= 0)    return { confidenceThreshold: 0.55, repriceTarget: 0.20 }; // at/just above — defaults
    if (gap >= -30)  return { confidenceThreshold: 0.65, repriceTarget: 0.17 }; // slightly below — need stronger signal, exit quicker
    return           { confidenceThreshold: 0.72, repriceTarget: 0.15 };        // -30 to -75 — reversal needed, very strict
  }

  function sharesFromConfidenceAndGap(confidence: number, gap: number | null): number {
    let base: number;
    if (confidence >= 0.85) base = 10;
    else if (confidence >= 0.75) base = 7;
    else if (confidence >= 0.65) base = 5;
    else base = 3;
    // Large positive gap = BTC clearly winning, size up
    if (gap !== null && gap >= 150) return Math.min(base + 2, 10);
    // Negative gap = BTC needs reversal, size down
    if (gap !== null && gap < 0) return Math.max(base - 1, 2);
    return base;
  }

  const release = ctx.hold();

  function log(msg: string, color?: string) {
    if (countdownActive) process.stdout.write("\n");
    ctx.log(msg, color);
  }

  function tryTrade() {
    if (destroyed || inPosition) return;

    if (windowTraded) {
      log(`[orderflow] skip — already won this window, no re-entry`, "yellow");
      return;
    }

    const remaining = ctx.slotEndMs - Date.now();
    if (remaining < MIN_REMAINING_MS) {
      log(`[orderflow] <90s remaining, no more entries this window`, "yellow");
      return;
    }

    const signal = readSignal();
    if (!signal) {
      consecutiveQualifying = 0;
      log("[orderflow] no valid signal", "yellow");
      return;
    }

    if (signal.action === "NO_TRADE") {
      consecutiveQualifying = 0;
      log("[orderflow] skip — signal is NO_TRADE", "yellow");
      return;
    }

    const side = signal.action === "BUY_DOWN" ? "DOWN" : "UP";

    // Reset bid tracking state when direction flips between polls
    if (lastSignalAction !== null && lastSignalAction !== signal.action) {
      consecutiveQualifying = 0;
      lastBid = null;
      bidHistory.length = 0;
    }
    lastSignalAction = signal.action;

    // Regime filter — block regimes that oppose our direction
    const blockedRegimes = side === "UP"
      ? ["TREND_DOWN", "LONG_SQUEEZE", "RANGE", "HIGH_VOLATILITY"]
      : ["TREND_UP", "SHORT_SQUEEZE", "RANGE", "HIGH_VOLATILITY"];
    if (blockedRegimes.includes(signal.regime)) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — regime (${signal.regime}) blocks ${side}`, "yellow");
      return;
    }

    const openPrice = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price;
    const gap = openPrice !== null && btcPrice !== undefined ? btcPrice - openPrice : null;

    // Gap check — for UP: skip if BTC too far below strike; for DOWN: skip if too far above
    if (side === "UP" && gap !== null && gap < MIN_GAP_USD) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — BTC $${gap.toFixed(0)} below strike (min ${MIN_GAP_USD} for UP)`, "yellow");
      return;
    }
    if (side === "DOWN" && gap !== null && gap > -MIN_GAP_USD) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — BTC $${gap.toFixed(0)} above strike (max ${-MIN_GAP_USD} for DOWN)`, "yellow");
      return;
    }

    // Effective gap from this side's perspective: positive = BTC already on our side of strike
    const effectiveGap = gap !== null ? (side === "UP" ? gap : -gap) : null;
    const { confidenceThreshold, repriceTarget } = thresholdsFromGap(effectiveGap);

    const qualifies =
      Math.abs(signal.score) >= SCORE_THRESHOLD &&
      signal.confidence >= confidenceThreshold;

    if (!qualifies) {
      consecutiveQualifying = 0;
      log(
        `[orderflow] skip — score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} (need ${confidenceThreshold.toFixed(2)})`,
        "yellow",
      );
      return;
    }

    consecutiveQualifying++;
    if (consecutiveQualifying < REQUIRED_CONSECUTIVE) {
      const gapLabel = gap !== null ? ` gap=${gap >= 0 ? "+" : ""}${gap.toFixed(0)}` : "";
      log(
        `[orderflow] signal ${consecutiveQualifying}/${REQUIRED_CONSECUTIVE} — waiting for confirmation | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} threshold=${confidenceThreshold.toFixed(2)}${gapLabel}`,
        "yellow",
      );
      return;
    }
    consecutiveQualifying = 0;

    const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const askInfo = ctx.orderBook.bestAskInfo(side);

    if (!askInfo || askInfo.liquidity < 1) {
      log(`[orderflow] no liquidity on ${side}, skipping`, "yellow");
      return;
    }

    const buyPrice = askInfo.price;

    // Momentum check: skip if bid has been falling
    const currentBid = ctx.orderBook.bestBidPrice(side);
    if (lastBid !== null && currentBid !== null && currentBid < lastBid - 0.04) {
      log(`[orderflow] skip — bid falling ${lastBid.toFixed(2)} → ${currentBid.toFixed(2)}`, "yellow");
      lastBid = currentBid;
      consecutiveQualifying = 0;
      return;
    }
    lastBid = currentBid ?? lastBid;

    // Track bid history — used for both volatility gate and flip-catch detection
    if (currentBid !== null) {
      bidHistory.push(currentBid);
      if (bidHistory.length > BID_HISTORY_SIZE) bidHistory.shift();
    }

    // Flip-catch: price is at an extreme (e.g. 0.20) and bid is rising fast across polls.
    // The rising bid confirms the crowd is actually reversing, not just a noise tick.
    const bidRise = bidHistory.length >= BID_HISTORY_SIZE
      ? bidHistory[bidHistory.length - 1] - bidHistory[0]
      : 0;
    const flipCatch =
      buyPrice < FLIP_CATCH_MAX_PRICE &&
      Math.abs(signal.score) >= FLIP_CATCH_SCORE &&
      signal.confidence >= FLIP_CATCH_CONFIDENCE &&
      bidRise >= FLIP_CATCH_MIN_BID_RISE;

    if (!flipCatch) {
      if (buyPrice > MAX_BUY_PRICE) {
        log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} above max ${MAX_BUY_PRICE}`, "yellow");
        return;
      }
      if (buyPrice < MIN_BUY_PRICE) {
        const crowdDesc = side === "UP" ? "crowd >55% bearish" : "crowd >55% bullish";
        log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} below min ${MIN_BUY_PRICE} (${crowdDesc})`, "yellow");
        consecutiveQualifying = 0;
        return;
      }
      // Book volatility check: skip if bid has been swinging wildly (flip-catch exempted — the swing IS the signal)
      if (bidHistory.length >= BID_HISTORY_SIZE) {
        const swing = Math.max(...bidHistory) - Math.min(...bidHistory);
        if (swing > MAX_BID_SWING) {
          consecutiveQualifying = 0;
          log(`[orderflow] skip — book unstable, swing=${swing.toFixed(3)} > max=${MAX_BID_SWING}`, "yellow");
          return;
        }
      }
    }

    // Whale dump: cross-exchange divergence means a large seller is hitting one exchange
    if (ctx.ticker.isWhaleDump) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — whale dump detected (cross-exchange divergence)`, "yellow");
      return;
    }

    const sellTarget = Math.min(buyPrice + repriceTarget, 0.95);
    // Flip-catch uses a fixed small size — risk is higher at price extremes
    const shares = flipCatch
      ? FLIP_CATCH_MAX_SHARES
      : sharesFromConfidenceAndGap(signal.confidence, effectiveGap);
    // Flip-catch gets a wider dump exit — low prices have more natural noise
    const dumpExitMargin = flipCatch ? FLIP_CATCH_DUMP_MARGIN : 0.06;

    let holdToResolution = effectiveGap !== null && effectiveGap >= HOLD_GAP_THRESHOLD;
    const gapStr = gap !== null ? ` | gap=${gap >= 0 ? "+" : ""}${gap.toFixed(0)}` : "";
    const modeStr = holdToResolution ? " | HOLD TO RESOLUTION" : ` → ${sellTarget.toFixed(2)}`;
    const entryTag = flipCatch ? " [FLIP-CATCH]" : "";
    log(
      `[orderflow] ENTRY${entryTag} — ${signal.label} | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} | ${side} @ ${buyPrice}${modeStr} | shares=${shares}${gapStr}`,
      "cyan",
    );

    const entryTime = Date.now();
    const entryScore = signal.score;
    const entryConfidence = signal.confidence;
    const windowId = String((ctx.slotEndMs - 300_000) / 1000);

    inPosition = true;

    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "buy",
          price: buyPrice,
          shares,
          orderType: "FOK",
        },
        expireAtMs: ctx.slotEndMs - MIN_REMAINING_MS,

        onFilled(filledShares) {
          const fillMsg = holdToResolution
            ? `[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | holding to resolution`
            : `[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | target=${sellTarget.toFixed(2)}`;
          log(fillMsg, "green");

          const partialShares = Math.round(filledShares * PARTIAL_SELL_RATIO * 10000) / 10000;
          const holdShares = Math.round((filledShares - partialShares) * 10000) / 10000;

          let partialSold = false;
          let fullyExited = false;
          let adverseReads = 0;        // consecutive adverse-regime *distinct* signals before bailing
          let lastSeenSignalTs = 0;    // dedupe: signal.json only refreshes every ~20s
          countdownActive = true;

          function sellShares(sharesToSell: number, reason: string, onDone?: () => void) {
            const pendingSells = ctx.pendingOrders.filter((o) => o.action === "sell");
            if (pendingSells.length > 0) {
              log(`[orderflow] sell already in flight (${reason}), skipping`, "yellow");
              onDone?.();
              return;
            }
            const bid = ctx.orderBook.bestBidPrice(side);
            const sellPrice = (bid && bid > 0) ? bid : 0.01;
            log(`[orderflow] ${reason} — FAK sell ${sharesToSell.toFixed(4)}sh @ ${sellPrice}`, "cyan");
            ctx.postOrders([{
              req: { tokenId, action: "sell", price: sellPrice, shares: sharesToSell, orderType: "FAK" },
              expireAtMs: ctx.slotEndMs,
              onFilled() {
                log(`[orderflow] SELL filled @ ${sellPrice} (${reason})`, "green");
                logTrade({
                  window: windowId,
                  direction: side,
                  entryPrice: buyPrice,
                  exitPrice: sellPrice,
                  shares: sharesToSell,
                  exitReason: reason,
                  score: entryScore,
                  confidence: entryConfidence,
                  durationMs: Date.now() - entryTime,
                });
                onDone?.();
              },
              onFailed(r) { log(`[orderflow] sell failed (${r}) — ${reason}`, "red"); },
            }]);
          }

          function doTimeExit() {
            if (fullyExited || destroyed) return;
            fullyExited = true;
            countdownActive = false;
            clearInterval(pricePoller);
            const sharesToSell = partialSold ? holdShares : filledShares;
            if (sharesToSell > 0) sellShares(sharesToSell, "time limit");
            inPosition = false;
          }

          const pricePoller = setInterval(() => {
            if (fullyExited || destroyed) { clearInterval(pricePoller); return; }
            const remaining = ctx.slotEndMs - Date.now();
            const bid = ctx.orderBook.bestBidPrice(side);
            const holdingNow = partialSold ? holdShares : filledShares;

            // Exit logic — two distinct dangers, handled separately:
            //
            // (1) REAL DUMP: the bid is actually dropping below our entry. This is
            //     real-time truth and the biggest source of loss (−$19 last night).
            //     Bail FAST — every second of delay deepens the loss.
            //
            // (2) SLOW BLEED: regime turns adverse but price is still holding near
            //     entry. The regime is a 20s-stale noisy classifier, so a single
            //     adverse refresh is usually noise. Require 2 distinct refreshes to confirm.
            if (bid !== null && bid < buyPrice - dumpExitMargin) {
              process.stdout.write("\n");
              log(`[orderflow] PRICE DUMP — bid ${bid.toFixed(2)} dropped >${dumpExitMargin} below entry ${buyPrice.toFixed(2)}, selling now`, "red");
              fullyExited = true;
              countdownActive = false;
              clearInterval(pricePoller);
              sellShares(holdingNow, "price dump", () => { inPosition = false; });
              return;
            }

            const liveSignal = readSignal();
            if (liveSignal && liveSignal.timestamp !== lastSeenSignalTs) {
              lastSeenSignalTs = liveSignal.timestamp;
              // Adverse = regime flipped to oppose our position direction
              const adverse = side === "UP"
                ? (liveSignal.regime === "TREND_DOWN" || liveSignal.regime === "LONG_SQUEEZE")
                : (liveSignal.regime === "TREND_UP" || liveSignal.regime === "SHORT_SQUEEZE");
              adverseReads = adverse ? adverseReads + 1 : 0;
            }
            if (adverseReads >= 2) {
              process.stdout.write("\n");
              log(`[orderflow] REGIME FLIP — confirmed adverse over ${adverseReads} refreshes, selling now`, "red");
              fullyExited = true;
              countdownActive = false;
              clearInterval(pricePoller);
              sellShares(holdingNow, "regime flip", () => { inPosition = false; });
              return;
            }

            if (holdToResolution) {
              const currentBtc = ctx.ticker.price;
              const currentGap = openPrice !== null && currentBtc !== undefined
                ? currentBtc - openPrice : null;
              const currentEffectiveGap = currentGap !== null
                ? (side === "UP" ? currentGap : -currentGap) : null;
              const gapNow = currentGap !== null ? `gap=${currentGap >= 0 ? "+" : ""}${currentGap.toFixed(0)}` : "gap=??";
              process.stdout.write(`\r[orderflow] HOLDING TO RESOLUTION | bid=${bid?.toFixed(2) ?? "??"} ${gapNow} remaining=${Math.round(remaining / 1000)}s holding=${holdingNow.toFixed(2)}sh`.padEnd(100));

              // Bail out if effective gap shrinks — BTC heading back toward strike against our position
              if (currentEffectiveGap !== null && currentEffectiveGap < BAIL_OUT_GAP) {
                process.stdout.write("\n");
                log(`[orderflow] BAIL OUT — gap shrunk to $${currentGap?.toFixed(0)}, selling now`, "red");
                fullyExited = true;
                countdownActive = false;
                clearInterval(pricePoller);
                sellShares(holdingNow, "bail out gap shrink", () => { inPosition = false; });
                return;
              }

              if (remaining < 10_000) {
                process.stdout.write("\n");
                log(`[orderflow] window closing — holding ${holdingNow.toFixed(2)}sh to resolution`, "green");
                fullyExited = true;
                countdownActive = false;
                clearInterval(pricePoller);
                pendingResolutions.push({
                  side,
                  entryPrice: buyPrice,
                  shares: holdingNow,
                  entryTime,
                  exitReason: "hold resolution",
                  score: entryScore,
                  confidence: entryConfidence,
                  lastBid: bid,
                });
                inPosition = false;
              }
              return;
            }

            // Normal mode: sell at target or time exit
            const line = `[orderflow] bid=${bid?.toFixed(2) ?? "??"} target=${sellTarget.toFixed(2)} remaining=${Math.round(remaining / 1000)}s holding=${holdingNow.toFixed(2)}sh`;
            process.stdout.write(`\r${line.padEnd(90)}`);

            if (!partialSold && bid && bid >= sellTarget) {
              process.stdout.write("\n");
              partialSold = true;
              fullyExited = true;
              countdownActive = false;
              clearInterval(pricePoller);
              log(`[orderflow] TARGET HIT — selling all (${partialShares.toFixed(4)}sh)`, "green");
              sellShares(partialShares, "target hit", () => {
                windowTraded = true;
                inPosition = false;
              });
            } else if (remaining < 60_000) {
              // If token is already at 0.90+ don't panic sell — switch to hold mode
              if (!partialSold && bid && bid >= LATE_HOLD_PRICE) {
                process.stdout.write("\n");
                log(`[orderflow] bid=${bid.toFixed(2)} ≥ ${LATE_HOLD_PRICE} with ${Math.round(remaining / 1000)}s left — holding to resolution`, "green");
                holdToResolution = true;
              } else {
                process.stdout.write("\n");
                doTimeExit();
              }
            }
          }, 2_000);

          timers.push(pricePoller as unknown as NodeJS.Timeout);
        },

        onExpired() {
          log("[orderflow] buy expired — no fill", "yellow");
          inPosition = false;
          consecutiveQualifying = 0;
        },

        onFailed(reason) {
          log(`[orderflow] buy failed (${reason})`, "red");
          inPosition = false;
          consecutiveQualifying = 0;
        },
      },
    ]);
  }

  function trySnipe() {
    if (destroyed || inPosition) return;
    const remaining = ctx.slotEndMs - Date.now();
    if (remaining > SNIPER_WINDOW_MS || remaining < 30_000) return;

    const upBid = ctx.orderBook.bestBidPrice("UP");
    const downBid = ctx.orderBook.bestBidPrice("DOWN");

    let side: "UP" | "DOWN" | null = null;
    if (upBid !== null && upBid >= SNIPER_THRESHOLD) side = "UP";
    else if (downBid !== null && downBid >= SNIPER_THRESHOLD) side = "DOWN";

    if (!side) return;

    const decidedBid = side === "UP" ? upBid! : downBid!;
    const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const askInfo = ctx.orderBook.bestAskInfo(side);

    if (!askInfo || askInfo.liquidity < 1) {
      log(`[sniper] ${side} @ ${decidedBid.toFixed(2)} but no liquidity`, "yellow");
      return;
    }

    // Cap the price we'll pay. Above this the bet is "risk $0.96 to make $0.04" —
    // a single whipsaw wipes out dozens of wins, so skip it entirely.
    if (askInfo.price > SNIPER_MAX_ASK) {
      log(`[sniper] ${side} @ ${decidedBid.toFixed(2)} but ask ${askInfo.price.toFixed(2)} > max ${SNIPER_MAX_ASK}`, "yellow");
      return;
    }

    const buyPrice = askInfo.price;
    inPosition = true;
    log(
      `[sniper] ENTRY — ${side} decided @ ${decidedBid.toFixed(2)} | buying @ ${buyPrice} | ${Math.round(remaining / 1000)}s left`,
      "cyan",
    );

    const entryTime = Date.now();

    ctx.postOrders([{
      req: { tokenId, action: "buy", price: buyPrice, shares: SNIPER_SHARES, orderType: "FOK" },
      expireAtMs: ctx.slotEndMs - 10_000,

      onFilled(filledShares) {
        log(`[sniper] ${side} filled — ${filledShares}sh @ ${buyPrice} | holding to resolution`, "green");

        // Require the drop to persist across reads before bailing. A single
        // sub-threshold tick is almost always a thin-book wick that recovers —
        // bailing on it sells into garbage liquidity (cost us -$3 on a DOWN bet
        // that ultimately won). A real reversal stays down for consecutive reads.
        let bailReads = 0;

        const watchPoller = setInterval(() => {
          if (destroyed) { clearInterval(watchPoller); return; }
          const rem = ctx.slotEndMs - Date.now();
          const currentBid = ctx.orderBook.bestBidPrice(side!);
          process.stdout.write(
            `\r[sniper] HOLDING ${side} | bid=${currentBid?.toFixed(2) ?? "??"} remaining=${Math.round(rem / 1000)}s`.padEnd(80),
          );

          // Count consecutive sub-threshold reads; reset the moment it recovers.
          if (currentBid !== null && currentBid < SNIPER_BAIL) {
            bailReads++;
          } else {
            bailReads = 0;
          }

          // Bail only if the drop held for 2 consecutive reads (~4s) AND there's
          // still time for it to matter. Inside the final 15s a wick can't be
          // distinguished from resolution noise, so hold to the outcome instead.
          if (bailReads >= 2 && currentBid !== null && rem > 15_000) {
            process.stdout.write("\n");
            log(`[sniper] BAIL — held below ${SNIPER_BAIL} for ${bailReads} reads (bid=${currentBid.toFixed(2)}), selling`, "red");
            clearInterval(watchPoller);
            const sellPrice = currentBid ?? 0.01;
            ctx.postOrders([{
              req: { tokenId, action: "sell", price: sellPrice, shares: filledShares, orderType: "FAK" },
              expireAtMs: ctx.slotEndMs,
              onFilled() {
                logTrade({
                  window: String((ctx.slotEndMs - 300_000) / 1000),
                  direction: side!,
                  entryPrice: buyPrice,
                  exitPrice: sellPrice,
                  shares: filledShares,
                  exitReason: "sniper bail",
                  score: 1.0,
                  confidence: 1.0,
                  durationMs: Date.now() - entryTime,
                });
                inPosition = false;
              },
              onFailed() { inPosition = false; },
            }]);
            return;
          }

          // Window closing — hold through resolution. The actual outcome isn't
          // known yet (a last-second reversal resolves at 0.00, not 1.00), so
          // buffer the trade and log it once closePrice arrives.
          if (rem < 10_000) {
            process.stdout.write("\n");
            log(`[sniper] window closing — ${filledShares}sh held to resolution`, "green");
            clearInterval(watchPoller);
            pendingResolutions.push({
              side: side!,
              entryPrice: buyPrice,
              shares: filledShares,
              entryTime,
              exitReason: "sniper resolution",
              score: 1.0,
              confidence: 1.0,
              lastBid: currentBid,
            });
            inPosition = false;
          }
        }, SNIPER_POLL_MS);

        timers.push(watchPoller as unknown as NodeJS.Timeout);
      },

      onExpired() {
        log("[sniper] buy expired — no fill", "yellow");
        inPosition = false;
      },

      onFailed(reason) {
        log(`[sniper] buy failed (${reason})`, "red");
        inPosition = false;
      },
    }]);
  }

  const poll = setInterval(() => {
    if (destroyed) {
      clearInterval(poll);
      return;
    }
    if (Date.now() >= ctx.slotEndMs) {
      clearInterval(poll);
      release();
      return;
    }
    tryTrade();
  }, POLL_INTERVAL_MS);

  timers.push(poll as unknown as NodeJS.Timeout);

  // Sniper poller — runs every 2s, only acts in the last 90 seconds
  const sniperPoll = setInterval(() => {
    if (destroyed) { clearInterval(sniperPoll); return; }
    if (Date.now() >= ctx.slotEndMs) { clearInterval(sniperPoll); return; }
    trySnipe();
  }, SNIPER_POLL_MS);

  timers.push(sniperPoll as unknown as NodeJS.Timeout);

  tryTrade();

  return () => {
    destroyed = true;
    // Resolution data typically arrives just before destroy — flush held trades
    // here with the real outcome, since the 2s poller usually misses that window.
    flushResolutionLogs(true);
    for (const t of timers) clearTimeout(t);
    clearInterval(poll);
    clearInterval(sniperPoll);
    release();
  };
};
