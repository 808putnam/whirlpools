import { AddressUtil, DecimalUtil, Percentage } from "@orca-so/common-sdk";
import { Address, BN, translateAddress } from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import {
  DecimalsMap,
  defaultConfig,
  defaultThresholdConfig,
  GetPricesConfig,
  PoolMap,
  PriceMap,
  ThresholdConfig,
  TickArrayMap,
  TickSpacingAccumulator,
} from ".";
import { swapQuoteWithParams } from "../quotes/public/swap-quote";
import { TickArray, WhirlpoolData } from "../types/public";
import { PoolUtil, PriceMath, SwapUtils } from "../utils/public";
import { PDAUtil } from "../utils/public/pda-utils";

function areQuoteTokensInMintsArray(mints: PublicKey[], quoteTokens: string[]): boolean {
  return quoteTokens.every((quoteToken) => mints.some((mint) => mint.toBase58() === quoteToken));
}

/**
 * calculatePoolPrices will calculate the price of each token in the given mints array
 * The price is calculated based on the pool with the highest liquidity
 * In order for the pool to be considered, it must have sufficient liquidity
 * Sufficient liquidity is defined by the thresholdAmount and priceImpactThreshold
 * For example, if the thresholdAmount is 1000 USDC and the priceImpactThreshold is 0.01
 * Then the pool must support 1000 USDC of liquidity without a price impact of 1%
 * In order to calculate sufficient liquidity, the caller of the function must provide
 * the tick arrays required to calculate the price impact
 * @param mints
 * @param poolMap
 * @param tickArrayMap
 * @returns PriceMap
 */
export function calculatePoolPrices(
  mints: PublicKey[],
  poolMap: PoolMap,
  tickArrayMap: TickArrayMap,
  decimalsMap: DecimalsMap,
  config = defaultConfig,
  thresholdConfig = defaultThresholdConfig
): PriceMap {
  // Ensure that quote tokens are in the mints array
  if (!areQuoteTokensInMintsArray(mints, config.quoteTokens)) {
    throw new Error("Quote tokens must be in mints array");
  }

  const mintSet = new Set(mints.map((mint) => mint.toBase58()));
  config.quoteTokens.forEach((quoteToken) => mintSet.add(quoteToken));
  mints = Array.from(mintSet).map((mint) => new PublicKey(mint));

  const remainingQuoteTokens = config.quoteTokens.map((token) => new PublicKey(token));

  const prices: PriceMap = {};

  while (remainingQuoteTokens.length > 0 && mints.length > 0) {
    // Get prices for mints using the next token in remainingQuoteTokens as the quote token
    const quoteToken = remainingQuoteTokens.shift();
    if (!quoteToken) {
      throw new Error("Unreachable: remainingQuoteTokens is an empty array");
    }

    const price = calculatePricesForQuoteToken(
      mints,
      quoteToken,
      poolMap,
      tickArrayMap,
      decimalsMap,
      config,
      thresholdConfig
    );

    // Populate the price map with any prices that were calculated
    // Use the price of the quote token against the first quote token
    mints.forEach((mint) => {
      // Get the price of the mint token against the quote token
      const mintPrice = price[mint.toBase58()];
      // Get the price of the quote token against the first quote token
      const quoteTokenPrice = prices[quoteToken.toBase58()] || price[quoteToken.toBase58()];
      if (mintPrice != null && quoteTokenPrice != null) {
        prices[mint.toBase58()] = mintPrice.mul(quoteTokenPrice);
      }
    });

    // Filter out any mints that do not have a price
    mints = mints.filter((mint) => prices[mint.toBase58()] == null);
  }

  return prices;
}

function checkLiquidityThreshold(
  pool: WhirlpoolData,
  tickArrays: TickArray[],
  aToB: boolean,
  thresholdConfig: ThresholdConfig,
  decimalsMap: DecimalsMap
): boolean {
  const { amountThreshold, priceImpactThreshold } = thresholdConfig;
  const { estimatedAmountOut } = swapQuoteWithParams(
    {
      whirlpoolData: pool,
      aToB,
      amountSpecifiedIsInput: true,
      tokenAmount: amountThreshold,
      otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
      sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
      tickArrays,
    },
    Percentage.fromDecimal(new Decimal(0))
  );

  const price = getPrice(pool, decimalsMap).pow(aToB ? 1 : -1);

  const inputDecimals = decimalsMap[aToB ? pool.tokenMintA.toBase58() : pool.tokenMintB.toBase58()];
  const outputDecimals =
    decimalsMap[aToB ? pool.tokenMintB.toBase58() : pool.tokenMintA.toBase58()];

  const amountInDecimals = DecimalUtil.fromU64(amountThreshold, inputDecimals);

  const estimatedAmountOutInDecimals = DecimalUtil.fromU64(estimatedAmountOut, outputDecimals);

  const amountOutThreshold = amountInDecimals
    .mul(price)
    .div(priceImpactThreshold)
    .toDecimalPlaces(outputDecimals);

  // console.log("amountInDecimals", amountInDecimals.toString());
  // console.log("price", price.toString());
  // console.log("estimatedAmountOutInDecimals", estimatedAmountOutInDecimals.toString());
  // console.log("amountOutThreshold", amountOutThreshold.toString());

  return amountOutThreshold.lte(estimatedAmountOutInDecimals);

  // TODO: Calculate the opposite direction
}

function getMostLiquidPool(
  mintA: Address,
  mintB: Address,
  poolMap: PoolMap,
  config = defaultConfig
): TickSpacingAccumulator | null {
  const { tickSpacings, programId, whirlpoolsConfig } = config;
  const pools = tickSpacings
    .map((tickSpacing) => {
      const pda = PDAUtil.getWhirlpool(
        programId,
        whirlpoolsConfig,
        AddressUtil.toPubKey(mintA),
        AddressUtil.toPubKey(mintB),
        tickSpacing
      );

      return { address: pda.publicKey, pool: poolMap[pda.publicKey.toBase58()] };
    })
    .filter(({ pool }) => pool != null);

  if (pools.length === 0) {
    return null;
  }

  return pools.slice(1).reduce<TickSpacingAccumulator>((acc, { address, pool }) => {
    if (pool.liquidity.lt(acc.pool.liquidity)) {
      return acc;
    }

    return { pool, address };
  }, pools[0]);
}

function calculatePricesForQuoteToken(
  mints: PublicKey[],
  quoteTokenMint: PublicKey,
  poolMap: PoolMap,
  tickArrayMap: TickArrayMap,
  decimalsMap: DecimalsMap,
  config: GetPricesConfig,
  thresholdConfig: ThresholdConfig
): PriceMap {
  return Object.fromEntries(
    mints.map((mint) => {
      if (mint.equals(quoteTokenMint)) {
        return [mint.toBase58(), new Decimal(1)];
      }

      const [mintA, mintB] = PoolUtil.orderMints(mint, quoteTokenMint);
      const aToB = translateAddress(mintA).equals(quoteTokenMint);

      const poolCandidate = getMostLiquidPool(mintA, mintB, poolMap, config);
      if (poolCandidate == null) {
        return [mint.toBase58(), null];
      }

      const { pool, address } = poolCandidate;

      const tickArrays = getTickArrays(pool, address, aToB, tickArrayMap, config);

      const thresholdPassed = checkLiquidityThreshold(
        pool,
        tickArrays,
        aToB,
        thresholdConfig,
        decimalsMap
      );

      if (!thresholdPassed) {
        return [mint.toBase58(), null];
      }

      const price = getPrice(pool, decimalsMap);
      const quotePrice = aToB ? price : price.pow(-1);
      return [mint.toBase58(), quotePrice];
    })
  );
}

function getTickArrays(
  pool: WhirlpoolData,
  address: PublicKey,
  aToB: boolean,
  tickArrayMap: TickArrayMap,
  config = defaultConfig
): TickArray[] {
  const { programId } = config;
  const tickArrayPublicKeys = SwapUtils.getTickArrayPublicKeys(
    pool.tickCurrentIndex,
    pool.tickSpacing,
    aToB,
    programId,
    address
  );

  return tickArrayPublicKeys.map((tickArrayPublicKey) => {
    return { address: tickArrayPublicKey, data: tickArrayMap[tickArrayPublicKey.toBase58()] };
  });
}

function getPrice(pool: WhirlpoolData, decimalsMap: DecimalsMap) {
  const tokenAAddress = pool.tokenMintA.toBase58();
  const tokenBAddress = pool.tokenMintB.toBase58();
  if (!(tokenAAddress in decimalsMap) || !(tokenBAddress in decimalsMap)) {
    throw new Error("Missing token decimals");
  }

  return PriceMath.sqrtPriceX64ToPrice(
    pool.sqrtPrice,
    decimalsMap[tokenAAddress],
    decimalsMap[tokenBAddress]
  );
}
