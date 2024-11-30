import { Cat721Utxo, Signer } from '@cat-protocol/cat-sdk';

export interface Source {
  address: string;
  wif: string;
  localId: string;
  destAddress: string;
  nftUtxo?: Cat721Utxo | null;
  signer?: Signer;
}

export interface CollectionInfo {
  minterAddr: string;
  metadata: {
    name: string;
    symbol: string;
  };
}
