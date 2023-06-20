import { AccountFetchOpts } from "@orca-so/common-sdk";
import BN from "bn.js";
import { PoolUtil, TokenInfo } from "..";
import { WhirlpoolAccountCacheInterface } from "../network/public/account-cache";
import {
  TokenAccountInfo,
  WhirlpoolData,
  WhirlpoolRewardInfo,
  WhirlpoolRewardInfoData,
} from "../types/public";

export async function getTokenMintInfos(
  cache: WhirlpoolAccountCacheInterface,
  data: WhirlpoolData,
  opts?: AccountFetchOpts
): Promise<TokenInfo[]> {
  const mintA = data.tokenMintA;
  const infoA = await cache.getMintInfo(mintA, opts);
  if (!infoA) {
    throw new Error(`Unable to fetch MintInfo for mint - ${mintA}`);
  }
  const mintB = data.tokenMintB;
  const infoB = await cache.getMintInfo(mintB, opts);
  if (!infoB) {
    throw new Error(`Unable to fetch MintInfo for mint - ${mintB}`);
  }
  return [
    { mint: mintA, ...infoA },
    { mint: mintB, ...infoB },
  ];
}

export async function getRewardInfos(
  cache: WhirlpoolAccountCacheInterface,
  data: WhirlpoolData,
  opts?: AccountFetchOpts
): Promise<WhirlpoolRewardInfo[]> {
  const rewardInfos: WhirlpoolRewardInfo[] = [];
  for (const rewardInfo of data.rewardInfos) {
    rewardInfos.push(await getRewardInfo(cache, rewardInfo, opts));
  }
  return rewardInfos;
}

async function getRewardInfo(
  cache: WhirlpoolAccountCacheInterface,
  data: WhirlpoolRewardInfoData,
  opts?: AccountFetchOpts
): Promise<WhirlpoolRewardInfo> {
  const rewardInfo = { ...data, initialized: false, vaultAmount: new BN(0) };
  if (PoolUtil.isRewardInitialized(data)) {
    const vaultInfo = await cache.getTokenInfo(data.vault, opts);
    if (!vaultInfo) {
      throw new Error(`Unable to fetch TokenAccountInfo for vault - ${data.vault}`);
    }
    rewardInfo.initialized = true;
    rewardInfo.vaultAmount = new BN(vaultInfo.amount.toString());
  }
  return rewardInfo;
}

export async function getTokenVaultAccountInfos(
  cache: WhirlpoolAccountCacheInterface,
  data: WhirlpoolData,
  opts?: AccountFetchOpts
): Promise<TokenAccountInfo[]> {
  const vaultA = data.tokenVaultA;
  const vaultInfoA = await cache.getTokenInfo(vaultA, opts);
  if (!vaultInfoA) {
    throw new Error(`Unable to fetch TokenAccountInfo for vault - ${vaultA}`);
  }
  const vaultB = data.tokenVaultB;
  const vaultInfoB = await cache.getTokenInfo(vaultB, opts);
  if (!vaultInfoB) {
    throw new Error(`Unable to fetch TokenAccountInfo for vault - ${vaultB}`);
  }
  return [vaultInfoA, vaultInfoB];
}
