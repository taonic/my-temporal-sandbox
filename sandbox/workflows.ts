import { proxyActivities } from "@temporalio/workflow";

import type * as activities from "./activities";

const { withdraw, deposit, refund } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

/**
 * Money-transfer saga: withdraw, then deposit, with a refund compensation
 * if the deposit fails. Returns a multi-line audit trail of the steps.
 */
export async function moneyTransfer(
  from: string,
  to: string,
  amount: number,
): Promise<strin> {
  const steps: string[] = [];
  steps.push(await withdraw(from, amount));

  try {
    steps.push(await deposit(to, amount));
  } catch (err) {
    steps.push(`✗ deposit failed: ${(err as Error).message}`);
    steps.push(await refund(from, amount));
    steps.push(`✗ transfer aborted, ${from} made whole again`);
    return steps.join("\n");
  }

  steps.push(`✓ transferred $${amount} from ${from} to ${to}`);
  return steps.join("\n");
}
