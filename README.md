# Orbita Custom Data Feed & Liquidation Keeper 🤖

This project contains the Chainlink CRE (Custom Runtime Environment) Workflows powering the Orbita decentralized lending protocol on the Worldchain Sepolia testnet. It handles real-world Oracle Price Discovery and autonomous position Liquidations.

## Repository Structure

The project is split into two primary Chainlink CRE workflows:

1. **`data-feed-workflow/`**: Responsible for polling off-chain API prices (such as MEXC/Binance API) and pushing updates to the on-chain Oracle smart contracts. 
2. **`liquidate-workflow/`**: Responsible for scanning the Orbita Lending Pools, verifying borrower Health Factors (`isLiquidatable`), and executing smart contract Liquidations.

## 🏗️ Protocol Architecture & Flow

### 1. Data Feed Workflow Flowchart
This workflow runs every minute to ensure the Lending Protocol's Oracles are always up-to-date with real-world Exchange values.

```text
[Cron Trigger] (Every 1 Minute)
      │
      ▼
[1. Fetch Active Oracle Targets] ──────► Reads `config.staging.json`
      │
      ▼
[2. Query Off-Chain APIs]
      ├─► MEXC API (Volatile Assets like WETH, WBTC)
      └─► Mock Constants (Stablecoins like USDT)
      │
      ▼
[3. Validate Price & Staleness]
      ├─► If Stale or price deviates > threshold
      │     └─► Proceed to Update
      └─► If Healthy
            └─► Skip Update
      │
      ▼
[4. Dispatch Transaction] ─────────────► Encodes `setPrice()` payload
      │
      ▼
[5. Chainlink Keystone Forwarder] ─────► Submits securely via DON
      │
      ▼
[Smart Contract Oracles Updated]
```

### 2. Liquidation Workflow Flowchart
This workflow runs continuously to guarantee protocol solvency, stepping in whenever a borrower's collateral value drops below the required threshold to maintain their debt.

```text
[Cron Trigger] (Every 1 Minute)
      │
      ▼
[1. Fetch Active Borrowers] ───────────► Sends GraphQL POST to Orbita Indexer (Ponder)
      │
      ▼
[2. Evaluate Borrower Health] ─────────► Queries `Helper.isLiquidatable(user, pool)`
      │
      ▼
[3. Decision Matrix]
      ├─► If Health < 1.0
      │     └─► Proceed to Liquidation
      └─► If Health >= 1.0
            └─► Skip user
      │
      ▼
[4. Approve Borrow Tokens] ────────────► Liquidator approves ERC20 spending to Pool
      │                                  (Only once per pool)
      ▼
[5. Execute Liquidation] ──────────────► Encodes `liquidation(user)` payload
      │
      ▼
[6. Chainlink Keystone Forwarder] ─────► Submits securely via DON
      │
      ▼
[Borrower Liquidated On-Chain]
```

## 🛠️ Two Ways to Execute Workflows

In this repository, each workflow directory contains **two distinct execution scripts**: `main.ts` and `simulate.ts`. It is important to understand the difference between them.

### 1. `simulate.ts` (Direct Bypass)
This script bypasses the Chainlink Decentralized Oracle Network (DON) entirely. It runs a raw Node.js script that uses `viem` to directly write to the blockchain.
- **Pros:** Fast, avoids Chainlink DON Gas/Fee constraints, great for rapid Hackathon demonstrations.
- **Cons:** Bypasses the Keystone Forwarder security model. Not truly decentralized.
- **How to run:**
  ```bash
  bun run simulate:direct
  ```

### 2. `main.ts` (Native CRE Engine)
This is the **official** Chainlink CRE standard. It uses `@chainlink/cre-sdk` capabilities (like `HTTPClient` instead of `fetch`) so it can be deployed to the Chainlink Decentralized Oracle Network (DON). Transactions from this method are routed through the **Keystone Forwarder**.
- **Pros:** Route traffic securely through Keystone, utilizing true decentralization and consensus rules.
- **Cons:** Constrained by CRE execution limits (e.g. max 15 contract reads per workflow) and requires registered DON nodes.
- **How to run:**
  ```bash
  cre workflow simulate ./workflow-name
  ```

---

## 🚀 Quick Start (Root Directory)

If you just want to run the full end-to-end Orbita simulation locally (Data Feeds + Liquidations) using the **Direct Bypass** method, follow these steps:

### 1. Requirements
- Install [Bun](https://bun.sh/)
- Add your Ethereum Private Key into a `.env` file at the root:
  ```env
  CRE_ETH_PRIVATE_KEY=0x...
  ```

### 2. Install Dependencies
```bash
cd data-feed-workflow && bun install
cd ../liquidate-workflow && bun install
```

### 3. Run the E2E Script
```bash
chmod +x run-local.sh
./run-local.sh
```

---

## 📚 Detailed Documentation
To learn how to run each workflow natively using the official Chainlink CRE CLI (`cre workflow simulate`), see the individual READMEs:
- [Data Feed Workflow README](./data-feed-workflow/README.md)
- [Liquidation Workflow README](./liquidate-workflow/README.md)
