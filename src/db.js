import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * Saves or updates an Instagram profile in the database.
 * @param {object} profileData 
 * @returns {Promise<object>}
 */
export async function saveProfileToDb(profileData) {
  if (!profileData || !profileData.username) {
    throw new Error('Invalid profile data provided to database sync.');
  }

  console.log(`[Database] Upserting profile for username: ${profileData.username}`);

  return await prisma.instagramProfile.upsert({
    where: { username: profileData.username },
    update: {
      fullName: profileData.fullName,
      bio: profileData.bio,
      profilePicUrl: profileData.profilePicUrl,
      followersCount: profileData.followersCount,
      followingCount: profileData.followingCount,
      postsCount: profileData.postsCount,
      scrapedAt: new Date(),
    },
    create: {
      username: profileData.username,
      fullName: profileData.fullName,
      bio: profileData.bio,
      profilePicUrl: profileData.profilePicUrl,
      followersCount: profileData.followersCount,
      followingCount: profileData.followingCount,
      postsCount: profileData.postsCount,
    },
  });
}

/**
 * Saves or updates multiple Instagram reels in the database linked to a profile.
 * @param {number} profileId 
 * @param {Array<object>} reelsData 
 * @returns {Promise<Array<object>>}
 */
export async function saveReelsToDb(profileId, reelsData) {
  if (!profileId) {
    throw new Error('Database profileId is required to associate reels.');
  }

  if (!Array.isArray(reelsData) || reelsData.length === 0) {
    console.log(`[Database] No reels data provided to sync.`);
    return [];
  }

  console.log(`[Database] Upserting ${reelsData.length} reels for profileId: ${profileId}`);

  const savedReels = [];
  for (const reel of reelsData) {
    if (!reel.shortcode) continue;

    try {
      const saved = await prisma.instagramReel.upsert({
        where: { shortcode: reel.shortcode },
        update: {
          mediaUrl: reel.mediaUrl,
          thumbnailUrl: reel.thumbnailUrl,
          caption: reel.caption,
          viewCount: reel.viewCount,
          likeCount: reel.likeCount,
          commentCount: reel.commentCount,
          profileId: profileId,
          scrapedAt: new Date(),
        },
        create: {
          shortcode: reel.shortcode,
          mediaUrl: reel.mediaUrl,
          thumbnailUrl: reel.thumbnailUrl,
          caption: reel.caption,
          viewCount: reel.viewCount,
          likeCount: reel.likeCount,
          commentCount: reel.commentCount,
          profileId: profileId,
        },
      });
      savedReels.push(saved);
    } catch (err) {
      console.error(`[Database] Error upserting reel ${reel.shortcode}:`, err.message);
    }
  }

  return savedReels;
}

/**
 * Finds a profile by username, or creates a skeleton profile record if it doesn't exist.
 * @param {string} username 
 * @returns {Promise<object>}
 */
export async function findOrCreateProfile(username) {
  if (!username) {
    throw new Error('Username is required for database profile search/creation.');
  }

  const cleanUsername = username.trim().toLowerCase();

  return await prisma.instagramProfile.upsert({
    where: { username: cleanUsername },
    update: {},
    create: {
      username: cleanUsername,
      fullName: cleanUsername,
    },
  });
}

