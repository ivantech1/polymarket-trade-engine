import type { Strategy } from "./types.ts";
import { readFileSync } from "fs";
import { join } from "path";

const SIGNAL_PATH = join(import.meta.dir, "../../../signal.json");
const SCORE_THRESHOLD = 0.4;
const CONFIDENCE_THRESHOLD = 0.55;
const MAX_BUY_PRICE = 0.70;        // don't chase high-priced tokens
const STOP_LOSS_DELTA = 0.15;      // exit if bid drops this far below buy price
const SIGNAL_MAX_AGE_MS = 60_000;
const POLL_INTERVAL_MS = 10_000;
const MIN_REMAINING_MS = 90_000;
const MAX_BID_SWING = 0.08;        // skip if book swung this much across last 4 polls
const BID_HISTORY_SIZE = 4;

type Signal = {
  action: "BUY_UP" | "BUY_DOWN" | "NO_TRADE";
  score: number;
  confidence: number;
  label: string;
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

export const orderflowSignalStrategy: Strategy = async (ctx) => {
  const timers: NodeJS.Timeout[] = [];
  let inPosition = false;
  let destroyed = false;
  let countdownActive = false;
  let lastBid: number | null = null;
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
      log("[orderflow] no valid signal", "yellow");
      return;
    }

    if (Math.abs(signal.score) < SCORE_THRESHOLD ||
        signal.confidence < CONFIDENCE_THRESHOLD) {
      log(
        `[orderflow] skip — score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)}`,
        "yellow",
      );
      return;
    }

    const side = signal.score > 0 ? "UP" : "DOWN";
    const tokenId = side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
    const askInfo = ctx.orderBook.bestAskInfo(side);

    if (!askInfo || askInfo.liquidity < 1) {
      log(`[orderflow] no liquidity on ${side}, skipping`, "yellow");
      return;
    }

    const buyPrice = askInfo.price;

    // Don't chase expensive tokens
    if (buyPrice > MAX_BUY_PRICE) {
      log(`[orderflow] skip — ask ${buyPrice.toFixed(2)} above max ${MAX_BUY_PRICE}`, "yellow");
      return;
    }

    // Momentum check: skip if bid has been falling (market moving against signal)
    const currentBid = ctx.orderBook.bestBidPrice(side);
    if (lastBid !== null && currentBid !== null && currentBid < lastBid - 0.04) {
      log(`[orderflow] skip — bid falling ${lastBid.toFixed(2)} → ${currentBid.toFixed(2)}`, "yellow");
      lastBid = currentBid;
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

    const stopLoss = buyPrice - STOP_LOSS_DELTA;
    const shares = sharesFromConfidence(signal.confidence);

    log(
      `[orderflow] ENTRY — ${signal.label} | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} | ${side} @ ${buyPrice} | stop=${stopLoss.toFixed(2)} | shares=${shares}`,
      "cyan",
    );

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
          log(`[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | stop=${stopLoss.toFixed(2)} | holding to resolution`, "green");

          let exited = false;
          countdownActive = true;

          function doExit(reason: string) {
            if (exited || destroyed) return;
            exited = true;
            countdownActive = false;
            clearInterval(pricePoller);
            // after stop-loss or time limit, block re-entry — market is against us
            inPosition = true;

            const pendingSellIds = ctx.pendingOrders
              .filter((o) => o.action === "sell")
              .map((o) => o.orderId);

            if (pendingSellIds.length > 0) {
              log(`[orderflow] exit via ${reason} — emergency sell`, "red");
              ctx.emergencySells(pendingSellIds);
            } else {
              const bid = ctx.orderBook.bestBidPrice(side);
              const sellPrice = (bid && bid > 0) ? bid : 0.01;
              if (filledShares > 0) {
                log(`[orderflow] exit via ${reason} — FAK sell @ ${sellPrice}`, "cyan");
                ctx.postOrders([{
                  req: { tokenId, action: "sell", price: sellPrice, shares: filledShares, orderType: "FAK" },
                  expireAtMs: ctx.slotEndMs,
                  onFilled() { log(`[orderflow] SELL filled @ ${sellPrice} — trade complete`, "green"); },
                  onFailed(r) { log(`[orderflow] sell failed (${r})`, "red"); },
                }]);
              }
            }
            inPosition = false;
          }

          // Poll bid every 2s — only exit on stop-loss or time safety valve
          const pricePoller = setInterval(() => {
            if (exited || destroyed) { clearInterval(pricePoller); return; }
            const remaining = ctx.slotEndMs - Date.now();
            const bid = ctx.orderBook.bestBidPrice(side);
            const line = `[orderflow] holding — bid=${bid?.toFixed(2) ?? "??"} stop=${stopLoss.toFixed(2)} remaining=${Math.round(remaining / 1000)}s`;
            process.stdout.write(`\r${line.padEnd(80)}`);
            if (!bid || bid <= stopLoss) {
              process.stdout.write("\n");
              doExit("stop-loss");
            } else if (remaining < 20_000) {
              // Safety valve: if still in position at 20s, let resolution handle it
              process.stdout.write("\n");
              log(`[orderflow] <20s remaining — releasing to resolution`, "dim");
              clearInterval(pricePoller);
              countdownActive = false;
            }
          }, 2_000);

          timers.push(pricePoller as unknown as NodeJS.Timeout);
        },

        onExpired() {
          log("[orderflow] buy expired — no fill", "yellow");
          inPosition = false;
        },

        onFailed(reason) {
          log(`[orderflow] buy failed (${reason})`, "red");
          inPosition = false;
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
