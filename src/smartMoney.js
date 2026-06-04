/**
 * Smart Money Wallet Tracker
 *
 * Monitors known profitable wallets for new Pump.fun token buys.
 * When a tracked wallet buys a new token, emits an alert.
 * Cross-references with the main monitor's seen set to avoid duplicates.
 */

const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const { apiFetch } = require("./fetch");
const { rpcCall } = require("./rpc");

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
  "ALKV2vKuYyazXSVWPao3KXFkEnhejdSs7Ti5qeZSKENH",  // added by user
  "DDApL88zun3vGuhkxkUx6HmoXUyj37xs2NiwW5SMknHZ",  // added by user
  "3kebnKw7cPdSkLRfiMEALyZJGZ4wdiSRvmoN4rD1yPzV",  // added by user
];

class SmartMoneyMonitor {
  constructor(seenMints) {
    this.wallets = KNOWN_WALLETS.slice();  // 硬编码钱包作为基础
    this.seenMints = seenMints;      // reference to main monitor's seen set
    this.seenSigs = new Set();        // sigs we already processed per wallet
    this.tokenWallets = {};           // mint -> [wallet addresses]
    this.callbacks = [];              // registered callbacks
    this.interval = null;

    // 异步自动发现聪明钱包（不阻塞启动）
    this.#refreshWallets();
    // 每 24 小时刷新一次
    setInterval(() => this.#refreshWallets(), 86400000);
  }

  /**
   * 从链上 Pump.fun 交易自动发现聪明钱包
   *
   * 原理：查最近 Pump.fun 交易，找那些经常买新币的钱包。
   * 如果某个钱包在多个交易中买入新代币，说明它是"聪明钱"。
   *
   * 不用外部 API，纯链上数据。
   */
  async #refreshWallets() {
    try {
      // 取最近 30 条 Pump.fun 签名
      var sigs = await rpcCall("getSignaturesForAddress", [PUMPFUN, { limit: 30 }]);
      if (!sigs || sigs.length === 0) return;

      // 提取所有钱包地址（交易发起者 = fee payer）
      var buyerCounts = {};
      var seen = new Set(this.wallets);

      for (var i = 0; i < sigs.length; i++) {
        try {
          var tx = await rpcCall("getTransaction", [sigs[i].signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
          if (!tx || !tx.meta) continue;

          // 检查是否是 Pump.fun 交易
          var logs = tx.meta.logMessages || [];
          var touchesPump = logs.some(function(l) { return l.indexOf("Program log: Instruction") >= 0; });
          if (!touchesPump) continue;

          // 找 fee payer（出 gas 的钱包 = 发起交易的钱包）
          var accountKeys = tx.transaction?.message?.accountKeys || [];
          var buyer = accountKeys[0]?.pubkey || "";
          if (!buyer || buyer.length < 30) continue;

          // 忽略已知的 Pump.fun 程序地址
          if (buyer === PUMPFUN) continue;

          if (!buyerCounts[buyer]) buyerCounts[buyer] = 0;
          buyerCounts[buyer]++;
        } catch (e) {}
      }

      // 出现 3 次以上的钱包可能是聪明钱（活跃交易者）
      var added = 0;
      for (var wallet in buyerCounts) {
        if (buyerCounts[wallet] >= 3 && !seen.has(wallet)) {
          this.wallets.push(wallet);
          seen.add(wallet);
          added++;
        }
      }

      if (added > 0) {
        console.log("🧠 聪明钱自动发现: 新增 " + added + " 个钱包（共 " + this.wallets.length + " 个）");
      }
    } catch (e) {
      // API 失败不影响运行，继续用已有钱包列表
    }
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
      const sigs = await rpcCall("getSignaturesForAddress", [wallet, { limit: 5 }]) || [];
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
      const tx = await rpcCall("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
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
      const res = await // Use apiFetch for blocked domains
      apiFetch("https://api.dexscreener.com/latest/dex/search/?q=" + mint, { signal: AbortSignal.timeout(30000) });
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
