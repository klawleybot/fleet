/**
 * Re-authenticate with Zora/Privy using wallet signing (SIWE)
 * Stores fresh JWT token in a state file for browser injection.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const PRIVY_APP_ID = "clpgf04wn04hnkw0fv1m11mnb";

interface SiweInitResponse {
  nonce?: string;
}

interface SiweAuthResponse {
  token?: string;
  refresh_token?: string;
  user?: {
    id?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSiweInitResponse(value: unknown): SiweInitResponse {
  if (!isRecord(value)) {
    return {};
  }

  return {
    nonce: typeof value.nonce === "string" ? value.nonce : undefined,
  };
}

function parseSiweAuthResponse(value: unknown): SiweAuthResponse {
  if (!isRecord(value)) {
    return {};
  }

  const user = isRecord(value.user) && typeof value.user.id === "string"
    ? { id: value.user.id }
    : undefined;

  return {
    token: typeof value.token === "string" ? value.token : undefined,
    refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
    user,
  };
}

async function main() {
  const pk = ("0x" + process.env.ZORA_PRIVATE_KEY) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  console.error("Account:", account.address);

  const headers = {
    "Content-Type": "application/json",
    "privy-app-id": PRIVY_APP_ID,
    "privy-client": "react-auth:1.91.0",
    "origin": "https://zora.co",
    "referer": "https://zora.co/",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  };

  // Step 1: Init SIWE
  const initResp = await fetch("https://auth.privy.io/api/v1/siwe/init", {
    method: "POST",
    headers,
    body: JSON.stringify({ address: account.address, chain_id: 8453 }),
  });
  const initData = parseSiweInitResponse(await initResp.json() as unknown);
  console.error("Init status:", initResp.status, JSON.stringify(initData).substring(0, 200));

  if (!initData.nonce) {
    console.error("No nonce — auth failed");
    process.exit(1);
  }

  // Step 2: Create SIWE message
  const message = createSiweMessage({
    domain: "privy.io",
    address: account.address,
    statement: "By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.",
    uri: "https://auth.privy.io",
    version: "1",
    chainId: 8453,
    nonce: initData.nonce,
  });

  console.error("Message:", message);

  // Step 3: Sign message
  const signature = await account.signMessage({ message });
  console.error("Signature:", signature.substring(0, 40) + "...");

  // Step 4: Authenticate
  const authResp = await fetch("https://auth.privy.io/api/v1/siwe/authenticate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      signature,
      chainId: "eip155:8453",
      walletClientType: "metamask",
      connectorType: "injected",
    }),
  });
  const authData = parseSiweAuthResponse(await authResp.json() as unknown);
  console.error("Auth status:", authResp.status);
  
  if (authData.token) {
    console.log(JSON.stringify({ 
      token: authData.token,
      refreshToken: authData.refresh_token,
      userId: authData.user?.id 
    }));
    console.error("Success! Token obtained.");
  } else {
    console.error("Auth failed:", JSON.stringify(authData).substring(0, 500));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
