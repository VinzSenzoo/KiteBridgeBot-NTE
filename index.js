import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const KITEAI_RPC_URL = "https://rpc-testnet.gokite.ai/";
const BASE_RPC_URL = "https://base-sepolia-rpc.publicnode.com/";
const KITEAI_CHAIN_ID = 2368;
const BASE_CHAIN_ID = 84532;
const KITEAI_ROUTER_KITE = "0x0BBB7293c08dE4e62137a557BC40bc12FA1897d6";
const BASE_ROUTER_ETH = "0x226D7950D4d304e749b0015Ccd3e2c7a4979bB7C";
const KITE_TOKEN_BASE = "0xFB9a6AF5C014c32414b4a6e208a89904c6dAe266";
const ETH_TOKEN_KITEAI = "0x7AEFdb35EEaAD1A15E869a6Ce0409F26BFd31239";
const BRIDGE_API_URL = "https://bridge-backend.prod.gokite.ai/bridge-transfer";
const CONFIG_FILE = "config.json";
const isDebug = false;

const tokenAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

let walletInfo = {
  address: "N/A",
  balanceKite: "0.0000",
  balanceEth: "0.000000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let isActivityRunning = false;
let isScheduled = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let privateKeys = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  kiteBridgeRepetitions: 1,
  minKiteBridge: 0.01,
  maxKiteBridge: 0.05,
  ethBridgeRepetitions: 1,
  minEthBridge: 0.0001,
  maxEthBridge: 0.0005,
  bridgeDelay: 30000,
  accountDelay: 10000,
  randomDelayMin: 10000, 
  randomDelayMax: 30000,
  transactionTimeout: 60000
};

function formatNonceKey(address, chainId) {
  return `${address}:${chainId}`;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.kiteBridgeRepetitions = Number(config.kiteBridgeRepetitions) || 1;
      dailyActivityConfig.minKiteBridge = Number(config.minKiteBridge) || 0.01;
      dailyActivityConfig.maxKiteBridge = Number(config.maxKiteBridge) || 0.05;
      dailyActivityConfig.ethBridgeRepetitions = Number(config.ethBridgeRepetitions) || 1;
      dailyActivityConfig.minEthBridge = Number(config.minEthBridge) || 0.0001;
      dailyActivityConfig.maxEthBridge = Number(config.maxEthBridge) || 0.0005;
      dailyActivityConfig.bridgeDelay = Number(config.bridgeDelay) || 30000;
      dailyActivityConfig.accountDelay = Number(config.accountDelay) || 10000;
      dailyActivityConfig.randomDelayMin = Number(config.randomDelayMin) || 10000;
      dailyActivityConfig.randomDelayMax = Number(config.randomDelayMax) || 30000;
      dailyActivityConfig.transactionTimeout = Number(config.transactionTimeout) || 60000;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeJsonRpcCall(method, params, rpcUrl) {
  try {
    const id = uuidv4();
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const agent = createAgent(proxyUrl);
    const response = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id,
      method,
      params
    }, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent
    });
    const data = response.data;
    if (data.error) throw new Error(`RPC Error: ${data.error.message} (code: ${data.error.code})`);
    if (!data.result && data.result !== "") throw new Error("No result in RPC response");
    return data.result;
  } catch (error) {
    addLog(`JSON-RPC call failed (${method}): ${error.message}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error": coloredMessage = chalk.redBright(message); break;
    case "success": coloredMessage = chalk.greenBright(message); break;
    case "wait": coloredMessage = chalk.yellowBright(message); break;
    case "info": coloredMessage = chalk.whiteBright(message); break;
    case "delay": coloredMessage = chalk.cyanBright(message); break;
    default: coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadPrivateKeys() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(key => key.trim()).filter(key => key.match(/^(0x)?[0-9a-fA-F]{64}$/));
    if (privateKeys.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${privateKeys.length} private keys from pk`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function getProviderWithProxy(proxyUrl, rpcUrl, chainId, networkName) {
  const agent = createAgent(proxyUrl);
  const fetchOptions = agent ? { agent } : {};
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId, name: networkName }, { fetchOptions });
  return provider;
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = privateKeys.map(async (privateKey, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const providerKiteAI = getProviderWithProxy(proxyUrl, KITEAI_RPC_URL, KITEAI_CHAIN_ID, "KiteAI");
      const providerBase = getProviderWithProxy(proxyUrl, BASE_RPC_URL, BASE_CHAIN_ID, "Base");
      const walletKiteAI = new ethers.Wallet(privateKey, providerKiteAI);
      const walletBase = new ethers.Wallet(privateKey, providerBase);

      const kiteBalance = await providerKiteAI.getBalance(walletKiteAI.address);
      const ethBalance = await providerBase.getBalance(walletBase.address);
      const formattedKite = Number(ethers.formatUnits(kiteBalance, 18)).toFixed(4);
      const formattedEth = Number(ethers.formatUnits(ethBalance, 18)).toFixed(6);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(walletKiteAI.address))}   ${chalk.bold.cyanBright(formattedKite.padEnd(8))}   ${chalk.bold.greenBright(formattedEth.padEnd(10))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = walletKiteAI.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceKite = formattedKite;
        walletInfo.balanceEth = formattedEth;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.0000 0.000000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function getNextNonce(provider, walletAddress, chainId) {
  if (shouldStop) {
    addLog("Nonce fetch stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    addLog(`Invalid wallet address: ${walletAddress}`, "error");
    throw new Error("Invalid wallet address");
  }
  try {
    const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
    const nonceKey = formatNonceKey(walletAddress, chainId);
    const lastUsedNonce = nonceTracker[nonceKey] || pendingNonce - 1;
    const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
    return nextNonce;
  } catch (error) {
    throw error;
  }
}

function encodeSendData(targetChainId, recipient, amount) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(["uint256", "address", "uint256"], [targetChainId, recipient, amount]);
}

async function bridgeKiteFromKiteAiToBase(wallet, amount, accountIndex, bridgeCount) {
  if (shouldStop) {
    addLog(`Bridge KiteAI ⮞ Base stopped due to stop request for account ${accountIndex + 1}`, "info");
    return null;
  }
  try {
    const balance = await wallet.provider.getBalance(wallet.address);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    addLog(`Account ${accountIndex + 1} - KITE Bridge ${bridgeCount + 1}: KITE Balance: ${ethers.formatUnits(balance, 18)}`, "wait");
    if (balance < amountWei) {
      addLog(`Insufficient KITE balance: ${ethers.formatUnits(balance, 18)} < ${amount}, skipping...`, "error");
      return null;
    }

    const targetChainId = BASE_CHAIN_ID;
    const recipient = wallet.address;
    const data = encodeSendData(targetChainId, recipient, amountWei);
    const tx = {
      to: KITEAI_ROUTER_KITE,
      value: amountWei,
      data: "0x81b34f15" + data.slice(2),
      gasLimit: 5000000,
      chainId: KITEAI_CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address, KITEAI_CHAIN_ID)
    };

    const maxRetries = 2;
    let attempt = 0;
    let sentTx = null;
    while (attempt < maxRetries && !sentTx && !shouldStop) {
      try {
        addLog(`Using nonce: ${tx.nonce}`, "wait");
        const sendPromise = wallet.sendTransaction(tx);
        sentTx = await Promise.race([
          sendPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction timeout")), dailyActivityConfig.transactionTimeout))
        ]);
      } catch (error) {
        attempt++;
        addLog(`Attempt ${attempt} failed for KITE bridge: ${error.message}`, "error");
        if (attempt < maxRetries && !shouldStop) {
          addLog(`Retrying KITE bridge (Attempt ${attempt + 1})...`, "info");
          tx.nonce = await getNextNonce(wallet.provider, wallet.address, KITEAI_CHAIN_ID);
          addLog(`Refreshed nonce: ${tx.nonce} for retry`, "info");
          await sleep(2000);
        } else {
          addLog(`Max retries reached for KITE bridge or stopped. Skipping...`, "error");
          return null;
        }
      }
    }

    if (!sentTx || shouldStop) {
      addLog(`Bridge KiteAI ⮞ Base cancelled for account ${accountIndex + 1}`, "info");
      return null;
    }

    const receipt = await Promise.race([
      sentTx.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), dailyActivityConfig.transactionTimeout))
    ]);

    if (receipt.status === 0) throw new Error("Transaction reverted");
    addLog(`Bridge KiteAI ⮞ Base KITE successful: ${getShortHash(sentTx.hash)}`, "success");
    nonceTracker[formatNonceKey(wallet.address, KITEAI_CHAIN_ID)] = tx.nonce;

    await reportBridgeTransaction(
    KITEAI_CHAIN_ID,
    BASE_CHAIN_ID,
    KITEAI_ROUTER_KITE,
    KITE_TOKEN_BASE,
    amountWei,
    wallet.address,
    wallet.address,
    sentTx.hash
  );
    return sentTx.hash;
  } catch (error) {
    addLog(`Bridge KiteAI ⮞ Base failed: ${error.message}`, "error");
    return null;
  }
}

async function bridgeKiteFromBaseToKiteAi(wallet, amount, accountIndex, bridgeCount) {
  if (shouldStop) {
    addLog(`Bridge Base ⮞ KiteAI stopped due to stop request for account ${accountIndex + 1}`, "info");
    return null;
  }
  try {
    const tokenContract = new ethers.Contract(KITE_TOKEN_BASE, tokenAbi, wallet);
    const balance = await tokenContract.balanceOf(wallet.address);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    addLog(`Account ${accountIndex + 1} - KITE Bridge ${bridgeCount + 1}: Bridged KITE Balance: ${ethers.formatUnits(balance, 18)}`, "wait");
    if (balance < amountWei) {
      addLog(`Insufficient wrapped KITE balance: ${ethers.formatUnits(balance, 18)} < ${amount}, skipping...`, "error");
      return null;
    }

    const targetChainId = KITEAI_CHAIN_ID;
    const recipient = wallet.address;
    const data = encodeSendData(targetChainId, recipient, amountWei);
    const tx = {
      to: KITE_TOKEN_BASE,
      data: "0x81b34f15" + data.slice(2),
      gasLimit: 500000,
      chainId: BASE_CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address, BASE_CHAIN_ID)
    };

    const maxRetries = 2;
    let attempt = 0;
    let sentTx = null;
    while (attempt < maxRetries && !sentTx && !shouldStop) {
      try {
        addLog(`Using nonce: ${tx.nonce}`, "wait");
        const sendPromise = wallet.sendTransaction(tx);
        sentTx = await Promise.race([
          sendPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction timeout")), dailyActivityConfig.transactionTimeout))
        ]);
      } catch (error) {
        attempt++;
        addLog(`Attempt ${attempt} failed for KITE bridge: ${error.message}`, "error");
        if (attempt < maxRetries && !shouldStop) {
          addLog(`Retrying KITE bridge (Attempt ${attempt + 1})...`, "info");
          tx.nonce = await getNextNonce(wallet.provider, wallet.address, BASE_CHAIN_ID);
          addLog(`Refreshed nonce: ${tx.nonce} for retry`, "info");
          await sleep(2000);
        } else {
          addLog(`Max retries reached for KITE bridge or stopped. Skipping...`, "error");
          return null;
        }
      }
    }

    if (!sentTx || shouldStop) {
      addLog(`Bridge Base ⮞ KiteAI cancelled for account ${accountIndex + 1}`, "info");
      return null;
    }

    const receipt = await Promise.race([
      sentTx.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), dailyActivityConfig.transactionTimeout))
    ]);

    if (receipt.status === 0) throw new Error("Transaction reverted");
    addLog(`Bridge Base ⮞ KiteAI KITE successful: ${getShortHash(sentTx.hash)}`, "success");
    nonceTracker[formatNonceKey(wallet.address, BASE_CHAIN_ID)] = tx.nonce;

    await reportBridgeTransaction(
      BASE_CHAIN_ID,
      KITEAI_CHAIN_ID,
      KITE_TOKEN_BASE,
      KITEAI_ROUTER_KITE,
      amountWei,
      wallet.address,
      wallet.address,
      sentTx.hash
    );
    return sentTx.hash;
  } catch (error) {
    addLog(`Bridge Base ⮞ KiteAI failed: ${error.message}`, "error");
    return null;
  }
}

async function bridgeEthFromBaseToKiteAi(wallet, amount, accountIndex, bridgeCount) {
  if (shouldStop) {
    addLog(`Bridge Base ⮞ KiteAI ETH stopped due to stop request for account ${accountIndex + 1}`, "info");
    return null;
  }
  try {
    const balance = await wallet.provider.getBalance(wallet.address);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    addLog(`Account ${accountIndex + 1} - ETH Bridge ${bridgeCount + 1}: ETH Balance: ${ethers.formatUnits(balance, 18)}`, "wait");
    if (balance < amountWei) {
      addLog(`Insufficient ETH balance: ${ethers.formatUnits(balance, 18)} < ${amount}, skipping...`, "error");
      return null;
    }

    const targetChainId = KITEAI_CHAIN_ID;
    const recipient = wallet.address;
    const data = encodeSendData(targetChainId, recipient, amountWei);
    const tx = {
      to: BASE_ROUTER_ETH,
      value: amountWei,
      data: "0x81b34f15" + data.slice(2),
      gasLimit: 500000,
      chainId: BASE_CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address, BASE_CHAIN_ID)
    };

    const maxRetries = 2;
    let attempt = 0;
    let sentTx = null;
    while (attempt < maxRetries && !sentTx && !shouldStop) {
      try {
        addLog(`Using nonce: ${tx.nonce}`, "wait");
        const sendPromise = wallet.sendTransaction(tx);
        sentTx = await Promise.race([
          sendPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction timeout")), dailyActivityConfig.transactionTimeout))
        ]);
      } catch (error) {
        attempt++;
        addLog(`Attempt ${attempt} failed for ETH bridge: ${error.message}`, "error");
        if (attempt < maxRetries && !shouldStop) {
          addLog(`Retrying ETH bridge (Attempt ${attempt + 1})...`, "info");
          tx.nonce = await getNextNonce(wallet.provider, wallet.address, BASE_CHAIN_ID);
          addLog(`Refreshed nonce: ${tx.nonce} for retry`, "info");
          await sleep(2000);
        } else {
          addLog(`Max retries reached for ETH bridge or stopped. Skipping...`, "error");
          return null;
        }
      }
    }

    if (!sentTx || shouldStop) {
      addLog(`Bridge Base ⮞ KiteAI ETH cancelled for account ${accountIndex + 1}`, "info");
      return null;
    }

    const receipt = await Promise.race([
      sentTx.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), dailyActivityConfig.transactionTimeout))
    ]);

    if (receipt.status === 0) throw new Error("Transaction reverted");
    addLog(`Bridge Base ⮞ KiteAI ETH successful: ${getShortHash(sentTx.hash)}`, "success");
    nonceTracker[formatNonceKey(wallet.address, BASE_CHAIN_ID)] = tx.nonce;

    await reportBridgeTransaction(
      BASE_CHAIN_ID,
      KITEAI_CHAIN_ID,
      BASE_ROUTER_ETH,
      ETH_TOKEN_KITEAI,
      amountWei,
      wallet.address,
      wallet.address,
      sentTx.hash
    );
    return sentTx.hash;
  } catch (error) {
    addLog(`Bridge Base ⮞ KiteAI ETH failed: ${error.message}`, "error");
    return null;
  }
}

async function bridgeEthFromKiteAiToBase(wallet, amount, accountIndex, bridgeCount) {
  if (shouldStop) {
    addLog(`Bridge KiteAI ⮞ Base ETH stopped due to stop request for account ${accountIndex + 1}`, "info");
    return null;
  }
  try {
    const tokenContract = new ethers.Contract(ETH_TOKEN_KITEAI, tokenAbi, wallet);
    const balance = await tokenContract.balanceOf(wallet.address);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    addLog(`Account ${accountIndex + 1} - ETH Bridge ${bridgeCount + 1}: Bridged ETH Balance: ${ethers.formatUnits(balance, 18)}`, "wait");
    if (balance < amountWei) {
      addLog(`Insufficient wrapped ETH balance: ${ethers.formatUnits(balance, 18)} < ${amount}, skipping...`, "error");
      return null;
    }

    const targetChainId = BASE_CHAIN_ID;
    const recipient = wallet.address;
    const data = encodeSendData(targetChainId, recipient, amountWei);
    const tx = {
      to: ETH_TOKEN_KITEAI,
      data: "0x81b34f15" + data.slice(2),
      gasLimit: 5000000,
      chainId: KITEAI_CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address, KITEAI_CHAIN_ID)
    };

    const maxRetries = 2;
    let attempt = 0;
    let sentTx = null;
    while (attempt < maxRetries && !sentTx && !shouldStop) {
      try {
        addLog(`Using nonce: ${tx.nonce}`, "wait");
        const sendPromise = wallet.sendTransaction(tx);
        sentTx = await Promise.race([
          sendPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction timeout")), dailyActivityConfig.transactionTimeout))
        ]);
      } catch (error) {
        attempt++;
        addLog(`Attempt ${attempt} failed for ETH bridge: ${error.message}`, "error");
        if (attempt < maxRetries && !shouldStop) {
          addLog(`Retrying ETH bridge (Attempt ${attempt + 1})...`, "info");
          tx.nonce = await getNextNonce(wallet.provider, wallet.address, KITEAI_CHAIN_ID);
          addLog(`Refreshed nonce: ${tx.nonce} for retry`, "info");
          await sleep(2000);
        } else {
          addLog(`Max retries reached for ETH bridge or stopped. Skipping...`, "error");
          return null;
        }
      }
    }

    if (!sentTx || shouldStop) {
      addLog(`Bridge KiteAI ⮞ Base ETH cancelled for account ${accountIndex + 1}`, "info");
      return null;
    }

    const receipt = await Promise.race([
      sentTx.wait(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), dailyActivityConfig.transactionTimeout))
    ]);

    if (receipt.status === 0) throw new Error("Transaction reverted");
    addLog(`Bridge KiteAI ⮞ Base ETH successful: ${getShortHash(sentTx.hash)}`, "success");
    nonceTracker[formatNonceKey(wallet.address, KITEAI_CHAIN_ID)] = tx.nonce;

    await reportBridgeTransaction(
      KITEAI_CHAIN_ID,
      BASE_CHAIN_ID,
      ETH_TOKEN_KITEAI,
      BASE_ROUTER_ETH,
      amountWei,
      wallet.address,
      wallet.address,
      sentTx.hash
    );
    return sentTx.hash;
  } catch (error) {
    addLog(`Bridge KiteAI ⮞ Base failed: ${error.message}`, "error");
    return null;
  }
}

async function reportBridgeTransaction(sourceChainId, targetChainId, sourceTokenAddress, targetTokenAddress, amount, sourceAddress, targetAddress, txHash) {
  const payload = {
    source_chain_id: sourceChainId,
    target_chain_id: targetChainId,
    source_token_address: sourceTokenAddress,
    target_token_address: targetTokenAddress,
    amount: amount.toString(),
    source_address: sourceAddress,
    target_address: targetAddress,
    tx_hash: txHash,
    initiated_at: new Date().toISOString()
  };

  const maxRetries = 3;
  let attempt = 0;
  let success = false;

  while (attempt < maxRetries && !success) {
    try {
      const response = await axios.post(BRIDGE_API_URL, payload, {
        headers: {
          'accept': '*/*',
          'accept-encoding': 'gzip, deflate, br',
          'content-type': 'application/json',
          'origin': 'https://bridge.prod.gokite.ai',
          'referer': 'https://bridge.prod.gokite.ai/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
        }
      });
      if (response.data.error) {
        addLog(`API Error: ${response.data.error}`, "error");
      } else {
        addLog("Bridge transaction reported successfully.", "success");
        success = true;
      }
    } catch (error) {
      attempt++;
      if (error.response) {
        addLog(`Attempt ${attempt} failed with status ${error.response.status}. Response: ${JSON.stringify(error.response.data, null, 2)}`, "error");
      } else {
        addLog(`Attempt ${attempt} failed: ${error.message}`, "error");
      }
      if (attempt < maxRetries) {
        addLog("Retrying...", "info");
        await sleep(2000);
      } else {
        addLog("Max retries reached for reporting bridge transaction.", "error");
      }
    }
  }
}

async function runDailyActivity() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return;
  }
  addLog(`Starting daily activity. KITE Bridges: ${dailyActivityConfig.kiteBridgeRepetitions}x, ETH Bridges: ${dailyActivityConfig.ethBridgeRepetitions}x`, "info");
  isActivityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = 0;
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < privateKeys.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      const providerKiteAI = getProviderWithProxy(proxyUrl, KITEAI_RPC_URL, KITEAI_CHAIN_ID, "KiteAI");
      const providerBase = getProviderWithProxy(proxyUrl, BASE_RPC_URL, BASE_CHAIN_ID, "Base");
      const walletKiteAI = new ethers.Wallet(privateKeys[accountIndex], providerKiteAI);
      const walletBase = new ethers.Wallet(privateKeys[accountIndex], providerBase);

      for (let bridgeCount = 0; bridgeCount < dailyActivityConfig.kiteBridgeRepetitions && !shouldStop; bridgeCount++) {
        if (shouldStop) break; 
        const amountKite = (Math.random() * (dailyActivityConfig.maxKiteBridge - dailyActivityConfig.minKiteBridge) + dailyActivityConfig.minKiteBridge).toFixed(4);
        const direction = Math.random() < 0.5 ? "KiteAI ⮞ Base" : "Base ⮞ KiteAI";
        addLog(`Account ${accountIndex + 1} - KITE Bridge ${bridgeCount + 1}: ${direction} ${amountKite} KITE`, "wait");

        let txHash = null;
        if (direction === "KiteAI ⮞ Base") {
          txHash = await bridgeKiteFromKiteAiToBase(walletKiteAI, amountKite, accountIndex, bridgeCount);
        } else {
          txHash = await bridgeKiteFromBaseToKiteAi(walletBase, amountKite, accountIndex, bridgeCount);
        }

        if (txHash) {
          await updateWallets();
        }

        if (txHash && bridgeCount < dailyActivityConfig.kiteBridgeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (dailyActivityConfig.randomDelayMax - dailyActivityConfig.randomDelayMin + 1)) + dailyActivityConfig.randomDelayMin;
          addLog(`Waiting ${randomDelay / 1000}s before next KITE bridge...`, "delay");
          await sleep(randomDelay);
        } 
      }

      if (!shouldStop) {
        addLog("Waiting 10 seconds before starting ETH bridges...", "delay");
        await sleep(10000);
      }

      for (let bridgeCount = 0; bridgeCount < dailyActivityConfig.ethBridgeRepetitions && !shouldStop; bridgeCount++) {
        if (shouldStop) break; 
        const amountEth = (Math.random() * (dailyActivityConfig.maxEthBridge - dailyActivityConfig.minEthBridge) + dailyActivityConfig.minEthBridge).toFixed(6);
        const direction = Math.random() < 0.5 ? "Base ⮞ KiteAI" : "KiteAI ⮞ Base";
        addLog(`Account ${accountIndex + 1} - ETH Bridge ${bridgeCount + 1}: ${direction} ${amountEth} ETH`, "wait");

        let txHash = null;
        if (direction === "Base ⮞ KiteAI") {
          txHash = await bridgeEthFromBaseToKiteAi(walletBase, amountEth, accountIndex, bridgeCount);
        } else {
          txHash = await bridgeEthFromKiteAiToBase(walletKiteAI, amountEth, accountIndex, bridgeCount);
        }

        if (txHash) {
          await updateWallets();
        }

        if (txHash && bridgeCount < dailyActivityConfig.ethBridgeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (dailyActivityConfig.randomDelayMax - dailyActivityConfig.randomDelayMin + 1)) + dailyActivityConfig.randomDelayMin;
          addLog(`Waiting ${randomDelay / 1000}s before next ETH bridge...`, "delay");
          await sleep(randomDelay);
        } 
      }

      if (accountIndex < privateKeys.length - 1 && !shouldStop) {
        addLog(`Waiting ${dailyActivityConfig.accountDelay / 1000}s before next account...`, "delay");
        await sleep(dailyActivityConfig.accountDelay);
      }
    }

    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    isActivityRunning = false;
    isScheduled = dailyActivityInterval !== null;
    isCycleRunning = isActivityRunning || isScheduled;
    updateMenu();
    updateStatus();
    safeRender();
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "KITEAI-BASE AUTO BRIDGE BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status ")
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "60%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "blue" }, selected: { bg: "blue", fg: "black" }, item: { fg: "white" } },
  items: [
    "Set KITE Bridge Repetitions",
    "Set KITE Amount Range",
    "Set ETH Bridge Repetitions",
    "Set ETH Amount Range",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "blue" } },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  style: { fg: "white", bg: "blue", border: { fg: "white" }, hover: { bg: "green" }, focus: { bg: "green", border: { fg: "yellow" } } }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);
  dailyActivitySubMenu.top = menuBox.top;
  dailyActivitySubMenu.width = menuBox.width;
  dailyActivitySubMenu.height = menuBox.height;
  dailyActivitySubMenu.left = menuBox.left;
  configForm.width = Math.floor(screenWidth * 0.3);
  configForm.height = Math.floor(screenHeight * 0.4);
  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = isActivityRunning || (isScheduled && dailyActivityInterval !== null);
    const status = isActivityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isScheduled && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${privateKeys.length} | Auto Bridge KITE: ${dailyActivityConfig.kiteBridgeRepetitions}x | Auto Bridge ETH: ${dailyActivityConfig.ethBridgeRepetitions}x | KITEAI-BASE AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("    Address").padEnd(12)}         ${chalk.bold.cyan("KITE".padEnd(8))}   ${chalk.bold.cyan("ETH".padEnd(10))}`;
    const separator = chalk.gray("-".repeat(40));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    let menuItems = ["Set Manual Config", "Clear Logs", "Refresh", "Exit"];
    if (isActivityRunning) menuItems.unshift("Stop Current Activity");
    if (isScheduled && !isActivityRunning) menuItems.unshift("Cancel Scheduled Activity");
    if (!isActivityRunning && !isScheduled) menuItems.unshift("Start Auto Daily Activity");
    menuBox.setItems(menuItems);
    safeRender();
  } catch (error) {
    addLog(`Menu update error: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop or cancel the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Current Activity":
      shouldStop = true;
      addLog("Stopping current activity. Please wait for ongoing process to complete.", "info");
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          isActivityRunning = false;
          isCycleRunning = isScheduled;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog("Current activity stopped successfully.", "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Cancel Scheduled Activity":
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        isScheduled = false;
        isCycleRunning = false;
        addLog("Scheduled activity canceled.", "info");
        updateMenu();
        updateStatus();
        safeRender();
      }
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      addLog("Exiting application", "info");
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set KITE Bridge Repetitions":
      configForm.configType = "kiteBridgeRepetitions";
      configForm.setLabel(" Enter KITE Bridge Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.kiteBridgeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set KITE Amount Range":
      configForm.configType = "kiteRangeBridge";
      configForm.setLabel(" Enter KITE Amount Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.minKiteBridge.toString());
      configInputMax.setValue(dailyActivityConfig.maxKiteBridge.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          configInputMax.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set ETH Bridge Repetitions":
      configForm.configType = "ethBridgeRepetitions";
      configForm.setLabel(" Enter ETH Bridge Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.ethBridgeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set ETH Amount Range":
      configForm.configType = "ethRangeBridge";
      configForm.setLabel(" Enter ETH Amount Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.minEthBridge.toString());
      configInputMax.setValue(dailyActivityConfig.maxEthBridge.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          configInputMax.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;

configForm.on("submit", async () => {
  if (isSubmitting) return;
  isSubmitting = true;
  try {
    const inputValue = configInput.getValue();
    const maxInputValue = configInputMax.visible ? configInputMax.getValue() : null;

    if (!inputValue || inputValue.trim() === "") {
      addLog("Input cannot be empty. Please enter a valid number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      return;
    }

    let value, maxValue;
    try {
      value = parseFloat(inputValue.trim());
      if (configForm.configType === "kiteRangeBridge" || configForm.configType === "ethRangeBridge") {
        if (!maxInputValue || maxInputValue.trim() === "") {
          addLog("Max value cannot be empty. Please enter a valid number.", "error");
          configInputMax.clearValue();
          screen.focusPush(configInputMax);
          safeRender();
          return;
        }
        maxValue = parseFloat(maxInputValue.trim());
        if (isNaN(maxValue) || maxValue <= 0) {
          addLog("Invalid Max value. Please enter a positive number.", "error");
          configInputMax.clearValue();
          screen.focusPush(configInputMax);
          safeRender();
          return;
        }
      }
      if (isNaN(value) || value <= 0) {
        addLog("Invalid input. Please enter a positive number.", "error");
        configInput.clearValue();
        screen.focusPush(configInput);
        safeRender();
        return;
      }
    } catch (error) {
      addLog(`Invalid format: ${error.message}`, "error");
      configInput.clearValue();
      if (configInputMax.visible) configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      return;
    }

    if (configForm.configType === "kiteBridgeRepetitions") {
      dailyActivityConfig.kiteBridgeRepetitions = Math.floor(value);
      addLog(`KITE Bridge Repetitions set to ${dailyActivityConfig.kiteBridgeRepetitions}`, "success");
    } else if (configForm.configType === "kiteRangeBridge") {
      if (value > maxValue) {
        addLog("Min KITE cannot be greater than Max KITE.", "error");
        configInput.clearValue();
        configInputMax.clearValue();
        screen.focusPush(configInput);
        safeRender();
        return;
      }
      dailyActivityConfig.minKiteBridge = value;
      dailyActivityConfig.maxKiteBridge = maxValue;
      addLog(`KITE Amount Range set to ${dailyActivityConfig.minKiteBridge} - ${dailyActivityConfig.maxKiteBridge}`, "success");
    } else if (configForm.configType === "ethBridgeRepetitions") {
      dailyActivityConfig.ethBridgeRepetitions = Math.floor(value);
      addLog(`ETH Bridge Repetitions set to ${dailyActivityConfig.ethBridgeRepetitions}`, "success");
    } else if (configForm.configType === "ethRangeBridge") {
      if (value > maxValue) {
        addLog("Min ETH cannot be greater than Max ETH.", "error");
        configInput.clearValue();
        configInputMax.clearValue();
        screen.focusPush(configInput);
        safeRender();
        return;
      }
      dailyActivityConfig.minEthBridge = value;
      dailyActivityConfig.maxEthBridge = maxValue;
      addLog(`ETH Amount Range set to ${dailyActivityConfig.minEthBridge} - ${dailyActivityConfig.maxEthBridge}`, "success");
    }
    saveConfig();
    updateStatus();
    configForm.hide();
    dailyActivitySubMenu.show();
    setTimeout(() => {
      if (dailyActivitySubMenu.visible) {
        screen.focusPush(dailyActivitySubMenu);
        dailyActivitySubMenu.style.border.fg = "yellow";
        logBox.style.border.fg = "magenta";
        safeRender();
      }
    }, 100);
  } finally {
    isSubmitting = false;
    configInput.clearValue();
    if (configInputMax.visible) configInputMax.clearValue();
  }
});

configInput.key(["enter"], async () => {
  if (configForm.configType === "kiteRangeBridge" || configForm.configType === "ethRangeBridge") {
    screen.focusPush(configInputMax);
  } else {
    await configForm.submit();
    screen.focusPush(configSubmitButton);
  }
});

configInputMax.key(["enter"], async () => {
  await configForm.submit();
});

configSubmitButton.on("press", async () => {
  await configForm.submit();
});

configSubmitButton.on("click", async () => {
  await configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadPrivateKeys();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();