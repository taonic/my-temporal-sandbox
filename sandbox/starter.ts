import { Client, Connection } from "@temporalio/client";

import { TASK_QUEUE } from "./shared";
import { moneyTransfer } from "./workflows";

// Edit these to change the demo. $13 triggers the saga's compensation path.
const FROM = "alice";
const TO = "bob";
const AMOUNT = 20;

async function main(): Promise<void> {
  const connection = await Connection.connect();
  try {
    const client = new Client({ connection });
    const handle = await client.workflow.start(moneyTransfer, {
      args: [FROM, TO, AMOUNT],
      taskQueue: TASK_QUEUE,
      workflowId: `transfer-${FROM}-${TO}-${AMOUNT}-${Date.now()}`,
    });
    console.log(`Started workflow ${handle.workflowId}`);
    const result = await handle.result();
    console.log(result);
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
