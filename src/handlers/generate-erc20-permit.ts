import { PERMIT2_ADDRESS, PermitTransferFrom, SignatureTransfer } from "@uniswap/permit2-sdk";
import { ethers, keccak256, MaxInt256, parseUnits, toUtf8Bytes } from "ethers";
import { Context, Logger } from "../types/context";
import { PermitReward, TokenType } from "../types";
import { decrypt, parseDecryptedPrivateKey } from "../utils";
import { getFastestProvider } from "../utils/get-fastest-provider";

export interface Payload {
  evmNetworkId: number;
  evmPrivateEncrypted: string;
  walletAddress: string;
  issueNodeId: string;
  logger: Logger;
  userId: number;
}

export async function generateErc20PermitSignature(payload: Payload, username: string, amount: number, tokenAddress: string): Promise<PermitReward>;
export async function generateErc20PermitSignature(context: Context, username: string, amount: number, tokenAddress: string): Promise<PermitReward>;
export async function generateErc20PermitSignature(
  contextOrPayload: Context | Payload,
  username: string,
  amount: number,
  tokenAddress: string
): Promise<PermitReward> {
  let _logger: Logger;
  const _username = username;
  let _walletAddress: string | null | undefined;
  let _issueNodeId: string;
  let _evmNetworkId: number;
  let _evmPrivateEncrypted: string;
  let _userId: number;

  if ("issueNodeId" in contextOrPayload) {
    _logger = contextOrPayload.logger as Logger;
    _walletAddress = contextOrPayload.walletAddress;
    _evmNetworkId = contextOrPayload.evmNetworkId;
    _evmPrivateEncrypted = contextOrPayload.evmPrivateEncrypted;
    _issueNodeId = contextOrPayload.issueNodeId;
    _userId = contextOrPayload.userId;
  } else {
    const config = contextOrPayload.config;
    _logger = contextOrPayload.logger;
    const { evmNetworkId, evmPrivateEncrypted } = config;
    const { data: userData } = await contextOrPayload.octokit.users.getByUsername({ username: _username });
    if (!userData) {
      throw new Error(`GitHub user was not found for id ${_username}`);
    }
    _userId = userData.id;
    const { wallet } = contextOrPayload.adapters.supabase;
    _walletAddress = await wallet.getWalletByUserId(_userId);
    _evmNetworkId = evmNetworkId;
    _evmPrivateEncrypted = evmPrivateEncrypted;
    if ("issue" in contextOrPayload.payload) {
      _issueNodeId = contextOrPayload.payload.issue.node_id;
    } else if ("pull_request" in contextOrPayload.payload) {
      _issueNodeId = contextOrPayload.payload.pull_request.node_id;
    } else {
      throw new Error("Issue Id is missing");
    }
  }

  if (!_username) {
    throw new Error("User was not found");
  }
  if (!_walletAddress) {
    const errorMessage = "ERC20 Permit generation error: Wallet not found";
    _logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  const provider = await getFastestProvider(_evmNetworkId);
  if (!provider) {
    _logger.error("Provider is not defined");
    throw new Error("Provider is not defined");
  }

  let privateKey = null;
  try {
    const privateKeyDecrypted = await decrypt(_evmPrivateEncrypted, String(process.env.X25519_PRIVATE_KEY));
    const privateKeyParsed = parseDecryptedPrivateKey(privateKeyDecrypted);
    privateKey = privateKeyParsed.privateKey;
    if (!privateKey) throw new Error("Private key is not defined");
  } catch (error) {
    const errorMessage = `Failed to decrypt a private key: ${error}`;
    _logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  let adminWallet;
  let tokenDecimals;

  try {
    adminWallet = new ethers.Wallet(privateKey, provider);
  } catch (error) {
    const errorMessage = `Failed to instantiate wallet: ${error}`;
    _logger.debug(errorMessage);
    throw new Error(errorMessage);
  }

  try {
    const erc20Abi = ["function decimals() public view returns (uint8)"];
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
    tokenDecimals = await tokenContract.decimals();
  } catch (error) {
    const errorMessage = `Failed to get token decimals for token: ${tokenAddress}`;
    _logger.debug(errorMessage);
    throw new Error(errorMessage);
  }

  const permitTransferFromData: PermitTransferFrom = {
    permitted: {
      token: tokenAddress,
      amount: parseUnits(amount.toString(), tokenDecimals),
    },
    spender: _walletAddress,
    nonce: BigInt(keccak256(toUtf8Bytes(`${_userId}-${_issueNodeId}`))),
    deadline: MaxInt256,
  };

  const { domain, types, values } = SignatureTransfer.getPermitData(permitTransferFromData, PERMIT2_ADDRESS, _evmNetworkId);

  const signature = await adminWallet
    .signTypedData(
      {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId ? domain.chainId.toString() : undefined,
        verifyingContract: domain.verifyingContract,
        salt: domain.salt?.toString(),
      },
      types,
      values
    )
    .catch((error) => {
      const errorMessage = `Failed to sign typed data ${error}`;
      _logger.error(errorMessage);
      throw new Error(errorMessage);
    });

  const erc20Permit: PermitReward = {
    tokenType: TokenType.ERC20,
    tokenAddress: permitTransferFromData.permitted.token,
    beneficiary: permitTransferFromData.spender,
    nonce: permitTransferFromData.nonce.toString(),
    deadline: permitTransferFromData.deadline.toString(),
    amount: permitTransferFromData.permitted.amount.toString(),
    owner: adminWallet.address,
    signature: signature,
    networkId: _evmNetworkId,
  };

  _logger.info("Generated ERC20 permit2 signature", erc20Permit);

  return erc20Permit;
}
