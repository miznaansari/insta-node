import { PrismaClient } from '@prisma/client';
import { tryUploadToR2 } from './r2.js';

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

  // Fetch the existing record from the database to prevent overwriting full data with NULLs
  const existing = await prisma.instagramProfile.findUnique({
    where: { username: profileData.username }
  });

  if (existing) {
    profileData.fullName = profileData.fullName || existing.fullName;
    profileData.bio = profileData.bio || existing.bio;
    profileData.profilePicUrl = profileData.profilePicUrl || existing.profilePicUrl;
    profileData.followersCount = profileData.followersCount || existing.followersCount;
    profileData.followingCount = profileData.followingCount || existing.followingCount;
    profileData.postsCount = profileData.postsCount || existing.postsCount;
  }

  let isError = 0;
  if (profileData.profilePicUrl) {
    const res = await tryUploadToR2(profileData.profilePicUrl, 'profile', profileData.username);
    profileData.profilePicUrl = res.url;
    if (res.error) {
      isError = 1;
    }
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
      isError: isError,
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
      isError: isError,
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

  // Fetch existing reels to merge fields and prevent resetting them to NULL on partial updates
  const shortcodes = reelsData.map(r => r.shortcode).filter(Boolean);
  const existingReels = await prisma.instagramReel.findMany({
    where: { shortcode: { in: shortcodes } }
  });
  const existingReelsMap = new Map(existingReels.map(r => [r.shortcode, r]));

  const savedReels = [];
  for (const reel of reelsData) {
    if (!reel.shortcode) continue;

    try {
      const existing = existingReelsMap.get(reel.shortcode);
      if (existing) {
        reel.mediaUrl = reel.mediaUrl || existing.mediaUrl;
        reel.thumbnailUrl = reel.thumbnailUrl || existing.thumbnailUrl;
        reel.caption = reel.caption || existing.caption;
        reel.viewCount = reel.viewCount || existing.viewCount;
        reel.likeCount = reel.likeCount || existing.likeCount;
        reel.commentCount = reel.commentCount || existing.commentCount;
      }

      let isError = 0;

      if (reel.mediaUrl) {
        const res = await tryUploadToR2(reel.mediaUrl, 'video', reel.shortcode);
        reel.mediaUrl = res.url;
        if (res.error) {
          isError = 1;
        }
      }

      if (reel.thumbnailUrl) {
        const res = await tryUploadToR2(reel.thumbnailUrl, 'thumbnail', reel.shortcode);
        reel.thumbnailUrl = res.url;
        if (res.error) {
          isError = 1;
        }
      }

      const saved = await prisma.instagramReel.upsert({
        where: { shortcode: reel.shortcode },
        update: {
          mediaUrl: reel.mediaUrl,
          thumbnailUrl: reel.thumbnailUrl,
          caption: reel.caption,
          viewCount: reel.viewCount,
          likeCount: reel.likeCount,
          commentCount: reel.commentCount,
          isError: isError,
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
          isError: isError,
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

