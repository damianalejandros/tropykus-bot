/**
 * Tropykus Liquidation Bot — Rootstock (RSK) Mainnet
 * Mercados: kDOC y kUSDRIF
 *
 * Prerequisitos:
 *   npm install ethers node-fetch dotenv
 *
 * Configuración:
 *   Crear archivo .env con PRIVATE_KEY y RPC_URL (ver abajo)
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

// ─── Configuración ────────────────────────────────────────────────────────────

const CONFIG = {
  rpcUrl: process.env.RPC_URL || "https://public-node.rsk.co",
  privateKey: process.env.PRIVATE_KEY, // NUNCA hardcodear — usar .env
  minProfitThreshold: parseFloat(process.env.MIN_PROFIT || "50"),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000"), // 30 seg
  graphqlUrl: "https://www.graphql1.tropykus.com/",
};

// ─── Contratos ────────────────────────────────────────────────────────────────

const MARKETS = {
  kDOC: {
    address: "0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2",
    underlying: "0xe700691da7b9851f2f35f8b8182c69c53ccad9db", // DOC
    name: "kDOC",
    decimals: 18,
  },
  kUSDRIF: {
    address: "0xDdf3CE45fcf080DF61ee61dac5Ddefef7ED4F46C",
    underlying: "0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37", // USDRIF
    name: "kUSDRIF",
    decimals: 18,
  },
  kRBTC: {
    address: "0x0aeadb9d4c6a80462a47e87e76e487fa8b9a37d7",
    name: "kRBTC",
    decimals: 18,
  },
  kBPRO: {
    address: "0x405062731d8656af5950ef952be9fa110878036b",
    name: "kBPRO",
    decimals: 18,
  },
};

// ABI mínimo de Compound/Tropykus para liquidación
const KTOKEN_ABI = [
  // Liquidar deuda en mercados ERC-20
  "function liquidateBorrow(address borrower, uint repayAmount, address cTokenCollateral) external returns (uint)",
  // Para mercados RBTC (ether)
  "function liquidateBorrow(address borrower, address cTokenCollateral) external payable returns (uint)",
  // Consultar factor de cierre máximo
  "function closeFactorMantissa() view returns (uint)",
  // Obtener snapshot del borrower
  "function getAccountSnapshot(address account) view returns (uint, uint, uint, uint)",
  // Balance de tokens subyacentes
  "function borrowBalanceCurrent(address account) external returns (uint)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ─── GraphQL ──────────────────────────────────────────────────────────────────

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
        is_attacker: { equals: false },
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const prefix = { INFO: "ℹ️ ", WARN: "⚠️ ", ERROR: "❌", OK: "✅", EXEC: "🔥" }[level] || "  ";
  console.log(`[${ts}] ${prefix} ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function getMarketByName(name) {
  // El nombre en GraphQL puede venir como "DOC", "kDOC", "USDRIF", "kUSDRIF", etc.
  const normalized = name.toLowerCase().replace("k", "");
  return Object.values(MARKETS).find(
    (m) =>
      m.name.toLowerCase() === name.toLowerCase() ||
      m.name.toLowerCase().replace("k", "") === normalized
  );
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function fetchLiquidationOpportunities() {
  const res = await fetch(CONFIG.graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: GRAPHQL_VARIABLES,
    }),
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  return json.data.findManyUser_balances || [];
}

async function approveSpendinIfNeeded(tokenContract, spenderAddress, amount, signer) {
  const owner = await signer.getAddress();
  const allowance = await tokenContract.allowance(owner, spenderAddress);
  if (allowance < amount) {
    log("INFO", `Aprobando gasto en token ${tokenContract.target}...`);
    const tx = await tokenContract.approve(spenderAddress, ethers.MaxUint256);
    await tx.wait();
    log("OK", "Aprobación confirmada.");
  }
}

async function executeLiquidation(opportunity, provider, signer) {
  const { users, markets, borrows } = opportunity;
  const borrowerAddress = users.address_lowercase;
  const marketName = markets.name;
  const profit = parseFloat(users.liquidation_profit);

  log("EXEC", `Ejecutando liquidación`, {
    borrower: borrowerAddress,
    market: marketName,
    profit,
    borrows,
  });

  // Identificar el mercado deudor
  const debtMarket = getMarketByName(marketName);
  if (!debtMarket) {
    log("WARN", `Mercado desconocido: ${marketName} — saltando.`);
    return null;
  }

  // El colateral a cobrar: preferir kRBTC, luego cualquier otro disponible
  // En una implementación más robusta, esto se consultaría on-chain
  const collateralMarket = MARKETS.kRBTC;

  const kTokenContract = new ethers.Contract(debtMarket.address, KTOKEN_ABI, signer);

  // Calcular repayAmount: se liquida hasta el 50% de la deuda (close factor típico)
  // borrows viene en la unidad del token subyacente
  const borrowAmount = ethers.parseUnits(
    parseFloat(borrows).toFixed(debtMarket.decimals),
    debtMarket.decimals
  );
  const repayAmount = borrowAmount / 2n; // 50% close factor

  try {
    // Si el mercado tiene token subyacente ERC-20 (DOC, USDRIF), aprobar gasto
    if (debtMarket.underlying) {
      const underlyingContract = new ethers.Contract(
        debtMarket.underlying,
        ERC20_ABI,
        signer
      );

      // Verificar balance propio
      const myBalance = await underlyingContract.balanceOf(await signer.getAddress());
      if (myBalance < repayAmount) {
        log("WARN", `Balance insuficiente de ${debtMarket.name}. Tenés: ${ethers.formatUnits(myBalance, debtMarket.decimals)}, necesitás: ${ethers.formatUnits(repayAmount, debtMarket.decimals)}`);
        return null;
      }

      await approveSpendinIfNeeded(
        underlyingContract,
        debtMarket.address,
        repayAmount,
        signer
      );

      const gasEstimate = await kTokenContract.liquidateBorrow.estimateGas(
        borrowerAddress,
        repayAmount,
        collateralMarket.address
      );

      log("INFO", `Gas estimado: ${gasEstimate.toString()}`);

      const tx = await kTokenContract.liquidateBorrow(
        borrowerAddress,
        repayAmount,
        collateralMarket.address,
        { gasLimit: (gasEstimate * 120n) / 100n } // +20% buffer
      );

      log("INFO", `Transacción enviada: ${tx.hash}`);
      const receipt = await tx.wait();
      log("OK", `Liquidación confirmada en bloque ${receipt.blockNumber}`, {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed.toString(),
        borrower: borrowerAddress,
        profit,
      });

      return receipt;
    }
  } catch (err) {
    log("ERROR", `Fallo en liquidación de ${borrowerAddress}: ${err.message}`);
    return null;
  }
}

// ─── Loop principal ───────────────────────────────────────────────────────────

async function runBot() {
  if (!CONFIG.privateKey) {
    log("ERROR", "PRIVATE_KEY no configurada en .env — abortando.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const signer = new ethers.Wallet(CONFIG.privateKey, provider);
  const botAddress = await signer.getAddress();

  log("OK", `Bot iniciado`, {
    address: botAddress,
    rpc: CONFIG.rpcUrl,
    minProfit: CONFIG.minProfitThreshold,
    pollIntervalSeg: CONFIG.pollIntervalMs / 1000,
  });

  // Verificar balance de RBTC para gas
  const rbtcBalance = await provider.getBalance(botAddress);
  log("INFO", `Balance RBTC disponible: ${ethers.formatEther(rbtcBalance)} RBTC`);
  if (rbtcBalance < ethers.parseEther("0.001")) {
    log("WARN", "Balance de RBTC bajo — puede no haber suficiente gas.");
  }

  let cycle = 0;

  async function poll() {
    cycle++;
    log("INFO", `─── Ciclo #${cycle} ───`);

    let opportunities = [];
    try {
      opportunities = await fetchLiquidationOpportunities();
      log("INFO", `${opportunities.length} posición(es) en liquidación encontrada(s).`);
    } catch (err) {
      log("ERROR", `Error consultando GraphQL: ${err.message}`);
      return;
    }

    // Filtrar por profit mínimo
    const eligible = opportunities.filter(
      (o) => parseFloat(o.users?.liquidation_profit || 0) >= CONFIG.minProfitThreshold
    );

    if (eligible.length === 0) {
      log("INFO", `Sin oportunidades con profit ≥ ${CONFIG.minProfitThreshold}`);
      return;
    }

    log("OK", `${eligible.length} oportunidad(es) elegible(s):`);
    eligible.forEach((o) => {
      log("INFO", `  • ${o.users.address_lowercase} | ${o.markets.name} | profit: ${o.users.liquidation_profit}`);
    });

    // Ejecutar liquidaciones ordenadas por mayor profit primero
    const sorted = [...eligible].sort(
      (a, b) =>
        parseFloat(b.users.liquidation_profit) -
        parseFloat(a.users.liquidation_profit)
    );

    for (const opp of sorted) {
      await executeLiquidation(opp, provider, signer);
    }
  }

  // Ejecutar inmediatamente y luego en loop
  await poll();
  setInterval(poll, CONFIG.pollIntervalMs);
}

runBot().catch((err) => {
  log("ERROR", `Error fatal: ${err.message}`);
  process.exit(1);
});
