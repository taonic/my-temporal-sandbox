export async function withdraw(account: string, amount: number): Promise<string> {
  return `withdrew $${amount} from ${account}`;
}

export async function deposit(account: string, amount: number): Promise<string> {
  return `deposited $${amount} to ${account}`;
}

export async function refund(account: string, amount: number): Promise<string> {
  return `refunded $${amount} to ${account}`;
}
