import dotenv from 'dotenv';
import * as ecc from '@bitcoinerlab/secp256k1';
import { initEccLib, Psbt } from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import {
  AddressType,
  DefaultSigner,
  MempoolUtxoProvider,
  MempolChainProvider,
  ChainProvider,
  DUST_LIMIT,
} from '@cat-protocol/cat-sdk';
import * as fs from 'node:fs';
import { Source } from './types';
import { getCollectionInfo, getNftUtxo } from './tracker';
import { transfer } from './cat721';
import { UTXO } from 'scrypt-ts';

dotenv.config();

initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

function loadFeeSigner(): DefaultSigner {
  try {
    const k = ECPair.fromWIF(process.env.FEE_WIF!);
    return new DefaultSigner(k);
  } catch (e) {
    throw new Error(`invalid fee wif: ${e}`);
  }
}

function loadSources(): Source[] {
  try {
    const lines = fs.readFileSync(process.env.SOURCE_FILE!, 'utf8').split('\n');
    return lines
      .filter((line) => line !== '')
      .map((line) => {
        const [address, wif, localId, destAddress] = line.split(',');
        return { address, wif, localId, destAddress };
      });
  } catch (e) {
    throw new Error(`error loading source file: ${e}`);
  }
}

async function prepareSources(sources: Source[], collectionId: string) {
  for (const source of sources) {
    source.nftUtxo = await getNftUtxo(collectionId, source.localId);
    const keyPair = ECPair.fromWIF(source.wif);
    let signer = new DefaultSigner(keyPair, AddressType.P2TR);
    let address = await signer.getAddress();
    if (source.address !== address) {
      signer = new DefaultSigner(keyPair, AddressType.P2WPKH);
      address = await signer.getAddress();
      if (source.address !== address) {
        throw new Error(`invalid source address: ${source.address}`);
      }
    }
    source.signer = signer;
  }
}

async function splitFees(
  utxos: UTXO[],
  satoshis: bigint,
  amount: number,
  feeRate: number,
  signer: DefaultSigner,
  chainProvider: ChainProvider,
): Promise<Psbt> {
  const address = await signer.getAddress();
  const inputs = utxos.map((utxo) => ({
    hash: utxo.txId,
    index: utxo.outputIndex,
    witnessUtxo: {
      script: Buffer.from(utxo.script, 'hex'),
      value: BigInt(utxo.satoshis),
    },
  }));
  const outputs = Array.from({ length: amount }, () => ({
    address,
    value: satoshis,
  }));
  const dummyPsbt = new Psbt({
    maximumFeeRate: Number.MAX_SAFE_INTEGER,
  })
    .addInputs(inputs)
    .addOutputs(outputs)
    .addOutput({
      address,
      value: 0n,
    });
  const dummySignedPsbt = await signer.signPsbt(dummyPsbt.toHex());
  const dummyTx = dummyPsbt
    .combine(Psbt.fromHex(dummySignedPsbt))
    .finalizeAllInputs();
  const vsize = dummyTx.extractTransaction().virtualSize();
  const fee = BigInt(vsize * feeRate);
  const satsTotalInputs = utxos.reduce(
    (acc, utxo) => acc + BigInt(utxo.satoshis),
    0n,
  );
  const satsTotalOutputs = satoshis * BigInt(amount);
  const satsChanged = satsTotalInputs - satsTotalOutputs - fee;

  const psbt = new Psbt().addInputs(inputs).addOutputs(outputs);
  if (satsChanged >= DUST_LIMIT) {
    psbt.addOutput({
      address,
      value: satsChanged,
    });
  }
  const signedPsbt = await signer.signPsbt(psbt.toHex());
  const tx = psbt.combine(Psbt.fromHex(signedPsbt)).finalizeAllInputs();
  await chainProvider.broadcast(tx.extractTransaction().toHex());

  return tx;
}

export function sleep(seconds: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, seconds * 1000);
  });
}

async function waitTxConfirmation(txId: string, chainProvider: ChainProvider) {
  while (true) {
    console.log('  waiting for confirmation...');
    await sleep(15);
    const confirmations = await chainProvider.getConfirmations(txId);
    if (confirmations >= 1) {
      break;
    }
  }
}

async function transferNft(
  source: Source,
  minterAddr: string,
  feeSigner: DefaultSigner,
  feeUtxo: UTXO,
  feeRate: number,
  utxoProvider: MempoolUtxoProvider,
  chainProvider: ChainProvider,
) {
  try {
    const { sendTx } = await transfer(
      source.nftUtxo!,
      minterAddr,
      source.signer!,
      source.destAddress,
      feeUtxo,
      feeSigner,
      feeRate,
      utxoProvider,
      chainProvider,
    );
    console.log(`  ${source.localId}: ${sendTx.extractTransaction().getId()}`);
  } catch (e) {
    console.log(`  ${source.localId}: [failed] ${e}`);
  }
}

(async () => {
  // load collection info
  const collectionId = process.env.COLLECTION_ID;
  const collectionInfo = await getCollectionInfo(collectionId!);
  if (!collectionInfo) {
    console.log(`exit: collection ${collectionId} not found`);
    return;
  }
  console.log(`collection: ${collectionId}`);
  console.log(`  name: ${collectionInfo.metadata.name}`);
  console.log(`  symbol: ${collectionInfo.metadata.symbol}`);
  console.log(`  minterAddr: ${collectionInfo.minterAddr}`);

  // load fee signer
  const feeSigner = loadFeeSigner();
  const feeAddress = await feeSigner.getAddress();
  console.log(`fee address: ${feeAddress}`);
  // check fee balance
  const utxoProvider = new MempoolUtxoProvider('fractal-mainnet');
  const feeUtxos = await utxoProvider.getUtxos(feeAddress);
  console.log(`fee utxos: ${feeUtxos.length}`);
  const feeBalance = feeUtxos.reduce((acc, utxo) => acc + utxo.satoshis, 0);
  console.log(`fee balance: ${feeBalance}`);
  if (feeBalance < 10000000) {
    console.log('exit: insufficient fee balance');
    return;
  }

  // load sources, query nft UTXOs, and prepare signers
  const sources = loadSources();
  console.log(`source lines: ${sources.length}`);
  await prepareSources(sources, process.env.COLLECTION_ID!);
  const nftUtxosLoaded = sources.reduce(
    (acc, source) => acc + (source.nftUtxo ? 1 : 0),
    0,
  );
  console.log(`nft utxos loaded: ${nftUtxosLoaded}`);
  if (nftUtxosLoaded === 0) {
    console.log('exit: no nft utxos loaded');
    return;
  }

  // split fees
  const vbytesTotal = 2900;
  const feeRate = Number(process.env.FEE_RATE || 1);
  const bulletSatoshis = vbytesTotal * feeRate;
  const chainProvider = new MempolChainProvider('fractal-mainnet');
  const feeSplitTx = await splitFees(
    feeUtxos,
    BigInt(bulletSatoshis),
    nftUtxosLoaded,
    feeRate,
    feeSigner,
    chainProvider,
  );

  // wait for fee split tx confirmation
  console.log(`split fees: ${feeSplitTx.extractTransaction().getId()}`);
  await waitTxConfirmation(
    feeSplitTx.extractTransaction().getId(),
    chainProvider,
  );

  // transfer NFTs
  console.log('fees confirmed and start the transfer:');
  await Promise.all(
    sources.map((source, i) => {
      return transferNft(
        source,
        collectionInfo.minterAddr,
        feeSigner,
        {
          txId: feeSplitTx.extractTransaction().getId(),
          outputIndex: i,
          satoshis: bulletSatoshis,
          script: Buffer.from(
            feeSplitTx.extractTransaction().outs[i].script,
          ).toString('hex'),
        },
        feeRate,
        utxoProvider,
        chainProvider,
      );
    }),
  );
})();
