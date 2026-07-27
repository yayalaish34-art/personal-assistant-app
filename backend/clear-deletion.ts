import { prisma } from './src/db.js';
await prisma.user.update({ where:{ id:process.argv[2] }, data:{ deletionRequestedAt:null } });
console.log('cleared');
await prisma.$disconnect();