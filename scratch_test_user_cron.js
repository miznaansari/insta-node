import dotenv from 'dotenv';
dotenv.config();

import { prisma } from './src/db.js';
import { runUserProfileCron } from './src/cron.js';

async function testUserCron() {
  console.log('🧪 Starting Multi-User Profile Cron Test...');

  const testUsernames = ['jaipur_blogger', 'tastebuds_temptation', 'pizzagalleriajpr'];

  try {
    // 1. Reset all test users to is_processed = false
    console.log(`\n🧹 Resetting test users in DB to unprocessed...`);
    for (const username of testUsernames) {
      await prisma.instagram_user.updateMany({
        where: { username },
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
      console.log(`- Reset @${username}`);
    }

    // 2. Run the user profile cron directly
    console.log('\n🚀 Triggering runUserProfileCron()...');
    await runUserProfileCron();

    // 3. Query and verify each user
    console.log('\n🔍 Verifying all test profiles in DB after cron execution...');
    for (const username of testUsernames) {
      const updatedUser = await prisma.instagram_user.findFirst({
        where: { username }
      });

      console.log('------------------------------------------------------');
      console.log(`Username:     @${updatedUser.username}`);
      console.log(`Name:         ${updatedUser.first_name} ${updatedUser.last_name}`);
      console.log(`Followers:    ${updatedUser.follower}`);
      console.log(`Following:    ${updatedUser.following}`);
      console.log(`Posts:        ${updatedUser.posts}`);
      console.log(`Profile Pic:  ${updatedUser.instagram_user_profile}`);
      console.log(`Is Processed: ${updatedUser.is_processed}`);

      if (updatedUser.is_processed === true && updatedUser.follower !== null) {
        console.log(`🎉 SUCCESS: @${username} was processed correctly!`);
      } else {
        console.error(`❌ FAILURE: @${username} is still missing stats or not processed.`);
      }
    }

  } catch (err) {
    console.error('❌ Error during verification:', err);
  } finally {
    await prisma.$disconnect();
    console.log('\n🏁 Verification Complete.');
  }
}

testUserCron();
