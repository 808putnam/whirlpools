import { EMPTY_INSTRUCTION, TransactionBuilder, ZERO } from "@orca-so/common-sdk";
import { ResolvedTokenAddressInstruction } from "@orca-so/common-sdk/dist/helpers/token-instructions";
import {
  NATIVE_MINT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  u64,
  Token,
  AccountInfo,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { SwapUtils, TickArrayUtil, Whirlpool, WhirlpoolContext } from "../..";
import { createWSOLAccountInstructions } from "../../utils/spl-token-utils";
import { SwapInput, swapIx } from "../swap-ix";

export type SwapAsyncParams = {
  swapInput: SwapInput;
  whirlpool: Whirlpool;
  wallet: PublicKey;
};

/**
 * Swap instruction builder method with resolveATA & additional checks.
 * @param ctx - WhirlpoolContext object for the current environment.
 * @param params - {@link SwapAsyncParams}
 * @param refresh - If true, the network calls will always fetch for the latest values.
 * @returns
 */
export async function swapAsync(
  ctx: WhirlpoolContext,
  params: SwapAsyncParams,
  refresh: boolean,
  txBuilder: TransactionBuilder = new TransactionBuilder(ctx.connection, ctx.wallet)
): Promise<TransactionBuilder> {
  const { wallet, whirlpool, swapInput } = params;
  const data = whirlpool.getData();
  return swapAsyncFromKeys(
    ctx,
    wallet,
    swapInput,
    whirlpool.getAddress(),
    data.tokenMintA,
    data.tokenMintB,
    data.tokenVaultA,
    data.tokenVaultB,
    null,
    refresh,
    txBuilder
  );
}

export async function swapAsyncFromKeys(
  ctx: WhirlpoolContext,
  wallet: PublicKey,
  swapInput: SwapInput,
  whirlpool: PublicKey,
  tokenMintA: PublicKey,
  tokenMintB: PublicKey,
  tokenVaultA: PublicKey,
  tokenVaultB: PublicKey,
  atas: AccountInfo[] | null,
  refresh: boolean,
  txBuilder: TransactionBuilder = new TransactionBuilder(ctx.connection, ctx.wallet)
): Promise<TransactionBuilder> {
  const { aToB, amount } = swapInput;
  const tickArrayAddresses = [swapInput.tickArray0, swapInput.tickArray1, swapInput.tickArray2];

  const ta = performance.now();
  let uninitializedArrays = await TickArrayUtil.getUninitializedArraysString(
    tickArrayAddresses,
    ctx.fetcher,
    refresh
  );
  if (uninitializedArrays) {
    throw new Error(`TickArray addresses - [${uninitializedArrays}] need to be initialized.`);
  }

  const tb = performance.now();
  const [resolvedAtaA, resolvedAtaB] = await cachedResolveOrCreateATAs(
    wallet,
    [
      { tokenMint: tokenMintA, wrappedSolAmountIn: aToB ? amount : ZERO },
      { tokenMint: tokenMintB, wrappedSolAmountIn: !aToB ? amount : ZERO },
    ],
    () => ctx.fetcher.getAccountRentExempt(),
    (keys) => {
      if (atas != null) {
        return Promise.resolve(
          keys.map((key) =>
            atas.find((ata) => ata.address?.toBase58() === key.toBase58())
          ) as AccountInfo[]
        );
      } else {
        return ctx.fetcher.listTokenInfos(keys, false);
      }
    }
  );
  const { address: ataAKey, ...tokenOwnerAccountAIx } = resolvedAtaA;
  const { address: ataBKey, ...tokenOwnerAccountBIx } = resolvedAtaB;
  txBuilder.addInstructions([tokenOwnerAccountAIx, tokenOwnerAccountBIx]);
  const inputTokenAccount = aToB ? ataAKey : ataBKey;
  const outputTokenAccount = aToB ? ataBKey : ataAKey;

  return txBuilder.addInstruction(
    swapIx(
      ctx.program,
      SwapUtils.getSwapParamsFromQuoteKeys(
        swapInput,
        ctx,
        whirlpool,
        tokenVaultA,
        tokenVaultB,
        inputTokenAccount,
        outputTokenAccount,
        wallet
      )
    )
  );
}

/**
 * Internal duplicate of resolveOrCreateAta
 * This could be ported over to common-sdk?
 *
 * IMPORTANT: wrappedSolAmountIn should only be used for input/source token that
 *            could be SOL. This is because when SOL is the output, it is the end
 *            destination, and thus does not need to be wrapped with an amount.
 *
 * @param ownerAddress The user's public key
 * @param tokenMint Token mint address
 * @param payer Payer that would pay the rent for the creation of the ATAs
 * @param modeIdempotent Optional. Use CreateIdempotent instruction instead of Create instruction
 * @returns
 */
export async function cachedResolveOrCreateATAs(
  ownerAddress: PublicKey,
  requests: any[] /* This type needs to be exported from common-sdk */,
  getAccountRentExempt: () => Promise<number>,
  getTokenAccounts: (keys: PublicKey[]) => Promise<Array<AccountInfo | null>>,
  payer = ownerAddress,
  modeIdempotent: boolean = false
): Promise<ResolvedTokenAddressInstruction[]> {
  const nonNativeMints = requests.filter(({ tokenMint }) => !tokenMint.equals(NATIVE_MINT));
  const nativeMints = requests.filter(({ tokenMint }) => tokenMint.equals(NATIVE_MINT));

  if (nativeMints.length > 1) {
    throw new Error("Cannot resolve multiple WSolAccounts");
  }

  let instructionMap: { [tokenMint: string]: ResolvedTokenAddressInstruction } = {};
  if (nonNativeMints.length > 0) {
    const nonNativeAddresses = await Promise.all(
      nonNativeMints.map(({ tokenMint }) => deriveATA(ownerAddress, tokenMint))
    );

    const tokenAccounts = await getTokenAccounts(nonNativeAddresses);
    tokenAccounts.forEach((tokenAccount, index) => {
      const ataAddress = nonNativeAddresses[index]!;
      let resolvedInstruction;
      if (tokenAccount) {
        // ATA whose owner has been changed is abnormal entity.
        // To prevent to send swap/withdraw/collect output to the ATA, an error should be thrown.
        if (!tokenAccount.owner.equals(ownerAddress)) {
          throw new Error(`ATA with change of ownership detected: ${ataAddress.toBase58()}`);
        }

        resolvedInstruction = { address: ataAddress, ...EMPTY_INSTRUCTION };
      } else {
        const createAtaInstruction = createAssociatedTokenAccountInstruction(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          nonNativeMints[index]!.tokenMint,
          ataAddress,
          ownerAddress,
          payer,
          modeIdempotent
        );

        resolvedInstruction = {
          address: ataAddress,
          instructions: [createAtaInstruction],
          cleanupInstructions: [],
          signers: [],
        };
      }
      instructionMap[nonNativeMints[index].tokenMint.toBase58()] = resolvedInstruction;
    });
  }

  if (nativeMints.length > 0) {
    const accountRentExempt = await getAccountRentExempt();
    const wrappedSolAmountIn = nativeMints[0]?.wrappedSolAmountIn || new u64(0);
    instructionMap[NATIVE_MINT.toBase58()] = createWSOLAccountInstructions(
      ownerAddress,
      wrappedSolAmountIn,
      accountRentExempt
    );
  }

  // Preserve order of resolution
  return requests.map(({ tokenMint }) => instructionMap[tokenMint.toBase58()]);
}

export async function deriveATA(ownerAddress: PublicKey, tokenMint: PublicKey): Promise<PublicKey> {
  return await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    tokenMint,
    ownerAddress
  );
}

function createAssociatedTokenAccountInstruction(
  associatedTokenProgramId: PublicKey,
  tokenProgramId: PublicKey,
  mint: PublicKey,
  associatedAccount: PublicKey,
  owner: PublicKey,
  payer: PublicKey,
  modeIdempotent: boolean
): TransactionInstruction {
  if (!modeIdempotent) {
    return Token.createAssociatedTokenAccountInstruction(
      associatedTokenProgramId,
      tokenProgramId,
      mint,
      associatedAccount,
      owner,
      payer
    );
  }

  // create CreateIdempotent instruction
  // spl-token v0.1.8 doesn't have a method for CreateIdempotent.
  // https://github.com/solana-labs/solana-program-library/blob/master/associated-token-account/program/src/instruction.rs#L26
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedAccount, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
  ];
  const instructionData = Buffer.from([1]);

  return new TransactionInstruction({
    keys,
    programId: associatedTokenProgramId,
    data: instructionData,
  });
}
