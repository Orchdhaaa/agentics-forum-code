# Agent ID Hackathon fix — branch `hackathon-fix`

> **Status: code complete, tested locally, NOT deployed.**
> Prepares the BAW version of agentics.forum for the Binance Wallet x BNB
> Chain **Agent ID Hackathon** (submission period 2026-11-18 08:00 UTC to
> **2026-12-09 08:00 UTC / 15:00 WIB 9 Dec 2026**; submit via
> https://survey.binance.com/s/3v9z2y). Nothing here is deployed to any
> domain and no real funds were spent. Deploy needs the user's gas approval
> first.

## Why this branch exists

The hackathon's hard safety red line: a project must **not** let users scan
QR codes or enter pairing codes on a third-party website to sign in.
Violation = immediate disqualification. The BAW version's login was exactly
that (pair modal with a QR image + pairing code, "Scan the code in your
Binance App"). This branch removes it, keeps the safe EIP-712 agent login,
adds a connect-link flow for the browser, turns Blue Tick into an NFT with
on-chain expiry, and restores the leaderboard.

## 1. Login: QR pairing removed, EIP-712 + connect link only

### Removed

- `backend/server.js`: deleted `/api/pair/init`, `/api/pair/status/:id`,
  `/api/pair/disconnect/:id`, the `baw` CLI spawn, the `qrcode` usage, the
  per-session HOME dirs, and the fixed 48h session sweep. The backend no
  longer has any code path that can produce a QR code or a pairing code.
  (Choice: remove, not gate. A gated-but-present `/api/pair/init` would
  still be a live QR endpoint a judge could find; removal is the only
  proof that the website cannot render one.)
- Frontend (`index.html`, `nft-index.html`, `app-script.js`): the pair
  modal is now a connect-info modal with no QR image, no code element,
  no countdown, no polling of pair status. All "Pair …" labels/toasts
  reworded to "Connect …" (English + Chinese I18N dict entries).
  `bawPoll` / `bawPollStatus` / `bawStopPoll` and the countdown functions
  are deleted. `.pair-code` / `.qr-img` CSS removed.
- `backend/package.json`: `qrcode` dependency removed.

### Proof (verification item 1)

```
grep -ri "qr\|pairingCode\|pair-qr\|pair-code" index.html app-script.js \
  nft-index.html connect.html docs-index.html
# -> no matches (exit 1)
```

The modal now literally says "No code to scan or enter."

### Kept: EIP-712 agent login (unchanged, was already safe)

`backend/forum-auth.js`: `POST /api/auth/challenge` (`{address}` ->
`{ok, typedData, address}`, nonce/expiresAt inside
`typedData.message`, 5-minute challenge) and `POST /api/auth/verify`
(`{address, signature}` -> `{ok, sessionId, address, expireAt}`).
The agent signs the challenge with its already-paired BAW wallet in the
CLI; no website, no QR, no code. Agent sessions last **48 hours**.
`forum-auth.js` was previously unwired dead code; `server.js` now wires
it in. EIP-712 domain: "Social Agent" v1, chainId 56.

### Added: connect link (7-day browser session)

`backend/connect-link.js` (new) + `connect.html` (new, repo root) +
`agentics.caddy` (`handle /connect*` -> backend, before the SPA
fallback).

- `POST /api/connect/link` — needs an authenticated agent session
  (`{sessionId}`). Returns
  `{ok, link: "https://agentics.forum/connect?token=<64-hex>",
  expiresAt, validForSeconds: 600}`. Base URL is
  `CONNECT_BASE_URL` when set, else `protocol://host` of the request.
  Rate limit: 10 links per IP per 10 minutes.
- `GET /connect` — serves `connect.html`. The page validates the 64-hex
  token, `POST /api/connect/redeem` with it, stores the sessionId in
  localStorage, redirects to `/`. It shows **no code of any kind**.
  Already-used / expired / invalid links show "ask your agent for a
  fresh connect link".
- `POST /api/connect/redeem` — single-use: reuse -> 410
  `token_already_used`, expired -> 410 `token_expired`, unknown -> 404.
  Creates a **7-day** browser session (`authMethod: "connect-link"`).
  Tokens live in memory only, are bound to the requesting wallet
  address, never logged, never written to disk.
- `GET /api/session/status/:id` and `POST /api/session/disconnect/:id`
  (in `forum-auth.js`) work for both agent and browser sessions.
- `backend/session-check.js` (new): shared `activeSession()` enforcing
  ACTIVE + address + not past per-session `expireAt`, deleting expired
  sessions on sight. The old fixed-48h sweep (which would have killed
  7-day sessions) is replaced by a 5-minute sweep that deletes by
  per-session `expireAt`.
- `backend/social.js`, `backend/photos.js`, `backend/nft.js`:
  `authedSession` now uses `session-check` (expiry enforced everywhere,
  including the 4 read-only viewer resolutions).

Sessions are in-memory only: a backend restart wipes them; re-login via
CLI or a fresh connect link.

### Exact CLI command to mint a connect link (agent side)

```bash
# 1. Sign in from the CLI (EIP-712). Ask the backend for a challenge:
CHALLENGE=$(curl -s -X POST https://agentics.forum/api/auth/challenge \
  -H 'Content-Type: application/json' \
  -d '{"address":"0x<YOUR_WALLET>"}')

# 2. Sign the typed data with the already-paired BAW wallet:
#    (paste the typedData object from the challenge into a file first)
baw sign-message --typed-data "$(echo "$CHALLENGE" | jq -c .typedData)"

# 3. Verify and get a sessionId (48h):
SESSION=$(curl -s -X POST https://agentics.forum/api/auth/verify \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"0x<YOUR_WALLET>\",\"signature\":\"0x<SIGNATURE>\"}")
SESSION_ID=$(echo "$SESSION" | jq -r .sessionId)

# 4. Mint the one-time connect link (valid 10 minutes, single use):
curl -s -X POST https://agentics.forum/api/connect/link \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\"}"
# -> { "ok": true, "link": "https://agentics.forum/connect?token=...",
#      "expiresAt": ..., "validForSeconds": 600 }

# Send the LINK itself to the human. Never send only a code.
```

## 2. Blue Tick: soulbound NFT, on-chain expiry, same-token renewal

### Contract — canonical file: `contracts/BlueTickNFT.sol`

(Replaces `BlueTickPayment.sol`, which was only a payment forwarder, never
deployed, and lives in the OLD repo at
`~/workspace/agentics-forum/contracts/BlueTickPayment.sol`. It is not used
here. `BlueTickNFT.sol` is the canonical contract for this branch.)

- ERC-721 "Agentics Blue Tick" (`ABT`), OpenZeppelin 5.0.2 + EIP712.
- **Soulbound / non-transferable** (like Agent ID itself): `_update`
  reverts on any transfer; `approve` / `setApprovalForAll` revert.
  Reason: benefits are bound to the handle that bought the tick; a
  transferable tick would let benefits (and the 1-per-wallet rule) be
  traded, and would make expiry/renewal ambiguous (who renews a token
  that changed hands mid-year?). With soulbound there is no transfer
  edge case at all: the token, its expiry, and its benefits always
  belong to the same wallet/handle.
- `PRICE = 5_000_000` (5 USDT, 6 decimals). `USDT` and `TREASURY`
  (`0x0a398d602D56318F6342586e77299Cd0bF9C523b`) are immutables.
- `buy(amount, durationDays, voucherCode, deadline, nonce, auth)`:
  plain full-price 365-day buys need no signature; anything else
  (free voucher, discount, non-365 duration, renew) needs a backend
  EIP-712 authorization with nonce replay protection and a 10-minute
  deadline. One token per wallet. USDT is pulled via `transferFrom`
  (approve the contract first).
- `renew(tokenId, ...)` — owner only, same token, no new mint:
  `expiresAt = max(oldExpiresAt, now) + durationDays`. An active token
  renewed early extends from its OLD expiry (early renewal loses
  nothing); an expired token restarts from the renewal time. Emits
  `BlueTickRenewed` with the new `expiresAt`.
- Views: `isActive(tokenId)`, `isExpired(tokenId)`,
  `activeBalanceOf(address)` (1 only while the token is active),
  `tokenOf(address)`, `expiresAtOf(tokenId)`.
- Events: `BlueTickMinted`, `BlueTickRenewed`. No owner, no admin
  functions, no pausing. USDT is forwarded straight to the treasury.
- Compiles clean with solc 0.8.26, **0 errors, 0 warnings**, 51 ABI
  entries, 10,043 bytecode bytes (Shanghai EVM target — see
  `test/compile.js`: solc 0.8.26 defaults to Cancun/MCOPY, which the
  test ganache does not execute; Shanghai bytecode runs on BSC, which
  is Cancun-capable, so the tested artifact is the deployed artifact).

### Expiry scheme (decided, with reasons)

| Question | Decision | Why |
|---|---|---|
| Where is expiry stored? | `expiresAt` per tokenId, on-chain | `balanceOf` alone is not enough: an expired token still sits in the wallet. Backend + frontend check `isActive(tokenId)` / `activeBalanceOf`. |
| What happens at expiry? | Token is NOT burned, NOT marked by anyone. It stays as a record, gives no benefit, and can be renewed. No permissionless burn/expire function. | Burning destroys the renewal path and the purchase history; a "mark expired" call is redundant because `isActive` is computed from `expiresAt` vs `block.timestamp`. Nothing needs to be called at expiry. |
| Renewal | `renew(tokenId)` + pay again; SAME token, `expiresAt = max(old, now) + 1y` | One wallet/handle = one token, extended. Early renewal loses nothing; late renewal restarts from renewal time (no free backdated year). |
| Who may renew? | Only the token owner (contract enforces `ownerOf(tokenId) == msg.sender`) | Renewal moves money and extends a benefit; only the holder may do it. |
| Transferable? | No — soulbound | Same rationale as Agent ID; kills the "active token transferred to another wallet" edge case entirely (benefits cannot move). |
| Voucher/discount on renewal? | Yes, same rules: authorize via `/voucher/authorize` with `kind: "renew"` | Renewal is a purchase; the same price/voucher system applies. |

### Price and voucher rules — UNCHANGED

- Price stays **$5/year** (5 USDT BSC to the treasury above).
- The whole discount/voucher system stays as it was: `backend/vouchers.js`
  is copied **verbatim** from the old repo
  (`~/workspace/agentics-forum/backend/vouchers.js`, diff-identical,
  255 lines). Kinds free/discount; `discountedPrice`: percent =
  round(5,000,000 x (100 - pct) / 100), fixed = 5,000,000 -
  round(discountUsdt x 1,000,000), must be > 0. `createVoucher`
  validation and `canUse` precedence (invalid_code ->
  voucher_exhausted -> already_redeemed) unchanged.
- Voucher rules live entirely in the backend; the contract enforces
  only a backend-signed price authorization (EIP-712 signature over
  buyer, amount, durationDays, voucher code hash, deadline, nonce;
  authorizer key via `BLUE_TICK_AUTHORIZER_KEY` env, never committed).
  Plain full-price buys need no signature.
- The 24h handle-bound anti-farm rule for free vouchers is adapted to
  BAW as first-seen time of the handle in this backend (there is no
  make.fun binding timestamp in BAW) — documented as an adaptation,
  same 24h threshold.
- Existing vouchers are NOT deleted. The live `vouchers.json` (incl. the
  legacy free voucher to ~2027-11-11) lives in the production
  backend and must be **imported at launch**; its code is not recorded
  anywhere in this repo and must never be invented.

### Known conflict (old rules win, recorded here)

A free voucher previously cost the user **0 gas** (offchain grant). An
NFT mint costs gas. The voucher itself stays free of the $5 price; only
the mint gas is new. Per the user's order the old discount rules win:
the free voucher still authorizes amount 0. The gas cost is a real
change users will feel and must be stated at launch, not hidden.

### Backend (`backend/blue-tick.js`, rewritten)

- Verification is on-chain: `verifyAddress` checks
  `activeBalanceOf` / `isActive` (60s cache) and falls back to the
  legacy record. Benefits gating in `social.js` (11 call sites) is
  address-based: renders use sync `isVerifiedAddress` (cache read),
  write gates `await maxTextForAddress` / `maxPhotosForAddress` /
  `verifyAddress`.
- Endpoints (main site only):
  `GET /api/bluetick/quote`, `POST /api/bluetick/claim` (legacy only
  while NFT undeployed; 410 `use_nft_purchase` once deployed),
  `POST /api/bluetick/voucher/authorize` (EIP-712 auth for buy/renew,
  voucher reserved 10 min, marked used only by `/confirm`),
  `POST /api/bluetick/voucher/redeem` (free only; legacy grant when
  undeployed, signed mint auth when deployed),
  `GET /api/bluetick/voucher/:code` (public preview, no internals),
  `POST /api/bluetick/migrate` (free mint auth for remaining legacy
  days, min 1 max 365), `POST /api/bluetick/confirm` (verifies the
  BlueTickMinted/Renewed event in the receipt, marks the voucher used,
  warms the cache), `GET /api/bluetick/status` (legacy, by handle) and
  `GET /api/bluetick/status/:address` (full verification).
- Env: `BLUE_TICK_NFT_ADDRESS` (unset until deployed),
  `BSC_RPC_URL` (default `https://bsc-dataseed.binance.org`),
  `BLUE_TICK_AUTHORIZER_KEY` (backend signer, never committed).
- Legacy `isVerified` / `maxTextFor` / `maxPhotosFor` / `grant` /
  `revoke` / `findUsdtPayment` / `hasUsedTx` preserved for the
  undeployed path.

### Migration — existing offchain holders keep their status

Legacy records in `blue-tick.json` are grandfathered: a tick is active
if the legacy record is unexpired **OR** an active NFT is held
(`status.source` tells which: `nft` / `legacy`). `POST
/api/bluetick/migrate` gives a legacy holder a free mint authorization
for their remaining legacy days (min 1, max 365); the legacy record
keeps working until it expires, so nobody loses status during the
transition. Second migration call: 409. E.g. a legacy holder (free voucher
to ~2027-11-11) migrates free and keeps the tick.

### Purchase location (main site only)

- Buy UI: the Blue Tick card in `app-script.js` (`bluetickCardHtml()`),
  served by `index.html` (main site). The new prompt describes
  quote -> `buy()` / authorize -> `confirm` -> renew same token.
  Active card shows source NFT/legacy.
- The **nft subdomain** (`nft-index.html`) renders status-only + a link
  to the main site. No purchase affordance there.
  Proof: `grep -i "bluetickPrompt\|Get Blue Tick" nft-index.html` shows
  only the status branch; the buy flow lives in `app-script.js` +
  `index.html` only.

## 3. Leaderboard restored (main site only)

`backend/leaderboard.js` (rewritten; the file existed but was buggy and
had no frontend):

- **Bug fixed:** it read `m.author` / `c.author` while `social.js`
  stores `address` on messages, comments, likes, and reposts — post /
  comment / like / repost counts were all 0 and only followers scored.
  Now reads `address`.
- Counts only `room === "social"` posts (group chat excluded).
- Only wallets with a resolved `.ai` handle rank (cached handles first,
  on-chain `handleOf` fallback). This makes the ranking consistent with
  the new login: only a paired wallet + verified Agent ID can enter;
  readers without login can still view it.
- Score: post +1, comment +1, like received +2, repost received +3,
  follower +2. Per-row `blueTick` flag from `verifyAddress`.
- `onChain: { interactions: null, note: "On-chain interaction counts
  are not yet available" }` — honest, no invented numbers. On-chain
  interaction/transaction counts are not yet available from any
  indexer the backend can query; the field is labeled, not faked.
- Public read, `GET /api/leaderboard`, `?limit=` default 20 max 100.
- Frontend: leaderboard page added to `index.html` only (sidebar +
  mobile bottom nav + `page-leaderboard` section; `loadLeaderboard()` /
  `renderLeaderboard()` in `app-script.js`; `KNOWN_PAGES` + `CRUMBS` +
  `navigate()`). Guarded by the `NFT_ONLY` flag: on the nft subdomain
  it redirects to home. Never renders on the nft subdomain.

## 4. Files changed

| File | Change |
|---|---|
| `contracts/BlueTickNFT.sol` | NEW. Canonical Blue Tick NFT (soulbound, expiry, renew). |
| `backend/server.js` | Rewritten. Removes `/api/pair/*`, `baw` spawn, `qrcode`, fixed 48h sweep; wires forum-auth + connect-link + social + photos + nft + blue-tick + leaderboard; per-session `expireAt` sweep. |
| `backend/forum-auth.js` | Added `GET /api/session/status/:id`, `POST /api/session/disconnect/:id`; header updated. EIP-712 endpoints are `/api/auth/challenge` + `/api/auth/verify`. |
| `backend/connect-link.js` | NEW. One-time connect tokens, 10-min TTL, 7-day browser sessions, `GET /connect`. |
| `backend/session-check.js` | NEW. Shared `activeSession()` (ACTIVE + address + not past `expireAt`). |
| `backend/vouchers.js` | NEW in this repo. Verbatim copy of the old repo's file (diff-identical). |
| `backend/blue-tick.js` | Rewritten. NFT verification, voucher authorize/redeem, migrate, confirm, quote, status; legacy grandfathering. |
| `backend/leaderboard.js` | Rewritten. `author`->`address` fix, social-room only, .ai-handle gating, honest on-chain note. |
| `backend/social.js` | `authedSession` via session-check; 11 Blue Tick call sites converted to address-based async checks. |
| `backend/photos.js`, `backend/nft.js` | `authedSession` via session-check. |
| `backend/package.json` | `qrcode` removed. |
| `app-script.js` | Pair modal -> connect modal; QR/poll code deleted; session calls moved to `/api/session/*`; Blue Tick card rewritten for the NFT (nft subdomain: status-only); leaderboard page + loader; "Pair" -> "Connect" wording. |
| `index.html` | Pair modal -> connect modal; leaderboard nav + `page-leaderboard` section; app-script.js re-inlined (byte-identical). |
| `nft-index.html` | Pair modal -> connect modal; app-script.js re-inlined (byte-identical). No Blue Tick purchase UI. |
| `connect.html` | NEW. `/connect` page: redeems the token, stores the session, redirects. Shows no code. |
| `docs-index.html` | Pairing section rewritten as "Connecting"; agent endpoints documented as `/api/auth/*` + `/api/connect/*` + `/api/session/*`; Blue Tick FAQ rewritten as soulbound NFT; post limits corrected (500 / 1000 with tick; 2 / 5 photos). |
| `agentics.caddy` | `handle /connect*` -> backend before the SPA fallback. |
| `test/` | NEW. Durable test toolchain + suites (see `test/README.md`). |
| `SKILL.md`, `README.md` | Updated for EIP-712 + connect link, Blue Tick NFT, leaderboard; `build.py` marked stale (points at old-repo paths; re-inlining is by direct script-block replacement). |
| `HACKATHON-FIX.md` | This file. |

Note on `index.html` / `nft-index.html`: the inline script is
byte-identical to `app-script.js` (verified). `build.py` in this repo
is stale — do not run it here.

## 5. Tests (all local, no real funds)

Toolchain: `test/` — solc 0.8.26, @openzeppelin/contracts 5.0.2,
ganache 7.9.2, ethers 5.7.2 (backend deps: ethers 5.8.0, express
5.3.0). Node v24.22.1. `npm run compile` / `test:contract` /
`test:backend` from `test/`. See `test/README.md` for the three
harness bugs found and fixed during this work (connect.html layout,
cross-process token store, `send` dotfile 404 on `.tmp-e2e`,
solc Cancun/MCOPY vs ganache, 10-minute auth deadline vs 366-day
time travel).

### Contract suite — 27/27 PASS (`test/test-contract.js`, ganache chainId 56)

Plain buy; one-per-wallet; soulbound transfer/approve reverts; expiry
(`isActive` false, `isExpired` true, `activeBalanceOf` 0, `balanceOf`
still 1); renew of expired token (same tokenId, no new mint, expiry
extended from renewal time); active renew extends from old expiry;
non-owner renew reverts; free-voucher mint (amount 0); discount mint
at 2.5 USDT; bad auth / replayed nonce / expired deadline all revert.

### Backend e2e — 46/46 PASS (`test/test-backend.js`)

Backend starts + `/api/health`; challenge issued; EIP-712 login
verifies; agent session 48h; bad signature rejected; connect link
minted; link expires ~10 min; `GET /connect` serves the page (200, no
code to scan or enter); token redeems to a 7-day browser session;
reuse -> 410 `token_already_used`; unknown token -> 404; expired token
-> 410 `token_expired` (separate short-TTL backend); session status
ACTIVE + address + 7d expiry; disconnect ok; disconnected session 404;
leaderboard 2 rows (buyerone.ai score 13 rank 1, buyertwo.ai score 7
rank 2, group message excluded, on-chain honestly unavailable, rank 1
blueTick false before mint); quote deployed $5 treasury nft address;
600-char post rejected without tick, allowed with active tick, rejected
after expiry; plain buy + confirm (receipt verified); discount voucher
authorizes 2.5 USDT + on-chain buy + confirm + marked used once;
second authorize reserved (409); free voucher redeem + mint;
legacy migration (200 remaining days) + second migration 409;
legacy claim 410 `use_nft_purchase`; public voucher preview (50% OFF,
2.5 USDT, no `usedBy`); expiry -> benefit off -> renew same token ->
benefit back on, no second mint.

### Syntax + smoke

`node --check` passes on every touched JS file (server, forum-auth,
connect-link, session-check, vouchers, blue-tick, leaderboard, social,
photos, nft, app-script.js, all test files). Real repo backend (no
`BLUE_TICK_NFT_ADDRESS`) starts and answers `/api/health`
(`{"ok":true,"sessions":0}`), `/api/bluetick/quote`
(`deployed: false`, $5, treasury, USDT) and `/api/leaderboard`
(empty + honest on-chain note).

## 6. Deploy + verify (DO NOT RUN until the user approves gas)

Contract: `contracts/BlueTickNFT.sol`, constructor
`(address _usdt, address _treasury, address _authorizer)`:

- USDT (BSC): `0x55d398326f99059fF775485246999027B3197955`
- Treasury: `0x0a398d602D56318F6342586e77299Cd0bF9C523b`
- Authorizer: the address of the backend signer key (see below). The
  authorizer key must exist BEFORE deploy, because its address is a
  constructor argument.

### Step 1 — authorizer key (operator, once)

```bash
# Generate a fresh backend signer key (never commit it, never paste it
# in chat). This only needs to sign EIP-712 authorizations; it holds no funds.
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
# -> 0x<64-hex>   (save it as BLUE_TICK_AUTHORIZER_KEY, see step 3)
node -e "console.log(new (require('ethers').Wallet)('<PASTE-KEY-HERE>').address)"
# -> 0x<AUTHORIZER_ADDRESS>   (this goes into the deploy below)
```

### Step 2 — deploy to BSC mainnet (needs user gas approval first)

```bash
cd ~/workspace/agentics-forum-baw/test
npm run compile        # regenerates test/artifacts/BlueTickNFT.json

# Deploy with ethers (replace placeholders; deployer needs BNB for gas):
node -e "
const { ethers } = require('ethers');
const fs = require('fs');
(async () => {
  const provider = new ethers.providers.JsonRpcProvider('https://bsc-dataseed.binance.org');
  const wallet = new ethers.Wallet('<DEPLOYER_PRIVATE_KEY>', provider);
  const art = JSON.parse(fs.readFileSync('artifacts/BlueTickNFT.json', 'utf8'));
  const f = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const c = await f.deploy(
    '0x55d398326f99059fF775485246999027B3197955',   // USDT BSC
    '0x0a398d602D56318F6342586e77299Cd0bF9C523b',   // treasury
    '0x<AUTHORIZER_ADDRESS>'                        // backend signer
  );
  await c.deployed();
  console.log('BlueTickNFT deployed at:', c.address);
  console.log('tx:', c.deployTransaction.hash);
})();
"
```

Record the deployed address. It goes into the backend env (step 3) and
into the hackathon submission form (contract address field).

### Step 3 — BscScan verify

```bash
# Flatten (single file, no imports left after OpenZeppelin inlining is NOT
# automatic) — use the standard-JSON route instead. With solc 0.8.26,
# optimizer enabled, runs 200, evmVersion shanghai (see test/compile.js):
npx hardhat verify --network bsc <DEPLOYED_ADDRESS> \
  0x55d398326f99059fF775485246999027B3197955 \
  0x0a398d602D56318F6342586e77299Cd0bF9C523b \
  0x<AUTHORIZER_ADDRESS>
# (Hardhat project not included in this repo; the verify inputs above are
# the exact compiler settings + constructor args. Alternatively verify via
# the BscScan web form with the same settings and the flattened source
# from `npx solc --optimize --optimize-runs 200 --evm-version shanghai`.)
```

### Step 4 — backend env + restart (at deploy time)

```bash
# In the backend service env (VPS, service agent-pairing):
BLUE_TICK_NFT_ADDRESS=<DEPLOYED_ADDRESS>
BLUE_TICK_AUTHORIZER_KEY=<0x... from step 1>   # never in the repo
BSC_RPC_URL=https://bsc-dataseed.binance.org   # or the operator's BSC RPC
# Then restart the backend. Verify:
curl -s https://agentics.forum/api/bluetick/quote
# -> { "ok": true, "deployed": true, "nftAddress": "<DEPLOYED_ADDRESS>", ... }
```

### Step 5 — re-launch + import live data

- Deploy this branch to agentics.forum (main site) + docs; re-launch
  the BAW version live (it is currently repo-only).
- Import the live `vouchers.json` (incl. the legacy free voucher
  code) from the production backend into the new backend's
  `VOUCHERS_DATA` file; import the live `blue-tick.json` legacy
  records so existing holders keep status via grandfathering.
- Submit the hackathon form with the website + deployed contract
  address(es) + Agent ID usage description.
- Innovation Award needs the product live with **at least 30 Agent ID
  addresses** having interacted with the participating contract(s)
  during the Submission Period — that count starts only after launch.

## 7. What still needs the user

1. **Gas + deploy approval** for the Blue Tick NFT deploy (step 2
   above). Never deploy without it.
2. **Authorizer key generation** (step 1) — a fresh backend signer;
   the key must be saved by the operator, never committed.
3. **Domain re-launch**: this branch is repo-only; the BAW version must
   go live on agentics.forum again for the hackathon (Innovation Award
   needs 30 Agent ID addresses; Pioneer Award needs on-chain data).
4. **Import of live `vouchers.json` + `blue-tick.json`** from the
   production backend at launch (legacy free voucher code included).
5. **Push**: this staging dir has no `.git` and no GitHub credentials
   (`gh` not logged in, SSH to github.com times out via the proxy).
   A `git format-patch --root` of branch `hackathon-fix` is produced
   with this delivery for the parent agent to apply/push via the saved
   GitHub login. Never push `main` from here.

## 8. What was NOT verified

- No live-browser check (this agent cannot drive a browser): the
  `/connect` page flow was verified over HTTP (page serves, token
  redeem works), not by clicking it in Chrome.
- No mainnet deploy, no BscScan verify run (needs user gas approval).
- No real BAW wallet sign-in against the live site (needs the user's
  phone + Binance App); the EIP-712 flow was verified locally with
  test wallets only.
- The 30-Agent-ID-addresses threshold cannot be verified until launch.
- `build.py` remains stale for this repo (see section 4).
