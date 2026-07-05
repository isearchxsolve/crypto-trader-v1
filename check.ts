import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const trades = await prisma.trade.findMany({
    where: { status: 'CLOSED' },
    orderBy: { closedAt: 'desc' },
    take: 10,
    select: { tokenSymbol: true, pnlPct: true, closeReason: true }
  });
  console.log(trades);
}
main();
