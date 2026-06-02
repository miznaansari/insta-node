import { parseInstagramUrl } from './src/cron.js';
import { prisma, findOrCreateUser } from './src/db.js';

async function testDiagnostics() {
  console.log('🧪 Starting Workspace Importer Diagnostics...\n');

  // Test 1: Parser verification
  console.log('--- 1. Testing URL Parser ---');
  const urls = [
    'https://www.instagram.com/miznaansari/reel/C8qJ0N8u9Xy/',
    'https://www.instagram.com/reel/C8qJ0N8u9Xy/',
    'instagram.com/miznaansari/reel/C8qJ0N8u9Xy',
    'https://www.instagram.com/miznaansari/',
    'https://www.instagram.com/reel/C8qJ0N8u9Xy?utm_source=ig_web_copy_link'
  ];

  for (const url of urls) {
    const res = parseInstagramUrl(url);
    console.log(`URL:  "${url}"`);
    console.log(`Parsed:`, res);
    console.log();
  }

  // Test 2: Database connectivity and schema lookup
  console.log('--- 2. Testing Database Connectivity & Lookups ---');
  try {
    const reelsCount = await prisma.instagram_reels.count();
    console.log(`✅ Database connection successful! Total records in instagram_reels: ${reelsCount}`);

    const usersCount = await prisma.instagram_user.count();
    console.log(`✅ Total records in instagram_user: ${usersCount}`);

    // Query a few unprocessed reels
    const unprocessed = await prisma.instagram_reels.findMany({
      where: { is_processed: false },
      take: 3
    });
    console.log(`ℹ️ Pending unprocessed reels count (limited to 3): ${unprocessed.length}`);
    console.log(unprocessed);

    // Try a skeleton user creation
    console.log('\n--- 3. Testing skeleton user lookup/creation ---');
    const dummyUser = await findOrCreateUser('diagnostics_test_user');
    console.log('✅ User resolved successfully:', dummyUser);

    // Cleanup the diagnostics test user to keep database clean
    await prisma.instagram_user.deleteMany({
      where: { username: 'diagnostics_test_user' }
    });
    console.log('🧹 Cleaned up diagnostics test user.');

  } catch (err) {
    console.error('❌ Database/Schema Verification Failed:', err);
  } finally {
    await prisma.$disconnect();
    console.log('\n🏁 Diagnostics Complete.');
  }
}

testDiagnostics();
