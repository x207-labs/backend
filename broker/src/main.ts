import { readConfig } from "./config.js";
import { startBroker } from "./broker.js";
import { jsonLine } from "./log.js";

// `npm start`: reads .env.example's variables from the environment and runs until the process is stopped.
const broker = await startBroker({ config: readConfig(process.env), log: jsonLine() });
jsonLine()(`x207 broker listening at ${broker.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void broker.stop().then(() => process.exit(0)));

// BK-011: SIGHUP re-reads BROKER_SECRETS_FILE (a dotenv file) and rotates every provider to the value now in its variable. No grant is cut.
if (process.env.BROKER_SECRETS_FILE) {
  process.on("SIGHUP", () => {
    try {
      process.loadEnvFile(process.env.BROKER_SECRETS_FILE as string);
      for (const provider of readConfig(process.env).providers) {
        const version = broker.providers.rotate(provider.assetType, provider.secretEnv, process.env);
        jsonLine()(`secret of ${provider.assetType} rotated, version ${version}`);
      }
    } catch (error) {
      jsonLine()(`rotation failed, the old secrets stay: ${(error as Error).message}`);
    }
  });
}
