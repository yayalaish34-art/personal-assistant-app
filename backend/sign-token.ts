import { signAccessToken } from './src/lib/tokens.js';

const userId = process.argv[2];
console.log('TOKEN=' + signAccessToken(userId));