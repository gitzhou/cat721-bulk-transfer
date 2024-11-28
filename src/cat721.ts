import {
  CAT721Covenant,
  CAT721GuardCovenant,
  Cat721Utxo,
  CatPsbt,
  ChainProvider,
  DUST_LIMIT,
  getDummyUtxo,
  getDummyUtxos,
  GuardType,
  isP2TR,
  MAX_INPUT,
  Postage,
  Signer,
  toTokenAddress,
  TracedCat721Nft,
  UtxoProvider,
} from '@cat-protocol/cat-sdk';
import { UTXO } from 'scrypt-ts';
import { Psbt } from 'bitcoinjs-lib';

export async function transfer(
  nftUtxo: Cat721Utxo,
  minterAddr: string,
  nftSigner: Signer,
  destAddr: string,
  feeUtxo: UTXO,
  feeSigner: Signer,
  feeRate: number,
  utxoProvider: UtxoProvider,
  chainProvider: ChainProvider,
): Promise<{
  guardTx: CatPsbt;
  sendTx: CatPsbt;
  estGuardTxVSize: number;
  estSendTxVSize: number;
}> {
  const nftPubKey = await nftSigner.getPublicKey();
  const nftAddress = await nftSigner.getAddress();
  const changeAddress = await feeSigner.getAddress();

  const tracedNfts = await CAT721Covenant.backtrace(
    [{ ...nftUtxo, minterAddr }],
    chainProvider,
  );
  const inputNft = tracedNfts[0].nft;
  const { guard, outputNfts } = CAT721Covenant.createTransferGuard(
    [
      {
        nft: inputNft,
        inputIndex: 0,
      },
    ],
    [
      {
        address: toTokenAddress(destAddr),
        outputIndex: 1,
      },
    ],
  );
  const { estGuardTxVSize, dummyGuardPsbt } = estimateGuardTxVSize(
    guard.bindToUtxo({ ...getDummyUtxo(changeAddress), script: undefined }),
    changeAddress,
  );
  const estSendTxVSize = estimateSentTxVSize(
    tracedNfts,
    guard,
    dummyGuardPsbt,
    nftAddress,
    nftPubKey,
    outputNfts,
    changeAddress,
    feeRate,
  );

  const total =
    feeRate * (estGuardTxVSize + estSendTxVSize) + Postage.TOKEN_POSTAGE; // for a nft change output
  const utxos = await utxoProvider.getUtxos(changeAddress, { total });

  if (utxos.length === 0) {
    throw new Error('Insufficient satoshis input amount');
  }

  const guardPsbt = buildGuardTx(
    guard,
    feeUtxo,
    changeAddress,
    feeRate,
    estGuardTxVSize,
  );
  const signedGuardPsbt = await feeSigner.signPsbt(
    guardPsbt.toHex(),
    guardPsbt.psbtOptions(),
  );
  const guardTx = await guardPsbt
    .combine(Psbt.fromHex(signedGuardPsbt))
    .finalizeAllInputsAsync();

  const sendPsbt = buildSendTx(
    tracedNfts,
    guard,
    guardPsbt,
    nftAddress,
    nftPubKey,
    outputNfts,
    changeAddress,
    feeRate,
    estSendTxVSize,
  );
  const nftSignedSendPsbt = await nftSigner.signPsbt(sendPsbt.toHex(), {
    autoFinalized: false,
    toSignInputs: [
      {
        index: 0,
        publicKey: nftPubKey,
        disableTweakSigner: false,
      },
    ],
  });
  const feeSignedSendPsbt = await feeSigner.signPsbt(nftSignedSendPsbt, {
    autoFinalized: false,
    toSignInputs: [
      {
        index: 2,
        address: changeAddress,
      },
    ],
  });

  const sendTx = await sendPsbt
    .combine(Psbt.fromHex(nftSignedSendPsbt))
    .combine(Psbt.fromHex(feeSignedSendPsbt))
    .finalizeAllInputsAsync();

  await chainProvider.broadcast(guardTx.extractTransaction().toHex());
  await chainProvider.broadcast(sendTx.extractTransaction().toHex());

  return {
    guardTx,
    sendTx,
    estGuardTxVSize,
    estSendTxVSize,
  };
}

function buildGuardTx(
  guard: CAT721GuardCovenant,
  feeUtxo: UTXO,
  changeAddress: string,
  feeRate: number,
  estimatedVSize?: number,
) {
  if (
    feeUtxo.satoshis <
    Postage.GUARD_POSTAGE + feeRate * (estimatedVSize || 1)
  ) {
    throw new Error('Insufficient satoshis input amount');
  }

  const guardTx = new CatPsbt()
    .addFeeInputs([feeUtxo])
    .addCovenantOutput(guard, Postage.GUARD_POSTAGE)
    .change(changeAddress, feeRate, estimatedVSize);

  guard.bindToUtxo(guardTx.getUtxo(1));

  return guardTx;
}

function estimateGuardTxVSize(
  guard: CAT721GuardCovenant,
  changeAddress: string,
) {
  const dummyGuardPsbt = buildGuardTx(
    guard,
    getDummyUtxos(changeAddress, 1)[0],
    changeAddress,
    DUST_LIMIT,
  );
  return {
    dummyGuardPsbt,
    estGuardTxVSize: dummyGuardPsbt.estimateVSize(),
  };
}

function buildSendTx(
  tracableNfts: TracedCat721Nft[],
  guard: CAT721GuardCovenant,
  guardPsbt: CatPsbt,
  address: string,
  pubKey: string,
  outputNfts: (CAT721Covenant | undefined)[],
  changeAddress: string,
  feeRate: number,
  estimatedVSize?: number,
) {
  const inputNfts = tracableNfts.map((nft) => nft.nft);

  if (inputNfts.length + 2 > MAX_INPUT) {
    throw new Error(
      `Too many inputs that exceed the maximum input limit of ${MAX_INPUT}`,
    );
  }

  const sendPsbt = new CatPsbt();

  // add nft outputs
  for (const outputNft of outputNfts) {
    if (outputNft) {
      sendPsbt.addCovenantOutput(outputNft, Postage.TOKEN_POSTAGE);
    }
  }

  // add nft inputs
  for (const inputNft of inputNfts) {
    sendPsbt.addCovenantInput(inputNft);
  }

  sendPsbt
    .addCovenantInput(guard, GuardType.Transfer)
    .addFeeInputs([guardPsbt.getUtxo(2)])
    .change(changeAddress, feeRate, estimatedVSize);

  const inputCtxs = sendPsbt.calculateInputCtxs();
  const guardInputIndex = inputNfts.length;
  // unlock nft
  for (let i = 0; i < inputNfts.length; i++) {
    sendPsbt.updateCovenantInput(
      i,
      inputNfts[i],
      inputNfts[i].userSpend(
        i,
        inputCtxs,
        tracableNfts[i].trace,
        guard.getGuardInfo(guardInputIndex, guardPsbt.toTxHex()),
        isP2TR(address),
        pubKey,
      ),
    );
  }

  // unlock guard
  sendPsbt.updateCovenantInput(
    guardInputIndex,
    guard,
    guard.transfer(guardInputIndex, inputCtxs, outputNfts, guardPsbt.toTxHex()),
  );

  return sendPsbt;
}

function estimateSentTxVSize(
  tracableNfts: TracedCat721Nft[],
  guard: CAT721GuardCovenant,
  guardPsbt: CatPsbt,
  address: string,
  pubKey: string,
  outputNfts: (CAT721Covenant | undefined)[],
  changeAddress: string,
  feeRate: number,
) {
  return buildSendTx(
    tracableNfts,
    guard,
    guardPsbt,
    address,
    pubKey,
    outputNfts,
    changeAddress,
    feeRate,
  ).estimateVSize();
}
