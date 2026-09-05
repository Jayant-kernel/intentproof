import "dotenv/config";

import { createApp } from "./app.js";
import { ControlRoomService } from "./control-room/service.js";
import { AuditStore } from "./ledger/audit-store.js";

const webhookSecret = process.env.WEBHOOK_SECRET;
if (!webhookSecret) {
  throw new Error("WEBHOOK_SECRET is required. Copy .env.example to .env and set it locally.");
}

const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const auditStore = new AuditStore(process.env.DB_PATH ?? "./intentproof.db");
const secrets = [webhookSecret, process.env.WEBHOOK_SECRET_PREVIOUS ?? ""];
const controlRoom = new ControlRoomService({ rootDirectory: process.cwd(), auditStore });
const app = createApp({ auditStore, webhookSecrets: secrets, controlRoom });

const server = app.listen(port, () => {
  process.stderr.write(`IntentProof webhook intake listening on http://localhost:${port}\n`);
});

function shutdown(): void {
  server.close(() => {
    auditStore.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
