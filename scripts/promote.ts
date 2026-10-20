import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";

import {
  listModerators,
  setModeratorRole,
  ProvisioningError,
} from "./promote-core";

config({ path: ".env", quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const list = args.length === 1 && args[0] === "--list";
  const revoke = args.includes("--revoke");
  const userId = args.find((arg) => !arg.startsWith("--"));
  if (
    !list &&
    (!userId ||
      userId.includes("@") ||
      args.length !== (revoke ? 2 : 1) ||
      args.some((arg) => arg.startsWith("--") && arg !== "--revoke"))
  ) {
    throw new ProvisioningError(
      "Usage: npm run promote -- <V-Auth-app-user-id> [--revoke] | --list",
    );
  }
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url)
    throw new ProvisioningError("DIRECT_URL or DATABASE_URL is not set.");
  const sql = neon(url);
  if (list) {
    const moderators = await listModerators(sql);
    if (!moderators.length) console.log("No moderators configured.");
    for (const moderator of moderators) console.log(JSON.stringify(moderator));
    return;
  }
  const result = await setModeratorRole(sql, userId!, revoke);
  console.log(JSON.stringify(result));
  if (result.moderator && result.handle)
    console.log(`Set MOD_SCRIPT_MEMBER_HANDLE=${result.handle} on the Worker.`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ProvisioningError
      ? error.message
      : "Moderator provisioning failed. Check the user ID, existing V Auth linkage, member state and database access. No role change is guaranteed.",
  );
  process.exitCode = 1;
});
