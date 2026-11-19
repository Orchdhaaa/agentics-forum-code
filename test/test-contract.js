// BlueTickNFT contract tests on a local ganache (BSC chainId 56).
// Covers: plain buy, one-per-wallet, soulbound transfers, expiry
// (isActive / isExpired / activeBalanceOf), renew of the SAME token
// (no second mint, extends from old expiry when active / from now
// when expired), non-owner renew, free-voucher mint, discount mint,
// bad auth, replayed nonce, expired deadline.
// Run: npm run compile && npm run test:contract   (from this dir)
const ganache = require('ganache');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BT = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'BlueTickNFT.json'), 'utf8'));
const MOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts', 'mocks.json'), 'utf8'));
const PRICE = ethers.BigNumber.from(5000000);
const DAY = 86400;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name, extra || ''); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
async function reverts(p, name) {
  try { await p; ok(name, false, '(did not revert)'); }
  catch (e) { ok(name, /revert|call revert|VM Exception|missing revert/i.test(e.message), '(' + String(e.message).slice(0, 80) + ')'); }
}

(async () => {
  const provider = new ethers.providers.Web3Provider(ganache.provider({ logging: { quiet: true }, chain: { chainId: 56 } }));
  const [deployer, buyer, buyer2, other] = [0, 1, 2, 3].map(i => provider.getSigner(i));
  const deployerAddr = await deployer.getAddress();
  const buyerAddr = await buyer.getAddress();
  const buyer2Addr = await buyer2.getAddress();
  const authorizer = ethers.Wallet.createRandom().connect(provider);
  const authorizerAddr = await authorizer.getAddress();

  const usdtF = new ethers.ContractFactory(MOCKS.MockUSDT.abi, MOCKS.MockUSDT.bytecode, deployer);
  const usdt = await usdtF.deploy();
  const btF = new ethers.ContractFactory(BT.abi, BT.bytecode, deployer);
  const bt = await btF.deploy(usdt.address, deployerAddr, authorizerAddr); // treasury = deployer
  await usdt.mint(buyerAddr, 100_000_000);
  await usdt.mint(buyer2Addr, 100_000_000);
  await usdt.connect(buyer).approve(bt.address, ethers.constants.MaxUint256);
  await usdt.connect(buyer2).approve(bt.address, ethers.constants.MaxUint256);

  // 1. Plain buy, full price
  let tx = await bt.connect(buyer).buy(PRICE, 365, '', 0, 0, '0x');
  let rc = await tx.wait();
  const minted = rc.events.find(e => e.event === 'BlueTickMinted');
  const tid = minted.args.tokenId;
  ok('plain buy mints tokenId 1', tid.eq(1));
  ok('isActive true after buy', await bt.isActive(tid));
  ok('activeBalanceOf 1 after buy', (await bt.activeBalanceOf(buyerAddr)).eq(1));
  ok('balanceOf 1 after buy', (await bt.balanceOf(buyerAddr)).eq(1));
  ok('tokenOf maps wallet', (await bt.tokenOf(buyerAddr)).eq(tid));
  ok('treasury received 5 USDT', (await usdt.balanceOf(deployerAddr)).eq(PRICE));
  const exp1 = await bt.expiresAt(tid);

  // 2. Second buy reverts (one per wallet)
  await reverts(bt.connect(buyer).buy(PRICE, 365, '', 0, 0, '0x').then(t => t.wait()), 'second buy reverts');

  // 3. Soulbound: transfer reverts
  await reverts(bt.connect(buyer).transferFrom(buyerAddr, await other.getAddress(), tid).then(t => t.wait()), 'transferFrom reverts (soulbound)');
  await reverts(bt.connect(buyer).approve(await other.getAddress(), tid).then(t => t.wait()), 'approve reverts (soulbound)');

  // 4. Expiry: advance 366 days
  await provider.send('evm_increaseTime', [366 * DAY]);
  await provider.send('evm_mine');
  ok('isActive false after expiry', !(await bt.isActive(tid)));
  ok('isExpired true after expiry', await bt.isExpired(tid));
  ok('activeBalanceOf 0 after expiry', (await bt.activeBalanceOf(buyerAddr)).eq(0));
  ok('balanceOf still 1 after expiry (token not burned)', (await bt.balanceOf(buyerAddr)).eq(1));

  // 5. Renew expired token via contract, same tokenId, no new token
  const beforeCount = (await bt.nextTokenId()).toNumber();
  tx = await bt.connect(buyer).renew(tid, PRICE, 365, '', 0, 0, '0x');
  rc = await tx.wait();
  ok('renew emits BlueTickRenewed', !!rc.events.find(e => e.event === 'BlueTickRenewed'));
  ok('isActive true after renew', await bt.isActive(tid));
  ok('activeBalanceOf 1 after renew', (await bt.activeBalanceOf(buyerAddr)).eq(1));
  ok('no new token minted on renew', (await bt.nextTokenId()).toNumber() === beforeCount);
  ok('tokenOf unchanged after renew', (await bt.tokenOf(buyerAddr)).eq(tid));
  const exp2 = await bt.expiresAt(tid);
  ok('expiry extended ~365d from renew (expired token restarts from now)', exp2.sub(exp1).gt(360 * DAY));

  // 6. Renew while active extends from OLD expiry (no loss)
  const expBefore = await bt.expiresAt(tid);
  await bt.connect(buyer).renew(tid, PRICE, 365, '', 0, 0, '0x').then(t => t.wait());
  const expAfter = await bt.expiresAt(tid);
  ok('active renew extends from old expiry', expAfter.sub(expBefore).eq(365 * DAY));

  // 7. Non-owner renew reverts
  await reverts(bt.connect(other).renew(tid, PRICE, 365, '', 0, 0, '0x').then(t => t.wait()), 'non-owner renew reverts');

  // 8. Voucher path: backend-signed FREE mint (amount 0)
  const domain = { name: 'Agentics Blue Tick', version: '1', chainId: 56, verifyingContract: bt.address };
  const types = { Purchase: [
    { name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' }, { name: 'voucherCodeHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' } ] };
  async function signAuth(buyerAddr_, amount, durationDays, code, deadline, nonce) {
    const value = { buyer: buyerAddr_, amount, durationDays,
      voucherCodeHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(code)), deadline, nonce };
    return authorizer._signTypedData(domain, types, value);
  }
  const block = await provider.getBlock('latest');
  const deadline = block.timestamp + 600;
  const authFree = await signAuth(buyer2Addr, 0, 365, 'FREECODE1', deadline, 1);
  tx = await bt.connect(buyer2).buy(0, 365, 'FREECODE1', deadline, 1, authFree);
  rc = await tx.wait();
  const tid2 = rc.events.find(e => e.event === 'BlueTickMinted').args.tokenId;
  ok('free-voucher mint (amount 0) works', tid2.eq(2) && (await bt.isActive(tid2)));
  ok('free mint charged 0 USDT', (await usdt.balanceOf(deployerAddr)).eq(PRICE.mul(3))); // 1 buy + 2 renews at full price, free mint added 0

  // 9. Discount mint at 2.5 USDT
  const buyer3 = provider.getSigner(4);
  const buyer3Addr = await buyer3.getAddress();
  await usdt.mint(buyer3Addr, 100_000_000);
  await usdt.connect(buyer3).approve(bt.address, ethers.constants.MaxUint256);
  const authDisc = await signAuth(buyer3Addr, 2500000, 365, 'HALF50', deadline, 2);
  await bt.connect(buyer3).buy(2500000, 365, 'HALF50', deadline, 2, authDisc).then(t => t.wait());
  ok('discount mint at 2.5 USDT works', (await bt.activeBalanceOf(buyer3Addr)).eq(1));

  // 10. Bad auth / replay / expired deadline revert
  await reverts(bt.connect(other).buy(0, 365, 'FREECODE1', deadline, 3, authFree).then(t => t.wait()), 'auth bound to other buyer reverts');
  await reverts(bt.connect(buyer2).buy(0, 365, 'FREECODE1', deadline, 1, authFree).then(t => t.wait()), 'replayed nonce reverts');
  const pastDeadline = block.timestamp - 10;
  const authLate = await signAuth(await other.getAddress(), 0, 365, 'LATE', pastDeadline, 9);
  await reverts(bt.connect(other).buy(0, 365, 'LATE', pastDeadline, 9, authLate).then(t => t.wait()), 'expired deadline reverts');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
