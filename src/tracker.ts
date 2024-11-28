import { Cat721Utxo } from '@cat-protocol/cat-sdk';
import axios from 'axios';

export async function getCollectionInfo(collectionId: string) {
  try {
    const url = `${process.env.TRACKER_HOST}/api/collections/${collectionId}`;
    const response = await axios.get(url);
    console.assert(response.data.code === 0);
    return response.data.data;
  } catch {
    return null;
  }
}

export async function getNftUtxo(
  collectionId: string,
  localId: string,
): Promise<Cat721Utxo | null> {
  try {
    const url = `${process.env.TRACKER_HOST}/api/collections/${collectionId}/localId/${localId}/utxo`;
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
