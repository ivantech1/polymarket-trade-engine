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

  function sharesFromConfidence(confidence: number): number {
    if (confidence >= 0.85) return 10;
    if (confidence >= 0.75) return 7;
    if (confidence >= 0.65) return 5;
    return 3;
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

    const qualifies =
      signal.score > 0 &&                          // long-only
      signal.score >= SCORE_THRESHOLD &&
      signal.confidence >= CONFIDENCE_THRESHOLD;

    if (!qualifies) {
      consecutiveQualifying = 0;
      log(
        `[orderflow] skip — score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)}`,
        "yellow",
      );
      return;
    }

    consecutiveQualifying++;
    if (consecutiveQualifying < REQUIRED_CONSECUTIVE) {
      log(
        `[orderflow] signal ${consecutiveQualifying}/${REQUIRED_CONSECUTIVE} — waiting for confirmation | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)}`,
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

    const sellTarget = Math.min(buyPrice + REPRICE_TARGET, 0.95);
    const shares = sharesFromConfidence(signal.confidence);

    log(
      `[orderflow] ENTRY — ${signal.label} | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} | UP @ ${buyPrice} → ${sellTarget.toFixed(2)} | shares=${shares}`,
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
          log(`[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | target=${sellTarget.toFixed(2)}`, "green");

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
              process.stdout.write("\n");
              doTimeExit();
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
