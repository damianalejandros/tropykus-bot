/**
 * Tropykus Liquidation Bot — Rootstock (RSK) Mainnet
 * Mercados deuda: kDOC, kUSDRIF
 * Colateral preferido: kRBTC → kBPRO (el que tenga mayor balance en el borrower)
 * Alertas: Telegram
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const CONFIG = {
  rpcUrl:         process.env.RPC_URL || "https://public-node.rsk.co",
  privateKey:     process.env.PRIVATE_KEY,
  minProfitUSD:   parseFloat(process.env.MIN_PROFIT || "50"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000"),
  graphqlUrl:     process.env.GRAPHQL_URL || "https://graphql1.tropykus.com/",
  telegramToken:  process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

const MARKETS = {
  kDOC: {
    address:    "0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2",
    underlying: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
    name:       "kDOC",
    decimals:   18,
  },
  kUSDRIF: {
    address:    "0xDdf3CE45fcf080DF61ee61dac5Ddefef7ED4F46C",
    underlying: "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37",
    name:       "kUSDRIF",
    decimals:   18,
  },
  kRBTC: {
    address:  "0x0aeadb9d4c6a80462a47e87e76e487fa8b9a37d7",
    name:     "kRBTC",
    decimals: 18,
  },
  kBPRO: {
    address:    "0x405062731d8656af5950ef952be9fa110878036b",
    underlying: "0x440cd83c160de5c96ddb20246815ea44c7abbca8",
    name:       "kBPRO",
    decimals:   18,
  },
};

const COLLATERAL_OPTIONS = [MARKETS.kRBTC, MARKETS.kBPRO];

const KTOKEN_ABI = [
  "function liquidateBorrow(address borrower, uint repayAmount, address cTokenCollateral) external returns (uint)",
  "function getAccountSnapshot(address account) view returns (uint, uint, uint, uint)",
  "function borrowBalanceCurrent(address account) external returns (uint)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const GRAPHQL_QUERY = `
  query FindManyUser_balances($where: User_balancesWhereInput) {
    findManyUser_balances(where: $where) {
      markets { name }
      deposits
      brute_deposits
      clean_deposits_timestamp
      borrows
      brute_borrows
      clean_borrows_timestamp
      users {
        address_lowercase
        net_liquidity
        liquidation_profit
      }
    }
  }
`;

const GRAPHQL_VARIABLES = {
  where: {
    users: {
      is: {
        is_attacker:       { equals: false },
        is_in_liquidation: { equals: true },
      },
    },
    markets: {
      is: {
        is_listed: { equals: true },
      },
    },
  },
};

function log(level, msg, data = null) {
  const ts   = new Date().toISOString();
  const icon = { INFO: "ℹ️ ", WARN: "⚠️ ", ERROR: "❌", OK: "✅", EXEC: "🔥" }[level] || "  ";
  console.log(`[${ts}] ${icon} ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

async function sendTelegram(msg) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return;
  try {
    const f = await import("node-fetch");
    const fetchFn = f.default;
    await fetchFn(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:    CONFIG.telegramChatId,
        text:       msg,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    log("WARN", `No se pudo enviar alerta a Telegram: ${err.message}`);
  }
}

function getMarketByName(name) {
  const n = name.toLowerCase();
  return Object.values(MARKETS).find(
    (m) =>
      m.name.toLowerCase() === n ||
      m.name.toLowerCase().replace("k", "") === n.replace("k", "")
  );
}

async function approveIfNeeded(underlyingAddress, spender, amount, signer) {
  const token     = new ethers.Contract(underlyingAddress, ERC20_ABI, signer);
  const owner     = await signer.getAddress();
  const allowance = await token.allowance(owner, spender);
  if (allowance < amount) {
    log("INFO", `Aprobando gasto de token ${underlyingAddress}...`);
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    log("OK", "Aprobación confirmada.");
  }
}

async function chooseBestCollateral(borrowerAddress, provider) {
  let best        = MARKETS.kRBTC;
  let bestBalance = 0n;

  for (const market of COLLATERAL_OPTIONS) {
    try {
      const kToken = new ethers.Contract(market.address, KTOKEN_ABI, provider);
      const [, kBalance] = await kToken.getAccountSnapshot(borrowerAddress);
      log("INFO", `  Colateral ${market.name} del borrower: ${kBalance.toString()} kTokens`);
      if (kBalance > bestBalance) {
        bestBalance = kBalance;
        best        = market;
      }
    } catch (err) {
      log("WARN", `  No se pudo consultar ${market.name}: ${err.message}`);
    }
  }

  if (bestBalance === 0n) {
    log("WARN", "  Borrower sin colateral en kRBTC ni kBPRO — usando kRBTC como fallback.");
  } else {
    log("INFO", `  Colateral elegido: ${best.name}`);
  }

  return best;
}

async function executeLiquidation(opportunity, provider, signer) {
  const { users, markets, borrows } = opportunity;
  const borrower   = users.address_lowercase;
  const profitUSD  = parseFloat(users.liquidation_profit);
  const marketName = markets.name;

  log("EXEC", `Iniciando liquidación`, { borrower, market: marketName, profitUSD });
  await sendTelegram(
    `🔥 <b>Liquidación detectada</b>\n` +
    `Borrower: <code>${borrower}</code>\n` +
    `Mercado: ${marketName}\n` +
    `Profit estimado: <b>$${profitUSD.toFixed(2)} USD</b>`
  );

  const debtMarket = getMarketByName(marketName);
  if (!debtMarket) {
    log("WARN", `Mercado desconocido: "${marketName}" — saltando.`);
    return;
  }

  const collateralMarket = await chooseBestCollateral(borrower, provider);
  const kTokenContract   = new ethers.Contract(debtMarket.address, KTOKEN_ABI, signer);

  let repayAmount;
  try {
    const borrowBalance = await kTokenContract.borrowBalanceCurrent(borrower);
    repayAmount = borrowBalance / 2n;
    log("INFO", `Deuda on-chain: ${ethers.formatUnits(borrowBalance, debtMarket.decimals)} | Repago (50%): ${ethers.formatUnits(repayAmount, debtMarket.decimals)}`);
  } catch (err) {
    log("WARN", `borrowBalanceCurrent falló, usando valor de GraphQL. Error: ${err.message}`);
    repayAmount = ethers.parseUnits(
      (parseFloat(borrows) / 2).toFixed(debtMarket.decimals),
      debtMarket.decimals
    );
  }

  if (repayAmount === 0n) {
    log("WARN", "repayAmount = 0 — saltando.");
    return;
  }

  try {
    if (debtMarket.underlying) {
      const token     = new ethers.Contract(debtMarket.underlying, ERC20_ABI, signer);
      const myBalance = await token.balanceOf(await signer.getAddress());

      if (myBalance < repayAmount) {
        const msg = `Balance insuficiente de ${debtMarket.name}. Tenés: ${ethers.formatUnits(myBalance, debtMarket.decimals)}, necesitás: ${ethers.formatUnits(repayAmount, debtMarket.decimals)}`;
        log("WARN", msg);
        await sendTelegram(`⚠️ <b>Balance insuficiente</b>\n${msg}`);
        return;
      }

      await approveIfNeeded(debtMarket.underlying, debtMarket.address, repayAmount, signer);
    }

    let gasLimit;
    try {
      const estimated = await kTokenContract.liquidateBorrow.estimateGas(
        borrower, repayAmount, collateralMarket.address
      );
      gasLimit = (estimated * 130n) / 100n;
      log("INFO", `Gas estimado: ${estimated} → con buffer: ${gasLimit}`);
    } catch (err) {
      gasLimit = 600000n;
      log("WARN", `estimateGas falló — usando límite fijo ${gasLimit}. Error: ${err.message}`);
    }

    const tx = await kTokenContract.liquidateBorrow(
      borrower,
      repayAmount,
      collateralMarket.address,
      { gasLimit }
    );

    log("INFO", `Tx enviada: ${tx.hash}`);
    const receipt = await tx.wait();

    log("OK", `Liquidación exitosa`, {
      txHash:    tx.hash,
      block:     receipt.blockNumber,
      gasUsed:   receipt.gasUsed.toString(),
      borrower,
      deudaEn:   debtMarket.name,
      colateral: collateralMarket.name,
      profitUSD: `$${profitUSD}`,
    });

    await sendTelegram(
      `✅ <b>Liquidación exitosa 🎉</b>\n` +
      `Borrower: <code>${borrower}</code>\n` +
      `Deuda en: ${debtMarket.name}\n` +
      `Colateral cobrado: ${collateralMarket.name}\n` +
      `Profit: <b>$${profitUSD.toFixed(2)} USD</b>\n` +
      `Bloque: ${receipt.blockNumber}\n` +
      `Tx: <code>${tx.hash}</code>`
    );

  } catch (err) {
    log("ERROR", `Liquidación fallida para ${borrower}: ${err.message}`);
    await sendTelegram(
      `❌ <b>Liquidación fallida</b>\n` +
      `Borrower: <code>${borrower}</code>\n` +
      `Error: ${err.message}`
    );
  }
}

async function fetchOpportunities() {
  const f = await import("node-fetch");
  const fetchFn = f.default;
  const res = await fetchFn(CONFIG.graphqlUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ query: GRAPHQL_QUERY, variables: GRAPHQL_VARIABLES }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data.findManyUser_balances || [];
}

async function runBot() {
  if (!CONFIG.privateKey) {
    log("ERROR", "PRIVATE_KEY no configurada en .env — abortando.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const signer   = new ethers.Wallet(CONFIG.privateKey, provider);
  const botAddr  = await signer.getAddress();

  log("OK", "Bot iniciado", {
    wallet:          botAddr,
    rpc:             CONFIG.rpcUrl,
    minProfitUSD:    `$${CONFIG.minProfitUSD}`,
    pollIntervalSeg: CONFIG.pollIntervalMs / 1000,
    colateralPref:   COLLATERAL_OPTIONS.map((m) => m.name).join(" → "),
    telegram:        CONFIG.telegramToken ? "configurado" : "no configurado",
  });

  const rbtcBal = await provider.getBalance(botAddr);
  log("INFO", `Balance RBTC para gas: ${ethers.formatEther(rbtcBal)} RBTC`);

  if (rbtcBal < ethers.parseEther("0.001")) {
    log("WARN", "Balance de RBTC bajo — puede no haber suficiente gas.");
    await sendTelegram(`⚠️ <b>Balance RBTC bajo</b>\nEl bot tiene ${ethers.formatEther(rbtcBal)} RBTC — puede quedarse sin gas pronto.`);
  }

  await sendTelegram(
    `🤖 <b>Tropykus Bot iniciado</b>\n` +
    `Wallet: <code>${botAddr}</code>\n` +
    `Profit mínimo: $${CONFIG.minProfitUSD} USD\n` +
    `Polling: cada ${CONFIG.pollIntervalMs / 1000}s`
  );

  let cycle = 0;

  async function poll() {
    cycle++;
    log("INFO", `─── Ciclo #${cycle} ───`);

    let opportunities;
    try {
      opportunities = await fetchOpportunities();
      log("INFO", `${opportunities.length} posición(es) con is_in_liquidation = true.`);
    } catch (err) {
      log("ERROR", `Error consultando GraphQL: ${err.message}`);
      return;
    }

    const eligible = opportunities
      .filter((o) => parseFloat(o.users?.liquidation_profit || 0) >= CONFIG.minProfitUSD)
      .sort((a, b) => parseFloat(b.users.liquidation_profit) - parseFloat(a.users.liquidation_profit));

    if (eligible.length === 0) {
      log("INFO", `Sin oportunidades con profit >= $${CONFIG.minProfitUSD} USD`);
      return;
    }

    log("OK", `${eligible.length} oportunidad(es) elegible(s):`);
    eligible.forEach((o) =>
      log("INFO", `  * ${o.users.address_lowercase} | ${o.markets.name} | profit: $${o.users.liquidation_profit} USD`)
    );

    for (const opp of eligible) {
      await executeLiquidation(opp, provider, signer);
    }
  }

  await poll();
  setInterval(poll, CONFIG.pollIntervalMs);
}

runBot().catch((err) => {
  log("ERROR", `Error fatal: ${err.message}`);
  process.exit(1);
});
