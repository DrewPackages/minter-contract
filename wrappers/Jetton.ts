import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Sender,
  SendMode,
  toNano,
  Slice,
  Builder,
  Dictionary,
} from "@ton/core";
import { Sha256 } from "@aws-crypto/sha256-js";
import { compile } from "@ton/blueprint";

/*
owner: Address.parse("EQD4gS-Nj2Gjr2FYtg-s3fXUvjzKbzHGZ5_1Xe_V0-GCp0p2"),
name: "MyJetton",
symbol: "JET1",
image: "https://www.linkpicture.com/q/download_183.png", // Image url
description: "My jetton",
*/

const ONCHAIN_CONTENT_PREFIX = 0x00;
const SNAKE_PREFIX = 0x00;

const sha256 = (str: string) => {
  const sha = new Sha256();
  sha.update(str);
  return Buffer.from(sha.digestSync());
};

export type JettonMetaDataKeys = "name" | "description" | "image" | "symbol";

const jettonOnChainMetadataSpec: {
  [key in JettonMetaDataKeys]: "utf8" | "ascii" | undefined;
} = {
  name: "utf8",
  description: "utf8",
  image: "ascii",
  symbol: "utf8",
};

export function mintBody(
  owner: Address,
  jettonAmount: bigint,
  transferToJWallet: bigint,
  queryId?: number
): Cell {
  return beginCell()
    .storeUint(Opcodes.Mint, 32)
    .storeUint(queryId ?? 0, 64) // queryid
    .storeAddress(owner)
    .storeCoins(transferToJWallet)
    .storeRef(
      // internal transfer message
      beginCell()
        .storeUint(Opcodes.InternalTransfer, 32)
        .storeUint(queryId ?? 0, 64)
        .storeCoins(jettonAmount)
        .storeAddress(null)
        .storeAddress(owner)
        .storeCoins(toNano(0.001))
        .storeBit(false) // forward_payload in this slice, not separate cell
        .endCell()
    )
    .endCell();
}

export const Opcodes = {
  Mint: 0x15,
  InternalTransfer: 0x178d4519,
};

export type JettonInitial = {
  $$type: "JettonInitial";
  treasury: Address;
  minting_info: Cell;
  token_content: Cell;
};

export function storeJettonInitial(src: JettonInitial) {
  return (builder: Builder) => {
    const b_0 = builder;
    b_0.storeUint(2412644301, 32);
    b_0.storeAddress(src.treasury);
    b_0.storeRef(src.minting_info);
    b_0.storeRef(src.token_content);
  };
}

export type TokenBurnNotification = {
  $$type: "TokenBurnNotification";
  query_id: bigint;
  amount: bigint;
  response_destination: Address;
};

export function storeTokenBurnNotification(src: TokenBurnNotification) {
  return (builder: Builder) => {
    const b_0 = builder;
    b_0.storeUint(2078119902, 32);
    b_0.storeUint(src.query_id, 64);
    b_0.storeCoins(src.amount);
    b_0.storeAddress(src.response_destination);
  };
}

export function buildTokenMetadataCell(data: { [s: string]: string | undefined }): Cell {
  const KEYLEN = 256;
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(KEYLEN / 8), Dictionary.Values.Cell());

  Object.entries(data).forEach(([k, v]: [string, string | undefined]) => {
    if (!jettonOnChainMetadataSpec[k as JettonMetaDataKeys])
      throw new Error(`Unsupported onchain key: ${k}`);
    if (v === undefined || v === "") return;

    let bufferToStore = Buffer.from(v, jettonOnChainMetadataSpec[k as JettonMetaDataKeys]);

    const CELL_MAX_SIZE_BYTES = Math.floor((1023 - 8) / 8);

    const rootCell = new Builder();
    rootCell.storeUint(SNAKE_PREFIX, 8);
    let currentCell = rootCell;

    while (bufferToStore.length > 0) {
      currentCell.storeBuffer(bufferToStore.slice(0, CELL_MAX_SIZE_BYTES));
      bufferToStore = bufferToStore.slice(CELL_MAX_SIZE_BYTES);
      if (bufferToStore.length > 0) {
        const newCell = new Builder();
        currentCell.storeRef(newCell).endCell();
        currentCell = newCell;
      }
    }

    dict.set(sha256(k).slice(0, KEYLEN), rootCell.endCell());
  });

  return beginCell().storeInt(ONCHAIN_CONTENT_PREFIX, 8).storeDict(dict).endCell();
}

async function jettonMinterInitData(
  owner: Address,
  metadata: { [s in JettonMetaDataKeys]?: string }
): Promise<Cell> {
  return beginCell()
    .storeCoins(0)
    .storeAddress(owner)
    .storeRef(buildTokenMetadataCell(metadata))
    .storeRef(await compile("JettonWallet"))
    .endCell();
}

export class Jetton implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromAddress(address: Address) {
    return new Jetton(address);
  }

  static async createFromConfig(
    { owner, ...config }: { [s in JettonMetaDataKeys]?: string } & { owner: Address },
    code: Cell,
    workchain = 0
  ) {
    const data = await jettonMinterInitData(owner, config);
    const init = { code, data };
    return new Jetton(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendMint(
    provider: ContractProvider,
    via: Sender,
    opts: {
      value: bigint;
      to: Address;
      amount: bigint;
      queryID?: number;
    }
  ) {
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: mintBody(opts.to, opts.amount, opts.value, opts.queryID),
    });
  }

  async send(
    provider: ContractProvider,
    via: Sender,
    args: { value: bigint; bounce?: boolean | null | undefined },
    message: JettonInitial | string | "Owner Claim" | "Mint" | TokenBurnNotification
  ) {
    let body: Cell | null = null;
    if (
      message &&
      typeof message === "object" &&
      !(message instanceof Slice) &&
      message.$$type === "JettonInitial"
    ) {
      body = beginCell().store(storeJettonInitial(message)).endCell();
    }
    if (typeof message === "string") {
      body = beginCell().storeUint(0, 32).storeStringTail(message).endCell();
    }
    if (message === "Owner Claim") {
      body = beginCell().storeUint(0, 32).storeStringTail(message).endCell();
    }
    if (message === "Mint") {
      body = beginCell().storeUint(0, 32).storeStringTail(message).endCell();
    }
    if (
      message &&
      typeof message === "object" &&
      !(message instanceof Slice) &&
      message.$$type === "TokenBurnNotification"
    ) {
      body = beginCell().store(storeTokenBurnNotification(message)).endCell();
    }
    if (body === null) {
      throw new Error("Invalid message type");
    }

    await provider.internal(via, { ...args, body: body });
  }

  async getJettonData(provider: ContractProvider) {
    const result = await provider.get("get_jetton_data", []);
    const totalSupply = result.stack.readBigNumber();
    const mintable = result.stack.readBoolean();
    const adminAddress = result.stack.readAddress();
    const content = result.stack.readCell();
    const walletCode = result.stack.readCell();
    return {
      totalSupply,
      mintable,
      adminAddress,
      content,
      walletCode,
    };
  }

  async getWalletAddress(provider: ContractProvider, owner: Address) {
    const result = await provider.get("get_wallet_address", [
      { type: "slice", cell: beginCell().storeAddress(owner).endCell() },
    ]);
    return result.stack.readAddress();
  }
}
