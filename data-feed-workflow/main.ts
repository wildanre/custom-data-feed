/**
 * Orbita CRE Price Feed Workflow
 *
 * Cron-triggered workflow that:
 * 1. Reads latestRoundData() from each oracle contract on World Chain Sepolia
 * 2. Checks for stale prices and deviation against last known values
 * 3. If update needed, calls setPrice() on each oracle contract
 */

import {
  bytesToHex,
  CronCapability,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  HTTPClient,
  type Runtime,
  type NodeRuntime,
} from "@chainlink/cre-sdk";
import { type Address, decodeFunctionResult, encodeFunctionData } from "viem";
import { z } from "zod";
import {
  AGGREGATOR_V3_ABI,
  ORACLE_ABI,
  PRICE_CONSUMER_ABI,
} from "../contracts/abi.js";

// ---------------------------------------------------------------------------
// Mock Price Configurations & MEXC API
// ---------------------------------------------------------------------------

// Toggle this to false to use static fallback mocks instead of real API
const USE_REAL_PRICES = true;

const MOCK_BASE_PRICE = 100000000n; // $1.00
const MOCK_WETH_PRICE = 200000000000n; // $1900.00
const MOCK_WBTC_PRICE = 7000000000000n; // $60000.00

// Map Oracle names to MEXC symbols
const MEXC_SYMBOL_MAP: Record<string, string> = {
  "WETH/USD": "ETHUSDT",
  "WBTC/USD": "BTCUSDT",
};

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------
const oracleSchema = z.object({
  name: z.string(),
  address: z.string(),
  feedId: z.string(),
});

const configSchema = z.object({
  schedule: z.string().default("*/30 * * * * *"),
  chainSelectorName: z
    .string()
    .default("ethereum-testnet-sepolia-worldchain-1"),
  priceConsumerAddress: z.string().default(""),
  stalenessThresholdSeconds: z.number().default(3600),
  deviationThresholdBps: z.number().default(100), // 1% = 100 bps
  enableWrite: z.boolean().default(false), // set true to actually call setPrice()
  oracles: z.array(oracleSchema),
});

type Config = z.infer<typeof configSchema>;
type Oracle = z.infer<typeof oracleSchema>;

// ---------------------------------------------------------------------------
// In-memory state: track last submitted prices for deviation check
// ---------------------------------------------------------------------------
const lastKnownPrices = new Map<
  string,
  { answer: bigint; updatedAt: bigint }
>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(answer: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = answer / divisor;
  const frac = (answer % divisor).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

function isStale(updatedAt: bigint, thresholdSeconds: number): boolean {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  return nowSeconds - updatedAt > BigInt(thresholdSeconds);
}

function hasDeviation(
  newAnswer: bigint,
  oldAnswer: bigint,
  thresholdBps: number,
): boolean {
  if (oldAnswer === 0n) return true;
  const diff =
    newAnswer > oldAnswer ? newAnswer - oldAnswer : oldAnswer - newAnswer;
  const deviationBps = (diff * 10000n) / oldAnswer;
  return deviationBps >= BigInt(thresholdBps);
}

// ---------------------------------------------------------------------------
function fetchPriceTask(
  oracleName: string,
  runtime: Runtime<Config>,
): bigint | null {
  // If it's a stablecoin or native testnet token, force $1.00 mock
  if (oracleName === "USDT/USD" || oracleName === "NATIVE/USD") {
    runtime.log(
      `[Price Source] Using hardcoded $1.00 for stablecoin/native mock`,
    );
    return MOCK_BASE_PRICE;
  }

  // Use MEXC for volatile assets if enabled
  if (USE_REAL_PRICES) {
    const symbol = MEXC_SYMBOL_MAP[oracleName];
    if (symbol) {
      try {
        const client = new HTTPClient();
        const requestUrl = `https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`;

        // Use CRE HttpCapability to bypass Node Native Fetch restriction
        const responseFn = client.sendRequest(
          runtime as unknown as NodeRuntime<Config>,
          {
            url: requestUrl,
            method: "GET",
            headers: {},
          },
        );

        const response = responseFn.result();

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`HTTP Error ${response.statusCode}`);
        }

        const rawBody = Buffer.from(response.body).toString("utf-8");
        const resJson = JSON.parse(rawBody) as any;

        if (resJson && resJson.price) {
          runtime.log(`[Price Source] MEXC API: ${symbol} = $${resJson.price}`);
          return BigInt(Math.floor(parseFloat(resJson.price) * 1e8));
        }

        throw new Error("Invalid price payload");
      } catch (err) {
        runtime.log(
          `[WARN] MEXC API Failed for ${symbol}: ${String(err)}. Falling back to mock.`,
        );
        return null;
      }
    }
  }

  // Fallback Mocks
  runtime.log(`[Price Source] Mocked locally`);
  if (oracleName.includes("WETH")) return MOCK_WETH_PRICE;
  if (oracleName.includes("WBTC")) return MOCK_WBTC_PRICE;

  return MOCK_BASE_PRICE;
}

// ---------------------------------------------------------------------------
// Read stored price from Oracle or external
// ---------------------------------------------------------------------------

async function readOraclePriceDirect(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  oracle: Oracle,
): Promise<{
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: number;
} | null> {
  if (!oracle.address || oracle.address === `0x${"0".repeat(40)}`) {
    runtime.log(`[SKIP] ${oracle.name}: address not configured`);
    return null;
  }

  try {
    const roundCallData = encodeFunctionData({
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    });

    const roundResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: "0x0000000000000000000000000000000000000000" as Address,
          to: oracle.address as Address,
          data: roundCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    let [roundId, answer, startedAt, updatedAt, answeredInRound] =
      decodeFunctionResult({
        abi: AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
        data: bytesToHex(roundResult.data),
      }) as [bigint, bigint, bigint, bigint, bigint];

    const decimalsCallData = encodeFunctionData({
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
    });

    const decimalsResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: "0x0000000000000000000000000000000000000000" as Address,
          to: oracle.address as Address,
          data: decimalsCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const decimals = decodeFunctionResult({
      abi: AGGREGATOR_V3_ABI,
      functionName: "decimals",
      data: bytesToHex(decimalsResult.data),
    }) as number;

    // OVERRIDE on-chain answer with Mock/Live Data
    const liveAnswer = fetchPriceTask(oracle.name, runtime);
    if (liveAnswer !== null) {
      answer = liveAnswer;
    }

    return { roundId, answer, startedAt, updatedAt, answeredInRound, decimals };
  } catch (err) {
    runtime.log(`[ERROR] ${oracle.name}: read failed - ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write: call setPrice(price, timestamp) on oracle contract
// ---------------------------------------------------------------------------

function updateOraclePrice(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  oracle: Oracle,
  newPrice: bigint,
  timestamp: bigint,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: ORACLE_ABI,
      functionName: "setPrice",
      args: [newPrice],
    });

    const report = runtime
      .report({
        encodedPayload: hexToBase64(callData),
        encoderName: "evm",
        signingAlgo: "ecdsa",
        hashingAlgo: "keccak256",
      })
      .result();

    const resp = evmClient
      .writeReport(runtime, {
        receiver: oracle.address as Address,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(
        `[ERROR] ${oracle.name}: setPrice tx failed - hash=${resp.txHash}`,
      );
      return false;
    }

    runtime.log(
      `[WRITE] ${oracle.name}: setPrice(${newPrice}, ${timestamp}) ok - tx=${resp.txHash}`,
    );
    return true;
  } catch (err: any) {
    runtime.log(`[ERROR] ${oracle.name}: setPrice failed - ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read stored price from OrbitaPriceConsumer
// ---------------------------------------------------------------------------

function readStoredPrice(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  feedId: string,
  priceConsumerAddress: string,
): { price: bigint; timestamp: number } | null {
  if (!priceConsumerAddress) return null;

  try {
    const tsCallData = encodeFunctionData({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestTimestamp",
      args: [feedId as `0x${string}`],
    });

    const tsResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: "0x0000000000000000000000000000000000000000" as Address,
          to: priceConsumerAddress as Address,
          data: tsCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const timestamp = decodeFunctionResult({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestTimestamp",
      data: bytesToHex(tsResult.data),
    }) as number;

    const priceCallData = encodeFunctionData({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestPrice",
      args: [feedId as `0x${string}`],
    });

    const priceResult = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: "0x0000000000000000000000000000000000000000" as Address,
          to: priceConsumerAddress as Address,
          data: priceCallData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const price = decodeFunctionResult({
      abi: PRICE_CONSUMER_ABI,
      functionName: "latestPrice",
      data: bytesToHex(priceResult.data),
    }) as bigint;

    return { price, timestamp };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main cron callback
// ---------------------------------------------------------------------------

const onCronTrigger = async (runtime: Runtime<Config>): Promise<string> => {
  const config = runtime.config;
  const ts = new Date().toISOString();

  runtime.log(`[${ts}] === Orbita CRE PriceFeed cycle start ===`);

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    runtime.log(`[ERROR] Network not found: ${config.chainSelectorName}`);
    return "error";
  }

  const evmClient = new EVMClient(network.chainSelector.selector);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  let updated = 0;
  let skipped = 0;

  for (const oracle of config.oracles) {
    runtime.log(`[READ] ${oracle.name} @ ${oracle.address}`);

    const data = await readOraclePriceDirect(runtime, evmClient, oracle);

    if (!data) {
      skipped++;
      continue;
    }

    const formatted = formatPrice(data.answer, data.decimals);
    const stale = isStale(data.updatedAt, config.stalenessThresholdSeconds);
    const updatedAtDate = new Date(Number(data.updatedAt) * 1000).toISOString();

    runtime.log(
      `[PRICE] ${oracle.name}: $${formatted} | ` +
        `decimals=${data.decimals} | updatedAt=${updatedAtDate} | stale=${stale}`,
    );

    // Deviation check
    const last = lastKnownPrices.get(oracle.name);
    const deviated = last
      ? hasDeviation(data.answer, last.answer, config.deviationThresholdBps)
      : true;

    if (stale)
      runtime.log(
        `[STALE] ${oracle.name}: >${config.stalenessThresholdSeconds}s old`,
      );
    if (deviated && last) {
      const bps =
        ((data.answer > last.answer
          ? data.answer - last.answer
          : last.answer - data.answer) *
          10000n) /
        last.answer;
      runtime.log(`[DEVIATION] ${oracle.name}: ${Number(bps) / 100}% change`);
    }

    // Read OrbitaPriceConsumer stored state
    if (config.priceConsumerAddress && oracle.feedId) {
      const stored = readStoredPrice(
        runtime,
        evmClient,
        oracle.feedId,
        config.priceConsumerAddress,
      );
      if (stored) {
        runtime.log(
          `[CONSUMER] ${oracle.name}: stored price=${stored.price} ts=${stored.timestamp}`,
        );
      }
    }

    const needsUpdate = stale || deviated;

    // Write: update oracle with setPrice()
    if (needsUpdate && config.enableWrite) {
      runtime.log(`[WRITE] ${oracle.name}: calling setPrice...`);
      const ok = updateOraclePrice(
        runtime,
        evmClient,
        oracle,
        data.answer,
        nowSeconds,
      );
      if (ok) {
        updated++;
        lastKnownPrices.set(oracle.name, {
          answer: data.answer,
          updatedAt: nowSeconds,
        });
      }
    } else if (needsUpdate) {
      runtime.log(
        `[SKIP-WRITE] ${oracle.name}: needs update but enableWrite=false`,
      );
      lastKnownPrices.set(oracle.name, {
        answer: data.answer,
        updatedAt: data.updatedAt,
      });
      skipped++;
    } else {
      runtime.log(`[OK] ${oracle.name}: no update needed`);
      lastKnownPrices.set(oracle.name, {
        answer: data.answer,
        updatedAt: data.updatedAt,
      });
    }
  }

  runtime.log(`[DONE] updated=${updated} skipped=${skipped} ts=${ts}`);
  return "complete";
};

// ---------------------------------------------------------------------------
// Workflow initializer
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema: configSchema as any,
  });
  await runner.run(initWorkflow);
}
