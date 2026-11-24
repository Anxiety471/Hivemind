import { mirrorConfigFromEnv } from "./config.js";
import { createMirrorServer } from "./server.js";

const config = mirrorConfigFromEnv();
const server = await createMirrorServer(config);
server.listen(config.port, config.host, () => {
  console.log(
    `package mirror listening on http://${config.host}:${config.port} (public ${config.publicUrl})`,
  );
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
