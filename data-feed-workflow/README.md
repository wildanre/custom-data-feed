# Orbita Data Feed Workflow 📈

This module is responsible for fetching asset prices from centralized exchanges (such as MEXC or Binance APIs) and writing those prices to the decentralized **Orbita Oracle Smart Contracts**. It supports two execution strategies:

## 1. The Direct Bypass Method (`simulate.ts`)

This method relies on raw Node.js execution. It uses `viem` to broadcast Ethereum transactions directly to your smart contracts, effectively **bypassing the Chainlink DON and the Keystone Forwarder security layers**.

*   **Why use this?** Because it helps circumvent Chainlink's testnet gas and fee issues (if you do not have sufficient LINK on the DON network) while still proving that your protocol's logic behaves perfectly.
*   **How it works?** It queries the MEXC APIs via native Node `fetch()` and writes directly to the Smart Contract via your `CRE_ETH_PRIVATE_KEY` wallet signature.

**To run the Bypass workflow:**
```bash
bun install
bun run simulate:direct
```
*(This will independently execute `./simulate.ts` using Vite/Bun runner)*

---

## 2. The Native CRE Engine (`main.ts`)

This is the **Official Chainlink CRE** implementation. Once deployed, this `main.ts` file is loaded directly into the Chainlink **Decentralized Oracle Network (DON)**.

*   **Why use this?** Because executing natively through the Chainlink DON ensures that your payloads arrive officially via the **Keystone Forwarder**, leveraging true decentralized consensus and security rules.
*   **How it works?** Instead of native `fetch()`, it uses the specialized `HTTPClient` from `@chainlink/cre-sdk`. The engine processes the workflow securely bounded within its node environments.

### Requirements:
To simulate this via the Chainlink CRE architecture, you first need the `cre` CLI tool installed ([see official documentation](https://cre.chain.link/getting-started)). Also, ensure your `.env` contains valid keys and that `project.yaml` is properly configured.

**To simulate against the official Chainlink CRE Sandbox locally:**
```bash
bun install
cre workflow simulate . --target staging-settings
```
*(You must execute the command from the directory containing `main.ts` (this folder) or specify its path `cre workflow simulate data-feed-workflow`)*

**To deploy onto the official Decentralized Oracles (via Keystone Forwarder):**
```bash
cre workflow deploy . --target production-settings
```

---

## Configurations
You can toggle `USE_REAL_PRICES = true/false` inside both `main.ts` and `simulate.ts` to switch between fetching real-time MEXC prices or writing mock configurations of stablecoins. The polling addresses for Oracle targets are located inside `config.staging.json`.
