import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { gotScraping } from 'got-scraping';

//-------------------- RPC AND GAS PRICE CONFIG --------------------//

const rpcUrls = [
  'https://rpc.ankr.com/bsc',
  'https://bsc.drpc.org',
  'https://bsc.meowrpc.com',
  'https://binance.llamarpc.com',
];
const gasPrice = {
  claim: {
    gasPrice: ethers.parseUnits('3', 'gwei'),
  },
  withdraw: {
    gasPrice: ethers.parseUnits('3', 'gwei'),
  },
};

//-------------------- RPC AND GAS PRICE CONFIG --------------------//

const providers = rpcUrls.map((url) => new ethers.JsonRpcProvider(url));
const allocations = readAllocations();
const wallets = readWallets();
let resolveClaimStart;
let waitForClaimStart = new Promise((resolve) => resolveClaimStart = resolve);

watchForClaimStart();

Promise
  .allSettled(
    wallets.map((wallet) => processWallet(wallet.wallet, wallet.withdrawAddress, wallet.proxy))
  )
  .then(() => {
    console.log('All wallets processed!');
  });

async function watchForClaimStart() {
  try {
    const claimStartBlockNum = await Promise.any(
      providers.map((provider) => getClaimContract(provider).startBlock.staticCall()),
    );
    const currentBlockNum = BigInt(await Promise.any(
      providers.map((provider) => provider.getBlockNumber()),
    ));
    const blocksUntilClaim = claimStartBlockNum - currentBlockNum;

    if (blocksUntilClaim <= 1n) {
      resolveClaimStart();
      waitForClaimStart = undefined;

      console.log('\x1b[32mClaim is live now!\x1b[0m');
      console.log();
    } else if (blocksUntilClaim <= 5n) {
      setTimeout(watchForClaimStart, 3000);
    } else if (blocksUntilClaim <= 30n) {
      setTimeout(watchForClaimStart, 15_000);
    } else {
      setTimeout(watchForClaimStart, 60_000);
    }
  } catch (e) {
    setTimeout(watchForClaimStart, 60_000);

    console.warn('\x1b[33mwarn!\x1b[0m \x1b[34m[watching claim status]\x1b[0m', e.message);
  }
}

async function processWallet(wallet, withdrawAddress, proxy) {
  const allocation = await getAllocation(wallet, proxy);

  console.log(`\x1b[36m[${wallet.address}] Allocation of ${ethers.formatUnits(allocation.amountWei, 18)} LISTA loaded!\x1b[0m`);

  if (waitForClaimStart) {
    console.log(`\x1b[36m[${wallet.address}] Waiting for claim to start...\x1b[0m`);
    console.log();

    await waitForClaimStart;
  }

  await claim(wallet, allocation);

  if (withdrawAddress) {
    await withdraw(wallet, withdrawAddress);
  }
}

async function withdraw(wallet, withdrawAddress) {
  const balance = await Promise.any(
    providers.map((provider) => getTokenContract(provider).balanceOf.staticCall(wallet.address)),
  );

  if (balance <= 0n) {
    console.log(`[${wallet.address}] Nothing to withdraw!`);

    return;
  }

  let nonce;

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      if (nonce == null) {
        nonce = await Promise.any(
          providers.map((provider) => provider.getTransactionCount(wallet.address)),
        );
      }

      const transaction = await Promise.any(
        providers.map((provider) => {
          return getTokenContract(wallet.connect(provider)).transfer(
            withdrawAddress,
            balance,
            {
              ...gasPrice.withdraw,
              nonce,
            },
          );
        }),
      );

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      if (e instanceof AggregateError) {
        e = e.errors[0];
      }

      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Withdraw error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Withdrawn ${ethers.formatUnits(balance, 18)} LISTA to ${withdrawAddress} successfully!\x1b[0m`);
}

async function claim(wallet, allocation) {
  const leaf = ethers.solidityPackedKeccak256(
    ['address', 'uint256'],
    [wallet.address, allocation.amountWei],
  );
  const isClaimed = await Promise.any(
    providers.map((provider) => getClaimContract(provider).claimed.staticCall(leaf)),
  );

  if (isClaimed) {
    console.log(`[${wallet.address}] Already claimed!`);

    return;
  }

  let nonce;

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      if (nonce == null) {
        nonce = await Promise.any(
          providers.map((provider) => provider.getTransactionCount(wallet.address)),
        );
      }

      const transaction = await Promise.any(
        providers.map((provider) => {
          return getClaimContract(wallet.connect(provider)).claim(
            wallet.address,
            allocation.amountWei,
            allocation.proof,
            {
              ...gasPrice.claim,
              nonce,
            },
          );
        }),
      );

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      if (e instanceof AggregateError) {
        e = e.errors[0];
      }

      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Claim error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Claimed ${ethers.formatUnits(allocation.amountWei, 18)} LISTA successfully!\x1b[0m`);
}

async function getAllocation(wallet, proxy) {
  const address = wallet.address.toLowerCase();

  let allocation = allocations.find((alloc) => alloc.address.toLowerCase() === address);

  if (allocation) {
    return allocation;
  }

  try {
    const message = 'Thank you for your support of Lista DAO. Sign in to view airdrop details.';
    const signature = await wallet.signMessage(message);
    const body = await gotScraping.get({
      url: 'https://api.lista.org/api/airdrop/proof',
      searchParams: {
        address: wallet.address,
        message,
        signature,
      },
      headers: {
        'Referer': 'https://lista.org/',
      },
      proxyUrl: proxy,
      throwHttpErrors: true,
      resolveBodyOnly: true,
      responseType: 'json',
    });

    if (!body.data || body.data.amountWei === '0') {
      console.error(`\x1b[31m[${wallet.address}] Not eligible!\x1b[0m`);

      const err = new Error('Not eligible!');
      err.silent = true;

      throw err;
    }

    allocation = {
      address,
      amount: body.data.amount,
      amountWei: body.data.amountWei,
      proof: body.data.proof,
    };

    if (!allocation.amountWei || !allocation.proof) {
      throw new Error('Malformed eligibility response: ' + JSON.stringify(body));
    }
  } catch (e) {
    if (!e.silent) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Allocation loading error\x1b[0m`);
      console.log();
    }

    throw e;
  }

  allocations.push(allocation);
  writeAllocations();

  return allocation;
}

function readWallets() {
  const wallets = readFileSync(new URL('./data/wallets.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);
  const proxies = readFileSync(new URL('./data/proxies.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);

  return wallets.map((wallet, index) => {
    const [privateKey, withdrawAddress] = wallet.trim().split(':');
    let proxy = proxies[index]?.trim() || undefined;

    if (proxy) {
      if (!proxy.includes('@')) {
        const [host, port, username, password] = proxy.split(':');

        proxy = `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
      }

      if (!proxy.includes('://')) {
        proxy = 'http://' + proxy;
      }

      proxy = new URL(proxy).href.replace(/\/$/, '');
    }

    return {
      wallet: new ethers.Wallet(privateKey),
      withdrawAddress: ethers.isAddress(withdrawAddress) ? withdrawAddress : undefined,
      proxy,
    };
  });

  function isNonEmptyLine(line) {
    line = line.trim();

    return line && !line.startsWith('#');
  }
}

function readAllocations() {
  try {
    const data = readFileSync(new URL('./data/allocations.json', import.meta.url), 'utf8');
    const json = JSON.parse(data);

    if (Array.isArray(json)) {
      return json;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('\x1b[33mwarn!\x1b[0m \x1b[34m[reading data/allocations.json]\x1b[0m', e.message);
    }
  }

  return [];
}

function writeAllocations() {
  const data = JSON.stringify(allocations, null, 2);

  writeFileSync(new URL('./data/allocations.json', import.meta.url), data, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTokenContract(runner) {
  const CONTRACT_ADDRESS = '0xFceB31A79F71AC9CBDCF853519c1b12D379EdC46';
  const ABI = JSON.parse('[{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"spender","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Transfer","type":"event"},{"inputs":[],"name":"EIP712_DOMAIN","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"EIP712_VERSION","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"PERMIT_TYPE_HASH","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"subtractedValue","type":"uint256"}],"name":"decreaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"addedValue","type":"uint256"}],"name":"increaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"nonces","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint8","name":"v","type":"uint8"},{"internalType":"bytes32","name":"r","type":"bytes32"},{"internalType":"bytes32","name":"s","type":"bytes32"}],"name":"permit","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"updateDomainSeparator","outputs":[],"stateMutability":"nonpayable","type":"function"}]');

  return new ethers.Contract(CONTRACT_ADDRESS, ABI, runner);
}

function getClaimContract(runner) {
  const CONTRACT_ADDRESS = '0x2ed866Ca9C33bf695C78af222d61Bd4D9cB558d3';
  const ABI = JSON.parse('[{"inputs":[{"internalType":"address","name":"_token","type":"address"},{"internalType":"bytes32","name":"_merkleRoot","type":"bytes32"},{"internalType":"uint256","name":"reclaimDelay","type":"uint256"},{"internalType":"uint256","name":"_startBlock","type":"uint256"},{"internalType":"uint256","name":"_endBlock","type":"uint256"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"Claimed","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"bytes32[]","name":"proof","type":"bytes32[]"}],"name":"claim","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"claimed","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"endBlock","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"merkleRoot","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"reclaim","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"reclaimPeriod","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_endBlock","type":"uint256"}],"name":"setEndBlock","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"_merkleRoot","type":"bytes32"}],"name":"setMerkleRoot","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_startBlock","type":"uint256"}],"name":"setStartBlock","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"startBlock","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"token","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"}]');

  return new ethers.Contract(CONTRACT_ADDRESS, ABI, runner);
}
