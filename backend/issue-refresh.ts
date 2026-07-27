import { issueRefreshToken } from './src/lib/tokens.js';
console.log(await issueRefreshToken(process.argv[2]));
process.exit(0);