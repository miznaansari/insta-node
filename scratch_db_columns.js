import dotenv from 'dotenv';
dotenv.config();

import { prisma } from './src/db.js';

async function main() {
  try {
    const result = await prisma.$queryRawUnsafe(`DESCRIBE instagram_user`);
    console.log('Columns in instagram_user:');
    console.log(result);
  } catch (err) {
    console.error('Error describing table:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
