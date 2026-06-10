import type { Strategy } from "./types.ts";
import { readFileSync } from "fs";
import { join } from "path";

const SIGNAL_PATH = join(import.meta.dir, "../../../signal.json");
const SCORE_THRESHOLD = 0.4;
const CONFIDENCE_THRESHOLD = 0.55; // raised from 0.4 — filters weak signals
const REPRICE_TARGET = 0.20;
const MAX_BUY_PRICE = 0.70;        // don't chase high-priced tokens
const STOP_LOSS_DELTA = 0.15;      // exit if bid drops this far below buy price
const SIGNAL_MAX_AGE_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;
const MIN_REMAINING_MS = 90_000;

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
  let lastBid: number | null = null; // for momentum check

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

    const sellTarget = Math.min(buyPrice + REPRICE_TARGET, 0.95);
    const stopLoss = buyPrice - STOP_LOSS_DELTA;

    log(
      `[orderflow] ENTRY — ${signal.label} | score=${signal.score.toFixed(2)} conf=${signal.confidence.toFixed(2)} | ${side} @ ${buyPrice} → ${sellTarget.toFixed(2)} (stop ${stopLoss.toFixed(2)})`,
      "cyan",
    );

    inPosition = true;

    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "buy",
          price: buyPrice,
          shares: 5,
          orderType: "FOK",
        },
        expireAtMs: ctx.slotEndMs - MIN_REMAINING_MS,

        onFilled(filledShares) {
          log(`[orderflow] BUY filled — ${filledShares} shares @ ${buyPrice} | target=${sellTarget.toFixed(2)} stop=${stopLoss.toFixed(2)}`, "green");

          let exited = false;
          countdownActive = true;

          function doExit(reason: string) {
            if (exited || destroyed) return;
            exited = true;
            countdownActive = false;
            clearInterval(pricePoller);
            // only allow re-entry if we hit target; stop-loss/time means market is against us
            if (reason !== "target hit") inPosition = true;

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

          // Poll bid every 5s
          const pricePoller = setInterval(() => {
            if (exited || destroyed) { clearInterval(pricePoller); return; }
            const remaining = ctx.slotEndMs - Date.now();
            const bid = ctx.orderBook.bestBidPrice(side);
            const line = `[orderflow] bid=${bid?.toFixed(2) ?? "??"} target=${sellTarget.toFixed(2)} stop=${stopLoss.toFixed(2)} remaining=${Math.round(remaining / 1000)}s`;
            process.stdout.write(`\r${line.padEnd(80)}`);
            if (bid && bid >= sellTarget) {
              process.stdout.write("\n");
              doExit("target hit");
            } else if (!bid || bid <= stopLoss) {
              process.stdout.write("\n");
              doExit("stop-loss");
            } else if (remaining < 60_000) {
              process.stdout.write("\n");
              doExit("time limit");
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
