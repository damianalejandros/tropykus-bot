# Tropykus Liquidation Bot

Bot automático que monitorea oportunidades de liquidación en Tropykus (Rootstock/RSK) y las ejecuta cuando el profit estimado supera el umbral configurado.

## Cómo funciona

1. Consulta la API GraphQL de Tropykus cada N segundos
2. Filtra posiciones con `is_in_liquidation: true` y `profit >= MIN_PROFIT`
3. Para cada oportunidad elegible, llama a `liquidateBorrow()` en el contrato kDOC o kUSDRIF
4. Cobra el colateral (kRBTC por defecto) como ganancia

---

## Instalación local (para probar)

```bash
# Clonar o copiar los archivos
cd tropykus-bot

# Instalar dependencias
npm install

# Configurar variables
cp .env.example .env
# Editar .env con tu PRIVATE_KEY

# Correr
npm start
```

---

## Deploy en Railway (recomendado — $5/mes)

1. Crear cuenta en https://railway.app
2. Nuevo proyecto → "Deploy from GitHub repo"
3. Subir el código a un repo privado de GitHub (sin el `.env`)
4. En Railway → Variables → agregar:
   - `PRIVATE_KEY` = tu clave privada
   - `RPC_URL` = https://public-node.rsk.co
   - `MIN_PROFIT` = 50
   - `POLL_INTERVAL_MS` = 30000
5. Railway detecta `package.json` y hace `npm start` automáticamente

---

## Deploy en Render (alternativa gratuita con limitaciones)

1. Crear cuenta en https://render.com
2. Nuevo "Background Worker" (no web service)
3. Conectar repo de GitHub
4. Build command: `npm install`
5. Start command: `node bot.js`
6. Agregar variables de entorno igual que Railway

---

## Deploy en VPS (DigitalOcean/Vultr — $4/mes, más control)

```bash
# En el servidor
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Subir archivos (scp o git clone)
scp -r tropykus-bot/ user@tu-servidor:/home/user/

# Instalar PM2 para que corra siempre
sudo npm install -g pm2
cd tropykus-bot
npm install
cp .env.example .env && nano .env  # completar PRIVATE_KEY

# Iniciar con PM2
pm2 start bot.js --name tropykus-bot
pm2 save
pm2 startup  # para que arranque automático al reiniciar el servidor

# Ver logs en tiempo real
pm2 logs tropykus-bot
```

---

## Seguridad

- La wallet del bot solo necesita el saldo de tokens que va a liquidar (DOC/USDRIF) + un poco de RBTC para gas
- Nunca pongas más fondos de los necesarios
- Usá un RPC privado (NOWNodes, GetBlock) si querés más velocidad y privacidad que el nodo público
- Nunca subas `.env` a GitHub — está en `.gitignore` por defecto

---

## Variables de entorno

| Variable | Descripción | Default |
|---|---|---|
| `PRIVATE_KEY` | Clave privada de la wallet (obligatorio) | — |
| `RPC_URL` | Endpoint RPC de RSK | `https://public-node.rsk.co` |
| `MIN_PROFIT` | Profit mínimo para liquidar | `50` |
| `POLL_INTERVAL_MS` | Intervalo de polling en ms | `30000` |

---

## Contratos (RSK Mainnet)

| Contrato | Dirección |
|---|---|
| kDOC | `0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2` |
| kUSDRIF | `0xDdf3CE45fcf080DF61ee61dac5Ddefef7ED4F46C` |
| kRBTC | `0x0aeadb9d4c6a80462a47e87e76e487fa8b9a37d7` |
| DOC (subyacente) | `0xe700691da7b9851f2f35f8b8182c69c53ccad9db` |
| USDRIF (subyacente) | `0x3a15461d8ae0f0fb5fa2629e9da7d66a794a6e37` |
