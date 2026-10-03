import crypto from 'node:crypto';
export const makeId = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
export const nowSec = () => Math.floor(Date.now() / 1000);
