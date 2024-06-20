import { toNano } from "@ton/core";
import { compile, NetworkProvider } from "@ton/blueprint";
import { Jetton } from "../wrappers/Jetton";

export async function run(provider: NetworkProvider) {
  const name = process.env.TOKEN_NAME;
  const description = process.env.TOKEN_DESCRIPTION;
  const symbol = process.env.TOKEN_SYMBOL;
  const image = process.env.TOKEN_IMAGE;

  const minter = provider.open(
    await Jetton.createFromConfig(
      {
        owner: provider.sender().address!,
        name,
        description,
        symbol,
        image,
      },
      await compile("Jetton")
    )
  );

  await minter.sendDeploy(provider.sender(), toNano("0.05"));

  await provider.waitForDeploy(minter.address);
}
