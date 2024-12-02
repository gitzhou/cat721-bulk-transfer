#!/usr/bin/env node

import { program } from 'commander';
import {
  AddressType,
  ChainProvider,
  DefaultSigner,
  DUST_LIMIT,
  MempolChainProvider,
  MempoolUtxoProvider,
} from '@cat-protocol/cat-sdk';
import { Source } from './types';
import fs from 'node:fs';
import { getCollectionInfo, getNftUtxo } from './tracker';
import { UTXO } from 'scrypt-ts';
import { initEccLib, Psbt } from 'bitcoinjs-lib';
import { transfer } from './cat721';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';

initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

program
  .name('cat721-bulk-transfer')
  .description('Bulk transfer CAT-721 NFTs')
  .version('1.0.0')
  .requiredOption('-s, --source-file <source-file>', 'source file path')
  .requiredOption('-c, --collection-id <collection-id>', 'NFT collection ID')
  .requiredOption(
    '-t, --tracker-host <tracker-host>',
    'tracker host, e.g. http://127.0.0.1:3000',
  )
  .requiredOption(
    '-f, --fee-rate <fee-rate>',
    'fee rate in sat/vB that used for the transfer',
    (value) => Number(value),
    1,
  )
  .requiredOption('-w, --fee-wif <wif>', 'WIF that provides transfer fees')
  .showHelpAfterError('(add --help for additional information)')
  .allowUnknownOption(false)
  .action(async (options) => {
    const { sourceFile, collectionId, trackerHost, feeRate, feeWif } = options;
    const network = 'fractal-mainnet';

    // load collection info
    const collectionInfo = await getCollectionInfo(trackerHost, collectionId);
    if (!collectionInfo) {
      console.log(`exit: collection ${collectionId} not found`);
      return;
    }
    console.log(`collection: ${collectionId}`);
    console.log(`  name: ${collectionInfo.metadata.name}`);
    console.log(`  symbol: ${collectionInfo.metadata.symbol}`);
    console.log(`  minterAddr: ${collectionInfo.minterAddr}`);

    // load fee signer
    const feeSigner = loadFeeSigner(feeWif);
    const feeAddress = await feeSigner.getAddress();
    console.log(`fee address: ${feeAddress}`);
    // check fee balance
    const utxoProvider = new MempoolUtxoProvider(network);
    const feeUtxos = await utxoProvider.getUtxos(feeAddress);
    console.log(`fee utxos: ${feeUtxos.length}`);
    const feeBalance = feeUtxos.reduce((acc, utxo) => acc + utxo.satoshis, 0);
    console.log(`fee balance: ${feeBalance}`);
    if (feeBalance <= 0) {
      console.log('exit: insufficient fee balance');
      return;
    }

    // load sources, query nft UTXOs, and prepare signers
    const sources = loadSources(sourceFile);
    console.log(`source lines: ${sources.length}`);
    await prepareSources(sources, trackerHost, collectionId);
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
    const bulletSatoshis = vbytesTotal * feeRate;
    const chainProvider = new MempolChainProvider(network);
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
    console.log('fees are confirmed and now transfer:');
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
  });

program.parse(process.argv);

function loadFeeSigner(wif: string): DefaultSigner {
  try {
    const k = ECPair.fromWIF(wif);
    return new DefaultSigner(k);
  } catch (e) {
    throw new Error(`invalid fee wif: ${e}`);
  }
}

function loadSources(sourceFile: string): Source[] {
  try {
    const lines = fs.readFileSync(sourceFile, 'utf8').split('\n');
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

async function prepareSources(
  sources: Source[],
  trackerHost: string,
  collectionId: string,
) {
  for (const source of sources) {
    source.nftUtxo = await getNftUtxo(
      trackerHost,
      collectionId,
      source.localId,
    );
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
    if (!source.nftUtxo) {
      console.log(`  ${source.localId}: [failed] nft utxo not loaded`);
      return;
    }
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
