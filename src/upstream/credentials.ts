import { assertTestModeKeyId } from "./razorpay-mcp.js";

export interface TestModeCredentials {
  keyId: string;
  keySecret: string;
}

export function testModeCredentialsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): TestModeCredentials | null {
  const keyId = environment.RZP_KEY_ID;
  const keySecret = environment.RZP_KEY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }
  assertTestModeKeyId(keyId);
  return { keyId, keySecret };
}
