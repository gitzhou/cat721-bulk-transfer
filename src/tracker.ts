import { Cat721Utxo } from '@cat-protocol/cat-sdk';
import axios from 'axios';
import { CollectionInfo } from './types';

export async function getCollectionInfo(
  host: string,
  collectionId: string,
): Promise<CollectionInfo | null> {
  try {
    const url = `${host}/api/collections/${collectionId}`;
    const response = await axios.get(url);
    console.assert(response.data.code === 0);
    return response.data.data;
  } catch {
    return null;
  }
}

export async function getNftUtxo(
  host: string,
  collectionId: string,
  localId: string,
): Promise<Cat721Utxo | null> {
  try {
    const url = `${host}/api/collections/${collectionId}/localId/${localId}/utxo`;
    const response = await axios.get(url);
    console.assert(response.data.code === 0);
    const utxo = response.data.data.utxo;
    Object.assign(utxo.state, { ownerAddr: utxo.state.address });
    delete utxo.state.address;
    utxo.state.localId = BigInt(utxo.state.localId);
    return utxo;
  } catch {
    return null;
  }
}
