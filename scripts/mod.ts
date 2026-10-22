import { config } from "dotenv";
import { runCli } from "./mod-run";

config({ override: false, quiet: true });

runCli(process.argv.slice(2), { signalExit: (code) => process.exit(code) })
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error("Moderation could not be completed.");
    process.exitCode = 1;
  });
