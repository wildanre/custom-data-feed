/**
 * Orbita CRE Liquidation Workflow
 *
 * Cron-triggered workflow that:
 * 1. Fetches active borrowers from the Orbita indexer (orbita.senja.finance)
 * 2. Checks each borrower's health via IsHealthy.checkLiquidatable()
 * 3. If undercollateralized, approves borrow token and calls liquidation()
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
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  maxUint256,
  zeroAddress,
} from "viem";
import { z } from "zod";
import { ERC20_ABI, HELPER_ABI, LENDING_POOL_ABI } from "../contracts/helperAbi.js";
// HELPER_ABI provides: isLiquidatable(user, lendingPool) → [bool, uint256, uint256, uint256]

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const poolSchema = z.object({
  lendingPool: z.string(), // LendingPool proxy address (entry point for liquidation)
  router: z.string(),      // LendingPoolRouter address (used in checkLiquidatable)
  borrowToken: z.string(), // Borrow token address (e.g. USDC)
});

const configSchema = z.object({
  schedule: z.string().default("*/30 * * * * *"),
  chainSelectorName: z.string().default("ethereum-testnet-sepolia-worldchain-1"),
  helperAddress: z.string(),   // Helper contract address
  indexerUrl: z.string(),        // e.g. "https://orbita.senja.finance/graphql"
  enableLiquidation: z.boolean().default(false),
  pools: z.array(poolSchema),
});

type Config = z.infer<typeof configSchema>;

// ---------------------------------------------------------------------------
// Fetch borrowers from Orbita indexer (Ponder GraphQL)
// ---------------------------------------------------------------------------

async function fetchBorrowersFromIndexer(
  indexerUrl: string,
  lendingPool: string,
): Promise<string[]> {
  const query = `{
    borrows(
      where: { lendingPool: "${lendingPool.toLowerCase()}" }
      limit: 200
    ) {
      items {
        borrower
      }
    }
  }`;

  try {
    const resp = await fetch(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      return [];
    }

    const json = (await resp.json()) as {
      data?: { borrows?: { items?: { borrower: string }[] } };
    };
    return (json?.data?.borrows?.items ?? []).map((item) => item.borrower);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// On-chain: check if borrower is liquidatable via Helper.isLiquidatable()
// Returns [liquidatable, borrowValue, collateralValue, liquidationBonus]
// ---------------------------------------------------------------------------

function checkLiquidatable(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  borrower: string,
  lendingPool: string,
  helperAddress: string,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: HELPER_ABI,
      functionName: "isLiquidatable",
      args: [borrower as Address, lendingPool as Address],
    });

    const result = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: helperAddress as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const [isLiquidatable, borrowValue, collateralValue] =
      decodeFunctionResult({
        abi: HELPER_ABI,
        functionName: "isLiquidatable",
        data: bytesToHex(result.data),
      }) as [boolean, bigint, bigint, bigint];

    runtime.log(
      `[HEALTH] ${borrower}: liquidatable=${isLiquidatable} borrow=${borrowValue} collateral=${collateralValue}`,
    );
    return isLiquidatable;
  } catch (err) {
    runtime.log(`[ERROR] isLiquidatable(${borrower}): ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// On-chain: approve borrow token for lendingPool
// ---------------------------------------------------------------------------

function approveToken(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  tokenAddress: string,
  spender: string,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as Address, maxUint256],
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
        receiver: tokenAddress as Address,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(`[ERROR] approve failed - tx=${resp.txHash}`);
      return false;
    }

    runtime.log(`[APPROVE] ${tokenAddress} -> spender=${spender} tx=${resp.txHash}`);
    return true;
  } catch (err) {
    runtime.log(`[ERROR] approve: ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// On-chain: execute liquidation
// ---------------------------------------------------------------------------

function executeLiquidation(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  borrower: string,
  lendingPool: string,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: LENDING_POOL_ABI,
      functionName: "liquidation",
      args: [borrower as Address],
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
        receiver: lendingPool as Address,
        report,
      })
      .result();

    if (resp.txStatus !== TxStatus.SUCCESS) {
      runtime.log(`[ERROR] liquidation(${borrower}) failed - tx=${resp.txHash}`);
      return false;
    }

    runtime.log(`[LIQUIDATED] borrower=${borrower} pool=${lendingPool} tx=${resp.txHash}`);
    return true;
  } catch (err) {
    runtime.log(`[ERROR] liquidation(${borrower}): ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main cron callback
// ---------------------------------------------------------------------------

const onCronTrigger = async (runtime: Runtime<Config>): Promise<string> => {
  const config = runtime.config;
  const ts = new Date().toISOString();

  runtime.log(`[${ts}] === Liquidation cycle start ===`);

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

  // Track approved pools to avoid re-approving each borrower
  const approvedPools = new Set<string>();

  let totalChecked = 0;
  let totalLiquidated = 0;

  for (const pool of config.pools) {
    runtime.log(`[POOL] lendingPool=${pool.lendingPool} router=${pool.router}`);

    // Fetch borrowers from the Orbita indexer
    const borrowers = await fetchBorrowersFromIndexer(
      config.indexerUrl,
      pool.lendingPool,
    );

    runtime.log(`[POOL] ${borrowers.length} borrowers found`);

    for (const borrower of borrowers) {
      totalChecked++;

      // Check health on-chain via Helper.isLiquidatable(user, lendingPool)
      const isLiquidatable = checkLiquidatable(
        runtime,
        evmClient,
        borrower,
        pool.lendingPool,
        config.helperAddress,
      );

      if (!isLiquidatable) {
        runtime.log(`[OK] ${borrower}: healthy`);
        continue;
      }

      runtime.log(`[LIQUIDATABLE] ${borrower}`);

      if (!config.enableLiquidation) {
        runtime.log(`[SKIP] enableLiquidation=false, not executing`);
        continue;
      }

      // Approve borrow token once per pool per cycle
      if (!approvedPools.has(pool.lendingPool)) {
        const ok = approveToken(
          runtime,
          evmClient,
          pool.borrowToken,
          pool.lendingPool,
        );
        if (!ok) {
          runtime.log(`[ERROR] approve failed for pool ${pool.lendingPool}, skipping pool`);
          break;
        }
        approvedPools.add(pool.lendingPool);
      }

      // Execute liquidation
      const success = executeLiquidation(
        runtime,
        evmClient,
        borrower,
        pool.lendingPool,
      );
      if (success) totalLiquidated++;
    }
  }

  runtime.log(
    `[DONE] checked=${totalChecked} liquidated=${totalLiquidated} ts=${ts}`,
  );
  return "complete";
};

// ---------------------------------------------------------------------------
// Workflow initializer
// ---------------------------------------------------------------------------

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger as any)];
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
