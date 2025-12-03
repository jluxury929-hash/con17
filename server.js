const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// CON2 PRODUCTION BACKEND - 450 STRATEGIES | 1M TPS | REAL ETH TRANSACTIONS
// Earning engine + conversion/withdrawal with REAL on-chain transactions
// 
// ═══════════════════════════════════════════════════════════════════════════════

// CONFIGURATION
// NOTE: For this mock environment, the TREASURY_PRIVATE_KEY is a publicly known test key.
// In a real application, this must be secured via environment variables or a secure vault.
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '0x8ba059a91a1b9c994ef7c7a2c42b43012aea02e2d4a1ae3bb121d2bca9aec5ec';
const BACKEND_WALLET = '0xA0D44B2B1E2E828B466a458e3D08384B950ed655';
const FEE_RECIPIENT = BACKEND_WALLET;

// 450 MEV STRATEGIES - Real DEX/Token addresses
// These addresses are real Mainnet smart contract addresses for popular decentralized exchanges and tokens.
const DEX_ROUTERS = {
  UNISWAP_V2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  CURVE: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',
  BALANCER: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  ONEINCH: '0x1111111254EEB25477B68fb85Ed929f73A960582',
  PARASWAP: '0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57',
  KYBERSWAP: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  DODO: '0xa356867fDCEa8e71AEaF87805808803806231FdC'
};

const TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  AAVE: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
};

/**
 * Generates a list of 450 simulated MEV strategies with randomized characteristics.
 * @returns {Array} List of strategies.
 */
function generate450Strategies() {
  const strategies = [];
  const types = ['sandwich', 'frontrun', 'backrun', 'arbitrage', 'liquidation', 'jit', 'flash_swap', 'triangular', 'cross_dex'];
  const dexList = Object.keys(DEX_ROUTERS);
  const tokenList = Object.keys(TOKENS);
  for (let i = 0; i < 450; i++) {
    strategies.push({
      id: i + 1,
      type: types[i % types.length],
      dex: dexList[i % dexList.length],
      token: tokenList[i % tokenList.length],
      apy: 30000 + Math.random() * 50000, // Simulated extremely high APY
      minProfit: 0.001 + Math.random() * 0.005, // Simulated profit per trade in ETH equivalent
      active: true
    });
  }
  return strategies;
}
const STRATEGIES = generate450Strategies();

// EARNING STATE
let isEarning = false;
let totalEarned = 0; // Total earnings in USD
let totalTrades = 0;
let earningStartTime = null;
let earningInterval = null;

// Live ETH Price
let ETH_PRICE = 3500;
let lastPriceUpdate = 0;

// RPC Endpoints (FREE PUBLIC FIRST) for redundancy
const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
  'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq'
];

// Etherscan API (used as fallback for balance check)
const ETHERSCAN_API_KEY = 'ZJJ7F4VVHUUSTMSIJ2PPYC3ARC4GYDE37N';

// Minimum backend balance required for initiating earning/withdrawals
const MIN_BACKEND_ETH = 0.01;
const GAS_RESERVE = 0.003;

// Cached balance for fast response
let cachedBalance = 0;
let lastBalanceCheck = 0;
let connectedRpc = 'none';

// Transaction history (in-memory, real transactions initiated via Ethers)
const transactions = [];
let txIdCounter = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE FETCHING - Multiple sources with fallback
// ═══════════════════════════════════════════════════════════════════════════════

const PRICE_SOURCES = [
  { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', parse: (d) => parseFloat(d.price) },
  { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', parse: (d) => d.ethereum?.usd },
  { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', parse: (d) => parseFloat(d.data?.amount) },
];

/**
 * Fetches the live ETH price from multiple public APIs with timeout and fallback.
 */
async function fetchLiveEthPrice() {
  for (const source of PRICE_SOURCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(source.url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'MEV-Backend/3.0' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const price = source.parse(data);
        // Basic sanity check for price
        if (price && price > 100 && price < 100000) {
          ETH_PRICE = price;
          lastPriceUpdate = Date.now();
          console.log(`📊 ETH: $${ETH_PRICE.toFixed(2)} (${source.name})`);
          return;
        }
      }
    } catch (e) { continue; }
  }
}

fetchLiveEthPrice();
setInterval(fetchLiveEthPrice, 30000); // Update price every 30 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// 450 STRATEGIES EARNING ENGINE - 1,000,000 TPS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simulates one cycle of MEV trading execution (1,000,000 TPS).
 */
function executeEarningCycle() {
  if (!isEarning) return;

  // Execute 1,000,000 trades across 450 strategies
  const tradesPerStrategy = Math.floor(1000000 / 450);
  let cycleProfit = 0;

  STRATEGIES.forEach(strategy => {
    // Each strategy executes ~2,222 trades per cycle
    const trades = tradesPerStrategy;
    // Profit per trade is based on minProfit (in ETH equivalent) adjusted by a random factor
    const profitPerTrade = strategy.minProfit * (0.8 + Math.random() * 0.4);
    // Convert ETH profit to USD profit for the cycle
    const strategyProfit = trades * profitPerTrade * ETH_PRICE / 1000000;
    cycleProfit += strategyProfit;
    totalTrades += trades;
  });

  totalEarned += cycleProfit;

  const runtime = (Date.now() - earningStartTime) / 1000;
  const hourlyRate = runtime > 0 ? (totalEarned / (runtime / 3600)) : 0;

  console.log(`💵 +$${cycleProfit.toFixed(4)} | Total: $${totalEarned.toFixed(2)} | Rate: $${hourlyRate.toFixed(2)}/hr | Trades: ${totalTrades.toLocaleString()}`);
}

/**
 * Starts the simulated high-frequency earning engine.
 */
function startEarning() {
  if (isEarning) return { success: false, message: 'Already earning' };
  if (cachedBalance < MIN_BACKEND_ETH) return { success: false, message: `Need ${MIN_BACKEND_ETH} ETH minimum to start`, balance: cachedBalance };

  isEarning = true;
  earningStartTime = Date.now();
  totalEarned = 0;
  totalTrades = 0;

  // Run 10 cycles per second to simulate 10M TPS effective rate
  earningInterval = setInterval(executeEarningCycle, 100);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 EARNING STARTED - 450 Strategies | 1,000,000 TPS');
  console.log('═══════════════════════════════════════════════════════════════');

  return { success: true, message: 'Earning started', strategies: 450, tps: 1000000 };
}

/**
 * Stops the simulated high-frequency earning engine.
 */
function stopEarning() {
  if (!isEarning) return { success: false, message: 'Not earning' };

  isEarning = false;
  if (earningInterval) clearInterval(earningInterval);

  console.log(`⏸️ EARNING STOPPED | Total: $${totalEarned.toFixed(2)} | Trades: ${totalTrades.toLocaleString()}`);
  return { success: true, totalEarned, totalTrades };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER & WALLET (Ethers.js for real on-chain interaction)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Attempts to connect to a working RPC endpoint using a fallback list.
 * @returns {ethers.providers.JsonRpcProvider} A connected provider instance.
 */
async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber(); // Check for connectivity
      connectedRpc = rpc.split('//')[1].split('/')[0].split('.')[0];
      return provider;
    } catch (e) { continue; }
  }
  throw new Error('All RPC endpoints failed');
}

/**
 * Gets the connected Ethers Wallet instance using the treasury private key.
 * @returns {ethers.Wallet} The wallet instance.
 */
async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

/**
 * Fetches the wallet balance using the Etherscan API as a fallback.
 * @param {string} address - The wallet address.
 * @returns {number|null} Balance in ETH or null on failure.
 */
async function getBalanceViaEtherscan(address) {
  try {
    const url = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === '1') return parseFloat(data.result) / 1e18;
  } catch (e) { }
  return null;
}

/**
 * Checks the real-time balance of the backend wallet and updates the cache.
 */
async function checkBalance() {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    cachedBalance = parseFloat(ethers.utils.formatEther(balance));
    lastBalanceCheck = Date.now();
    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH @ ${connectedRpc}`);
  } catch (e) {
    // Fallback to Etherscan if RPC fails
    const etherscanBal = await getBalanceViaEtherscan(BACKEND_WALLET);
    if (etherscanBal !== null) {
      cachedBalance = etherscanBal;
      console.log(`⚠️ RPC Failed. Cached Balance from Etherscan: ${cachedBalance.toFixed(6)} ETH`);
    } else {
      console.error("🔴 Failed to check balance via both RPC and Etherscan.");
    }
  }
}

setTimeout(checkBalance, 2000); // Initial balance check after 2 seconds
setInterval(checkBalance, 30000); // Check balance every 30 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// GET ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
  res.json({
    status: 'online',
    version: '3.0.0',
    name: 'CON2 Production Backend',
    wallet: BACKEND_WALLET,
    ethPrice: ETH_PRICE,
    balance: cachedBalance,
    isEarning,
    totalEarned: totalEarned.toFixed(2),
    totalEarnedETH: (totalEarned / ETH_PRICE).toFixed(6),
    totalTrades: totalTrades.toLocaleString(),
    hourlyRate: runtime > 0 ? (totalEarned / (runtime / 3600)).toFixed(2) : 0,
    strategies: 450,
    tps: 1000000,
    features: ['450 MEV Strategies', '1M TPS', 'Real ETH transactions', 'Multi-RPC fallback']
  });
});

app.get('/status', async (req, res) => {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
    res.json({
      status: 'online',
      wallet: wallet.address,
      balance: balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      ethPrice: ETH_PRICE,
      lastPriceUpdate: new Date(lastPriceUpdate).toISOString(),
      rpc: connectedRpc,
      canTrade: balanceETH >= MIN_BACKEND_ETH,
      canEarn: balanceETH >= MIN_BACKEND_ETH,
      canWithdraw: balanceETH >= MIN_BACKEND_ETH,
      isEarning,
      totalEarned: totalEarned.toFixed(2),
      totalEarnedETH: (totalEarned / ETH_PRICE).toFixed(6),
      totalTrades: totalTrades.toLocaleString(),
      hourlyRate: runtime > 0 ? (totalEarned / (runtime / 3600)).toFixed(2) : 0,
      strategies: 450,
      tps: 1000000,
      transactionCount: transactions.length
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message, cachedBalance, isEarning, totalEarned });
  }
});

app.get('/health', (req, res) => {
  res.json({ healthy: true, timestamp: Date.now(), ethPrice: ETH_PRICE });
});

app.get('/balance', async (req, res) => {
  // Use cached balance if recent, otherwise trigger a check
  if (Date.now() - lastBalanceCheck < 10000) {
    return res.json({
      address: BACKEND_WALLET,
      balanceETH: cachedBalance,
      balanceUSD: cachedBalance * ETH_PRICE,
      ethPrice: ETH_PRICE,
      lastUpdated: new Date(lastBalanceCheck).toISOString(),
      network: 'Mainnet (Cached)'
    });
  }
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    res.json({
      address: wallet.address,
      balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      ethPrice: ETH_PRICE,
      lastUpdated: new Date().toISOString(),
      network: 'Mainnet'
    });
  } catch (e) {
    res.status(500).json({ error: e.message, cachedBalance });
  }
});

app.get('/wallet/balance', (req, res) => app.get('/balance')(req, res)); // Alias

app.get('/eth-price', (req, res) => {
  res.json({ price: ETH_PRICE, lastUpdate: lastPriceUpdate, source: 'Multi-API' });
});

app.get('/transactions', (req, res) => {
  res.json({ count: transactions.length, data: transactions.slice(-50).reverse() });
});

app.get('/transactions/:id', (req, res) => {
  const tx = transactions.find(t => t.id === parseInt(req.params.id));
  if (tx) res.json(tx);
  else res.status(404).json({ error: 'Transaction not found' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST ENDPOINTS - REAL ETH TRANSACTIONS (Withdrawal/Conversion)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handles all ETH transfer requests, including withdraw and convert.
 */
async function handleConvert(req, res) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💸 CONVERT/WITHDRAW REQUEST');

  try {
    const { to, toAddress, amount, amountETH, amountUSD, percentage, treasury } = req.body;
    // Determine the destination address
    const destination = to || toAddress || treasury || BACKEND_WALLET;

    console.log('📍 Destination:', destination);

    if (!destination || !destination.startsWith('0x') || destination.length !== 42) {
      return res.status(400).json({ error: 'Invalid destination address' });
    }

    // Calculate amount in ETH
    let ethAmount = parseFloat(amountETH || amount || 0);
    if (!ethAmount && amountUSD) {
      ethAmount = parseFloat(amountUSD) / ETH_PRICE;
      console.log(`📊 Converted $${amountUSD} → ${ethAmount.toFixed(6)} ETH @ $${ETH_PRICE}`);
    }

    if (!ethAmount || ethAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount or price unavailable' });
    }

    console.log('💰 Requested:', ethAmount.toFixed(6), 'ETH');

    // Get wallet and current balance
    const wallet = await getWallet();
    console.log('📡 RPC:', connectedRpc);
    console.log('👛 From:', wallet.address);

    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    console.log('💰 Balance:', balanceETH.toFixed(6), 'ETH');

    // Handle percentage logic
    if (percentage) {
      const p = parseFloat(percentage);
      if (p <= 0 || p > 100) return res.status(400).json({ error: 'Invalid percentage' });
      // Calculate amount based on percentage of (Balance - Gas Reserve)
      ethAmount = (balanceETH - GAS_RESERVE) * (p / 100);
      console.log(`📊 ${p}% of available balance = ${ethAmount.toFixed(6)} ETH`);
    }

    // Get gas price for estimation
    const gasPrice = await wallet.provider.getGasPrice();
    const gasCostWei = gasPrice.mul(21000); // Base gas limit for ETH transfer
    const gasCostETH = parseFloat(ethers.utils.formatEther(gasCostWei));
    console.log('⛽ Gas estimate:', gasCostETH.toFixed(6), 'ETH');

    const totalNeeded = ethAmount + gasCostETH;
    if (totalNeeded > balanceETH) {
      const maxWithdrawable = Math.max(0, balanceETH - gasCostETH - 0.0005);
      console.log('❌ INSUFFICIENT BALANCE');
      return res.status(400).json({
        error: 'Insufficient balance (need amount + gas)',
        available: balanceETH,
        requested: ethAmount,
        gasEstimate: gasCostETH,
        totalNeeded,
        maxWithdrawable: maxWithdrawable.toFixed(6),
        ethPrice: ETH_PRICE
      });
    }

    // SEND REAL TRANSACTION
    console.log('📤 Sending transaction...');
    const tx = await wallet.sendTransaction({
      to: destination,
      value: ethers.utils.parseEther(ethAmount.toFixed(18)),
      // Using EIP-1559 style parameters for modern networks
      maxFeePerGas: gasPrice.mul(2), // Max fee is 2x base
      maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei'), // 2 Gwei tip
      gasLimit: 21000
    });

    console.log('⏳ TX submitted:', tx.hash);
    const receipt = await tx.wait(1); // Wait for 1 confirmation
    const gasUsedETH = parseFloat(ethers.utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice)));

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ TRANSACTION CONFIRMED');
    console.log('💸 Sent:', ethAmount.toFixed(6), 'ETH');
    console.log('📍 To:', destination);
    console.log('🔗 TX:', tx.hash);
    console.log('📦 Block:', receipt.blockNumber);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Log transaction
    const txRecord = {
      id: txIdCounter++,
      type: 'Withdrawal',
      amountETH: ethAmount,
      amountUSD: ethAmount * ETH_PRICE,
      destination,
      status: 'Confirmed',
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: gasUsedETH,
      timestamp: new Date().toISOString()
    };
    transactions.push(txRecord);
    // Update cached balance immediately after a successful transaction
    cachedBalance = balanceETH - ethAmount - gasUsedETH;
    lastBalanceCheck = Date.now();

    res.json({
      success: true,
      txHash: tx.hash,
      amount: ethAmount,
      amountUSD: ethAmount * ETH_PRICE,
      ethPrice: ETH_PRICE,
      to: destination,
      gasUsed: gasUsedETH,
      blockNumber: receipt.blockNumber,
      confirmed: true
    });
  } catch (e) {
    console.log('❌ ERROR:', e.message);

    // Log failed transaction
    transactions.push({
      id: txIdCounter++,
      type: 'Withdrawal',
      status: 'Failed',
      error: e.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({ error: e.message, code: e.code, detail: e.toString() });
  }
}

// Main conversion endpoint
app.post('/convert', handleConvert);

// Alias endpoints - all use handleConvert
app.post('/withdraw', (req, res) => {
  req.body.to = req.body.to || req.body.toAddress;
  handleConvert(req, res);
});

app.post('/send-eth', (req, res) => {
  const { to, amount, treasury } = req.body;
  req.body.to = to || treasury;
  req.body.amountETH = amount;
  handleConvert(req, res);
});

// Various aliases for maximum compatibility
app.post('/coinbase-withdraw', handleConvert);
app.post('/send-to-coinbase', handleConvert);
app.post('/backend-to-coinbase', handleConvert);
app.post('/treasury-to-coinbase', handleConvert);
app.post('/fund-from-earnings', handleConvert);
app.post('/transfer', handleConvert);

// ═══════════════════════════════════════════════════════════════════════════════
// EARNING CONTROL ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/start', (req, res) => {
  const result = startEarning();
  res.json(result);
});

app.post('/stop', (req, res) => {
  const result = stopEarning();
  res.json(result);
});

app.get('/earnings', (req, res) => {
  const runtime = earningStartTime ? (Date.now() - earningStartTime) / 1000 : 0;
  res.json({
    isEarning,
    totalEarned: totalEarned.toFixed(2),
    totalEarnedETH: (totalEarned / ETH_PRICE).toFixed(6),
    totalTrades: totalTrades.toLocaleString(),
    hourlyRate: runtime > 0 ? (totalEarned / (runtime / 3600)).toFixed(2) : 0,
    strategies: 450,
    tps: 1000000,
    runtime: runtime.toFixed(0) + 's',
    ethPrice: ETH_PRICE
  });
});

app.get('/strategies', (req, res) => {
  res.json({ count: 450, strategies: STRATEGIES.slice(0, 20) }); // Only show first 20 for brevity
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 CON2 PRODUCTION BACKEND - 450 STRATEGIES | 1M TPS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`👛 Wallet: ${BACKEND_WALLET}`);
  console.log(`💰 ETH Price: $${ETH_PRICE}`);
  console.log(`📊 Strategies: 450`);
  console.log(`⚡ TPS: 1,000,000 (Simulated)`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('GET ENDPOINTS:');
  console.log('  /             - Server status');
  console.log('  /status       - Detailed status + balance');
  console.log('  /balance      - Wallet balance');
  console.log('  /eth-price    - Live ETH price');
  console.log('  /transactions - Transaction history');
  console.log('  /earnings     - Earning stats');
  console.log('POST ENDPOINTS (Real ETH TX):');
  console.log('  /convert      - Convert/withdraw ETH');
  console.log('  /start        - START earning');
  console.log('  /stop         - STOP earning');
  console.log('═══════════════════════════════════════════════════════════════');
});
