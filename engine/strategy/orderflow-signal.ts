import type { Strategy } from "./types.ts";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const SIGNAL_PATH = join(import.meta.dir, "../../../signal.json");
const TRADE_LOG_PATH = join(import.meta.dir, "../../logs/trades.csv");
const TRADE_LOG_HEADER = "timestamp,window,direction,entry_price,exit_price,shares,pnl,exit_reason,score,confidence,duration_s\n";
const SCORE_THRESHOLD = 0.4;
const CONFIDENCE_THRESHOLD = 0.55;
const REPRICE_TARGET = 0.20;
const MAX_BUY_PRICE = 0.65;
const MIN_BUY_PRICE = 0.30;        // skip if crowd is >70% bearish
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
  const bidHistory: number[] = [];

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

    // Block bearish regimes — don't fight a confirmed downtrend or squeeze
    if (signal.regime === "TREND_DOWN" || signal.regime === "LONG_SQUEEZE") {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — bearish regime (${signal.regime})`, "yellow");
      return;
    }

    // Gap check — skip BUY_UP if BTC is too far below the strike price
    const openPrice = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price;
    const gap = openPrice !== null && btcPrice !== undefined ? btcPrice - openPrice : null;
    if (gap !== null && gap < MIN_GAP_USD) {
      consecutiveQualifying = 0;
      log(`[orderflow] skip — BTC $${gap.toFixed(0)} below strike (min ${MIN_GAP_USD})`, "yellow");
      return;
    }

    const { confidenceThreshold, repriceTarget } = thresholdsFromGap(gap);

    const qualifies =
      signal.score > 0 &&
      signal.score >= SCORE_THRESHOLD &&
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

    const side = "UP";
    const tokenId = ctx.clobTokenIds[0];
    const askInfo = ctx.orderBook.bestAskInfo(side);

    if (!askInfo || askInfo.liquidity < 1) {
      log(`[orderflow] no liquidity on ${side}, skipping`, "yellow");
      return;
    }

    const buyPrice = askInfo.price;

    if (buyPrice > MAX_BUY_PRICE) {
      log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} above max ${MAX_BUY_PRICE}`, "yellow");
      return;
    }

    if (buyPrice < MIN_BUY_PRICE) {
      log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} below min ${MIN_BUY_PRICE} (crowd >70% bearish)`, "yellow");
      consecutiveQualifying = 0;
      return;
    }

    // Momentum check: skip if bid has been falling
    const currentBid = ctx.orderBook.bestBidPrice(side);
    if (lastBid !== null && currentBid !== null && currentBid < lastBid - 0.04) {
      log(`[orderflow] skip — bid falling ${lastBid.toFixed(2)} → ${currentBid.toFixed(2)}`, "yellow");
      lastBid = currentBid;
      consecutiveQualifying = 0;
      return;
    }
    lastBid = currentBid ?? lastBid;

    // Book volatility check: skip if bid has been swinging wildly across recent polls
    if (currentBid !== null) {
      bidHistory.push(currentBid);
      if (bidHistory.length > BID_HISTORY_SIZE) bidHistory.shift();
    }
    if (bidHistory.length >= BID_HISTORY_SIZE) {
      const swing = Math.max(...bidHistory) - Math.min(...bidHistory);
      if (swing > MAX_BID_SWING) {
        log(`[orderflow] skip — book unstable, swing=${swing.toFixed(3)} > max=${MAX_BID_SWING}`, "yellow");
        return;
      }
    }

    const sellTarget = Math.min(buyPrice + repriceTarget, 0.95);
    const shares = sharesFromConfidenceAndGap(signal.confidence, gap);

    let holdToResolution = gap !== null && gap >= HOLD_GAP_THRESHOLD;
    const gapStr = gap !== null ? ` | gap=${gap >= 0 ? "+" : ""}${gap.toFixed(0)}` : "";
    const modeStr = holdToResolution ? " | HOLD TO RESOLUTION" : ` → ${sellTarget.toFixed(2)}`;
    log(
      `[orderflow] ENTRY — ${signal.label} | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} | UP @ ${buyPrice}${modeStr} | shares=${shares}${gapStr}`,
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
          countdownActive = true;

          function sellShares(shares: number, reason: string, onDone?: () => void) {
            const pendingSells = ctx.pendingOrders.filter((o) => o.action === "sell");
            if (pendingSells.length > 0) {
              log(`[orderflow] sell already in flight (${reason}), skipping`, "yellow");
              onDone?.();
              return;
            }
            const bid = ctx.orderBook.bestBidPrice(side);
            const sellPrice = (bid && bid > 0) ? bid : 0.01;
            log(`[orderflow] ${reason} — FAK sell ${shares.toFixed(4)}sh @ ${sellPrice}`, "cyan");
            ctx.postOrders([{
              req: { tokenId, action: "sell", price: sellPrice, shares, orderType: "FAK" },
              expireAtMs: ctx.slotEndMs,
              onFilled() {
                log(`[orderflow] SELL filled @ ${sellPrice} (${reason})`, "green");
                logTrade({
                  window: windowId,
                  direction: "UP",
                  entryPrice: buyPrice,
                  exitPrice: sellPrice,
                  shares,
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

            if (holdToResolution) {
              // Recompute current gap every tick to watch for gap shrinkage
              const currentBtc = ctx.ticker.price;
              const currentGap = openPrice !== null && currentBtc !== undefined
                ? currentBtc - openPrice : null;
              const gapNow = currentGap !== null ? `gap=${currentGap >= 0 ? "+" : ""}${currentGap.toFixed(0)}` : "gap=??";
              process.stdout.write(`\r[orderflow] HOLDING TO RESOLUTION | bid=${bid?.toFixed(2) ?? "??"} ${gapNow} remaining=${Math.round(remaining / 1000)}s holding=${holdingNow.toFixed(2)}sh`.padEnd(100));

              // Bail out if gap shrinks below safety threshold — BTC heading back to strike
              if (currentGap !== null && currentGap < BAIL_OUT_GAP) {
                process.stdout.write("\n");
                log(`[orderflow] BAIL OUT — gap shrunk to $${currentGap.toFixed(0)}, selling now`, "red");
                fullyExited = true;
                countdownActive = false;
                clearInterval(pricePoller);
                sellShares(filledShares, "bail out gap shrink", () => { inPosition = false; });
                return;
              }

              // Window closing — release lock and let resolution handle payout
              if (remaining < 10_000) {
                process.stdout.write("\n");
                log(`[orderflow] window closing — holding ${holdingNow.toFixed(2)}sh to resolution`, "green");
                fullyExited = true;
                countdownActive = false;
                clearInterval(pricePoller);
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
              log(`[orderflow] TARGET HIT — selling all (${partialShares.toFixed(4)}sh)`, "green");
              sellShares(partialShares, "target hit", () => {
                countdownActive = false;
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

  tryTrade();

  return () => {
    destroyed = true;
    for (const t of timers) clearTimeout(t);
    clearInterval(poll);
    release();
  };
};
