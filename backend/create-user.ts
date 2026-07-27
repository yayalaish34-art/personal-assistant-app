import { prisma } from './src/db.js';

const u = await prisma.user.create({
  data: {
    provider: 'google',
    providerUserId: 'manual-' + Date.now(),
    email: 'me@test',
    name: 'Me',
    timezone: 'Asia/Jerusalem',
  },
});
console.log('USER_ID=' + u.id);
await prisma.$disconnect();