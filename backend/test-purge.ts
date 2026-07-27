import { prisma } from './src/db.js';
import { handlePurgeDeletedUsers } from './src/jobs/purgeDeletedUsers.js';
const old = await prisma.user.create({ data:{ provider:'google',
  providerUserId:'old-'+Date.now(), email:'a@a', name:'A', timezone:'UTC',
  deletionRequestedAt:new Date(Date.now()-31*24*3600*1000) } });
const recent = await prisma.user.create({ data:{ provider:'google',
  providerUserId:'new-'+Date.now(), email:'b@b', name:'B', timezone:'UTC',
  deletionRequestedAt:new Date(Date.now()-5*24*3600*1000) } });
await handlePurgeDeletedUsers([{ id:'x', name:'y', data:{}, expireInSeconds:900 }]);
const survivors = await prisma.user.findMany({
  where:{ id:{ in:[old.id, recent.id] } }, select:{ id:true } });
console.log('Survivors:', survivors.length, '(expect 1)');
await prisma.user.deleteMany({ where:{ id:{ in:[old.id, recent.id] } } });
await prisma.$disconnect();