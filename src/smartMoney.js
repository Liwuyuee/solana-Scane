/**
 * Smart Money Wallet Tracker
 *
 * Monitors known profitable wallets for new Pump.fun token buys.
 * When a tracked wallet buys a new token, emits an alert.
 * Cross-references with the main monitor's seen set to avoid duplicates.
 */

const RPC_URL = "https://api.mainnet-beta.solana.com";
const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Known profitable wallets (source: public on-chain data)
// These wallets have verified >$100K profit on Pump.fun
const KNOWN_WALLETS = [
  // Original verified wallets
  "3JPYL9xEPFjefV3tccrUwhLzME1mMq2dQSDeDebgzQi6",  // $1.35M+ profit, 229 tokens
  "CdFHmaj37EtjgRqvyt6vZqoA9tuMSvKLSmbgpuV6ejaP",  // $1.01M+ profit, 695 tokens
  "BECep66KrL7NbUNHq3qyPcMrUTokZbuTxXNCkkceM5w",
  "DePHk4GqS84vGDccKPhFzNmBKmsUj2KNsqFYpKq7vf1f",
  "AAr5vkSnKxqCp45ELKMyQFsHCkiVBE3ygXgGFxGyqTmV",
  "5QGscU3Z4QmKaxQLMknFTfZ12pMdsbBU79qYtkSBPeBS",
  "D8bY9XSvQq2RcTuFnAkVR8pG7uPJNsyjKn7hRQGBuZJg",
  "7LKBxkQZgqffvM3XHgqL1GbbPJa8n3rq7EjFX84BziK",
  "4Cs5YHS7V3JRK5TJJGzjPXpBPbCN3sqKHZmS1ncf3THf",
  "4kU3vTvGWanKvNLUF4kMNyhmJqJN1VauyGjbFG9X3BGV",
  // User-added wallets
  "8FwnXqdCPjUppx7FfNqzAsQnqeWXEPeSZyMgMfGttaFV",  // added by user
  "8Xnit4gf2R5cA3XE6KobuyWjiPfTptsJxN7rrAu8YbiW",  // added by user
  "EvGpkcSBfhp5K9SNP48wVtfNXdKYRBiK3kvMkB66kU3Q",  // added by user
  "4EH92iYK8wua8MyqNExVeiXy5VJUAweXqJPuTWqCvNB8",  // added by user
];

class SmartMoneyMonitor {
  constructor(seenMints) {
    this.wallets = KNOWN_WALLETS;
    this.seenMints = seenMints;      // reference to main monitor's seen set
    this.seenSigs = new Set();        // sigs we already processed per wallet
    this.tokenWallets = {};           // mint -> [wallet addresses]
    this.callbacks = [];              // registered callbacks
    this.interval = null;
  }

  /** Register callback for smart money buy alert */
  onSmartBuy(callback) {
    this.callbacks.push(callback);
  }

  /** Start polling */
  start() {
    this.#poll();
    this.interval = setInterval(() => this.#poll(), 30000);
  }

  /** Stop polling */
  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  /** Get wallets that bought a specific token */
  getWalletsForToken(mint) {
    return this.tokenWallets[mint] || [];
  }

  /** Check if a token has smart money interest */
  getSmartCount(mint) {
    return (this.tokenWallets[mint] || []).length;
  }

  // ─── Poll ───────────────────────────────────────────

  async #poll() {
    for (let w = 0; w < this.wallets.length; w++) {
      const wallet = this.wallets[w];
      await this.#checkWallet(wallet);
      // Rate limit: 300ms between wallet checks
      if (w < this.wallets.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  async #checkWallet(wallet) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getSignaturesForAddress",
          params: [wallet, { limit: 5 }],
        }),
      });
      const data = await res.json();
      const sigs = data.result || [];
      if (!sigs.length) return;

      for (let i = 0; i < sigs.length; i++) {
        const sig = sigs[i].signature;
        const sigKey = wallet + ":" + sig;
        if (this.seenSigs.has(sigKey)) continue;
        this.seenSigs.add(sigKey);

        await this.#analyzeTx(wallet, sig);
      }
    } catch (err) {
      // silent
    }
  }

  async #analyzeTx(wallet, sig) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        }),
      });
      const tx = (await res.json()).result;
      if (!tx || !tx.meta) return;

      // Check if this touches Pump.fun program
      const logs = tx.meta.logMessages || [];
      const touchesPump = logs.some(l => l.indexOf(PUMPFUN.slice(0, 10)) >= 0);
      if (!touchesPump) return;

      // Find new token mints in postTokenBalances
      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];
      const preMints = new Set((pre || []).map(b => b.mint));

      for (let i = 0; i < post.length; i++) {
        const b = post[i];
        if (!b.mint || preMints.has(b.mint)) continue;

        // This wallet bought a new token
        const mint = b.mint;

        // Track who bought it
        if (!this.tokenWallets[mint]) this.tokenWallets[mint] = [];
        if (this.tokenWallets[mint].indexOf(wallet) < 0) {
          this.tokenWallets[mint].push(wallet);
        }

        // Only alert if not already known
        if (this.seenMints.has(mint)) continue;
        this.seenMints.add(mint);

        // Get token info & notify
        const info = await this.#fetchTokenInfo(mint);
        console.log("🧠 聪明钱包 " + wallet.slice(0, 6) + "... 买入 " + (info.name || mint.slice(0, 8)));

        // Fire callbacks
        const token = {
          mint: mint,
          name: info.name,
          symbol: info.symbol,
          creator: "",
          source: "smartmoney",
          socials: { twitter: "", telegram: "", website: "" },
          smartWallets: [wallet],
          smartCount: 1,
        };
        for (let c = 0; c < this.callbacks.length; c++) {
          this.callbacks[c](token);
        }
        return; // one token per tx
      }
    } catch (err) {
      // silent
    }
  }

  async #fetchTokenInfo(mint) {
    try {
      const res = await fetch("https://api.dexscreener.com/latest/dex/search/?q=" + mint);
      if (res.ok) {
        const data = await res.json();
        const pair = (data.pairs || []).find(p => p.chainId === "solana");
        if (pair && pair.baseToken) {
          return {
            name: pair.baseToken.name || mint.slice(0, 8),
            symbol: pair.baseToken.symbol || "?",
          };
        }
      }
    } catch (e) {}
    return { name: mint.slice(0, 8), symbol: "?" };
  }
}

module.exports = { SmartMoneyMonitor, KNOWN_WALLETS };
