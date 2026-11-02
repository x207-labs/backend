import { readConfig } from "./config.js";
import { startBroker } from "./broker.js";

// `npm start`: reads .env.example's variables from the environment and runs until the process is stopped.
const broker = await startBroker({ config: readConfig(process.env), log: (line) => console.log(line) });
console.log(`x207 broker listening at ${broker.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void broker.stop().then(() => process.exit(0)));
