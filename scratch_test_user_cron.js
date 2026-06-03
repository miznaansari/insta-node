import dotenv from 'dotenv';
dotenv.config();

import { prisma } from './src/db.js';
import { runUserProfileCron } from './src/cron.js';

async function testUserCron() {
  console.log('🧪 Starting User Profile Cron Test...');

  const testUsername = 'pizzagalleriajpr';

  try {
    // 1. Clean up any existing test user, or ensure we have one with is_processed: false
    console.log(`🧹 Checking/preparing test user "@${testUsername}" in DB...`);
    const existing = await prisma.instagram_user.findFirst({
      where: { username: testUsername }
    });

    if (existing) {
      console.log(`Updating existing test user to is_processed = false, follower = null`);
      await prisma.instagram_user.update({
        where: { id: existing.id },
        data: {
          is_processed: false,
          follower: null,
          following: null,
          posts: null,
          bio: null,
          first_name: null,
          last_name: null
        }
      });
    } else {
      console.log(`Creating new test user with is_processed = false`);
      await prisma.instagram_user.create({
        data: {
          username: testUsername,
          instagram_profile_url: `https://www.instagram.com/${testUsername}/`,
          is_processed: false
        }
      });
    }

    // 2. Run the user profile cron directly
    console.log('\n🚀 Triggering runUserProfileCron()...');
    await runUserProfileCron();

    // 3. Query the user record to verify changes
    console.log('\n🔍 Fetching user record from DB after cron execution...');
    const updatedUser = await prisma.instagram_user.findFirst({
      where: { username: testUsername }
    });

    console.log('------------------------------------------------------');
    console.log('Updated User Fields:');
    console.log(`ID:           ${updatedUser.id}`);
    console.log(`Username:     ${updatedUser.username}`);
    console.log(`First Name:   ${updatedUser.first_name}`);
    console.log(`Last Name:    ${updatedUser.last_name}`);
    console.log(`Bio:          ${updatedUser.bio}`);
    console.log(`Followers:    ${updatedUser.follower}`);
    console.log(`Following:    ${updatedUser.following}`);
    console.log(`Posts:        ${updatedUser.posts}`);
    console.log(`Profile Pic:  ${updatedUser.instagram_user_profile}`);
    console.log(`Is Processed: ${updatedUser.is_processed}`);
    console.log('------------------------------------------------------');

    if (updatedUser.is_processed === true && updatedUser.follower !== null) {
      console.log('🎉 SUCCESS: User profile successfully scraped, persisted, and marked as processed!');
    } else {
      console.error('❌ FAILURE: User profile is either not marked as processed, or stats are null.');
    }

  } catch (err) {
    console.error('❌ Error during verification:', err);
  } finally {
    await prisma.$disconnect();
    console.log('\n🏁 Verification Complete.');
  }
}

testUserCron();
