import { PrismaClient } from '@prisma/client';
import { tryUploadToR2 } from './r2.js';

// Global serialization override for BigInt support in JSON.stringify / Express responses
if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}

export const prisma = new PrismaClient();

/**
 * Helper to strip 4-byte UTF-8 characters (emojis, etc.) that MySQL's standard utf8/latin1 encoding cannot store.
 * @param {string} str 
 * @returns {string|null}
 */
export function stripNonBmpChars(str) {
  if (!str) return null;
  return str.replace(/[\u{10000}-\u{10FFFF}]/gu, '');
}

/**
 * Ensures a URL safely fits within database length constraints.
 * Strips off query parameters first to preserve validity, and truncates if still too long.
 * @param {string} url 
 * @param {number} maxLength 
 * @returns {string|null}
 */
export function safeDbUrl(url, maxLength = 255) {
  if (!url) return null;
  if (url.length <= maxLength) return url;

  if (url.includes('?')) {
    const stripped = url.split('?')[0];
    if (stripped.length <= maxLength) {
      return stripped;
    }
  }

  return url.slice(0, maxLength);
}

/**
 * Finds a profile by username, or creates a skeleton profile record if it doesn't exist.
 * @param {string} username 
 * @returns {Promise<object>}
 */
export async function findOrCreateUser(username) {
  if (!username) {
    throw new Error('Username is required for database user search/creation.');
  }

  const cleanUsername = username.trim().toLowerCase();

  // Try to find the user first using findFirst since username is not marked as @unique in Prisma schema
  let user = await prisma.instagram_user.findFirst({
    where: { username: cleanUsername }
  });

  if (!user) {
    console.log(`[Database] Creating new skeleton user: @${cleanUsername}`);
    user = await prisma.instagram_user.create({
      data: {
        username: cleanUsername,
        instagram_profile_url: `https://www.instagram.com/${cleanUsername}/`,
        is_processed: false,
        created_at: new Date(),
        updated_at: new Date()
      }
    });
  }

  return user;
}

/**
 * Backward compatibility alias for findOrCreateUser.
 */
export async function findOrCreateProfile(username) {
  return await findOrCreateUser(username);
}

/**
 * Saves or updates an Instagram profile/user in the database.
 * @param {object} profileData 
 * @returns {Promise<object>}
 */
export async function saveProfileToDb(profileData) {
  if (!profileData || !profileData.username) {
    throw new Error('Invalid profile data provided to database sync.');
  }

  const cleanUsername = profileData.username.trim().toLowerCase();
  console.log(`[Database] Syncing profile for username: ${cleanUsername}`);

  // Split fullName into first_name and last_name if present
  let firstName = null;
  let lastName = null;
  if (profileData.fullName) {
    const parts = profileData.fullName.trim().split(/\s+/);
    firstName = parts[0] || null;
    if (parts.length > 1) {
      lastName = parts.slice(1).join(' ') || null;
    }
  }

  const cleanFirstName = stripNonBmpChars(firstName);
  const cleanLastName = stripNonBmpChars(lastName);
  const cleanBio = stripNonBmpChars(profileData.bio);

  // Upload profile picture to Cloudflare R2 if present
  let r2ProfilePicUrl = null;
  if (profileData.profilePicUrl) {
    try {
      const uploadRes = await tryUploadToR2(profileData.profilePicUrl, 'profile', cleanUsername);
      r2ProfilePicUrl = uploadRes.url;
    } catch (err) {
      console.error(`[Database] R2 upload failed for @${cleanUsername} profile picture:`, err.message);
      r2ProfilePicUrl = profileData.profilePicUrl; // Fallback
    }
  }

  const existing = await prisma.instagram_user.findFirst({
    where: { username: cleanUsername }
  });

  if (existing) {
    return await prisma.instagram_user.update({
      where: { id: existing.id },
      data: {
        first_name: cleanFirstName || existing.first_name,
        last_name: cleanLastName || existing.last_name,
        bio: cleanBio || existing.bio,
        instagram_profile_url: `https://www.instagram.com/${cleanUsername}/`,
        is_processed: true,
        follower: profileData.followersCount !== undefined ? profileData.followersCount : existing.follower,
        following: profileData.followingCount !== undefined ? profileData.followingCount : existing.following,
        posts: profileData.postsCount !== undefined ? profileData.postsCount : existing.posts,
        instagram_user_profile: r2ProfilePicUrl !== null ? r2ProfilePicUrl : existing.instagram_user_profile,
        updated_at: new Date(),
      }
    });
  } else {
    return await prisma.instagram_user.create({
      data: {
        username: cleanUsername,
        first_name: cleanFirstName,
        last_name: cleanLastName,
        bio: cleanBio,
        instagram_profile_url: `https://www.instagram.com/${cleanUsername}/`,
        is_processed: true,
        follower: profileData.followersCount !== undefined ? profileData.followersCount : null,
        following: profileData.followingCount !== undefined ? profileData.followingCount : null,
        posts: profileData.postsCount !== undefined ? profileData.postsCount : null,
        instagram_user_profile: r2ProfilePicUrl,
        created_at: new Date(),
        updated_at: new Date()
      }
    });
  }
}

/**
 * Saves or updates multiple Instagram reels in the database linked to a user.
 * @param {BigInt|number} userId 
 * @param {Array<object>} reelsData 
 * @returns {Promise<Array<object>>}
 */
export async function saveReelsToDb(userId, reelsData) {
  if (!userId) {
    throw new Error('Database userId is required to associate reels.');
  }

  if (!Array.isArray(reelsData) || reelsData.length === 0) {
    console.log(`[Database] No reels data provided to sync.`);
    return [];
  }

  const bigIntUserId = BigInt(userId.toString());
  console.log(`[Database] Upserting ${reelsData.length} reels for userId: ${bigIntUserId}`);

  const savedReels = [];
  for (const reel of reelsData) {
    if (!reel.shortcode) continue;

    // Use reel shortcode to map raw_video_url unique identifier
    const rawVideoUrl = `https://www.instagram.com/reel/${reel.shortcode}/`;

    try {
      let existing = null;
      if (reel.id) {
        existing = await prisma.instagram_reels.findUnique({
          where: { id: BigInt(reel.id.toString()) }
        });
      } else {
        existing = await prisma.instagram_reels.findFirst({
          where: {
            OR: [
              { raw_video_url: { contains: `/reel/${reel.shortcode}` } },
              { raw_video_url: { contains: `/p/${reel.shortcode}` } },
              { raw_video_url: rawVideoUrl }
            ]
          }
        });
      }

      let finalVideoUrl = reel.mediaUrl || (existing ? existing.video_url : null);
      let finalThumbnailUrl = reel.thumbnailUrl || (existing ? existing.reel_thumbnail : null);
      let isRejected = existing ? existing.is_rejected : false;
      let rejectReason = existing ? existing.reject_reason : null;

      // Handle video upload to R2 if not already uploaded/proxied
      if (reel.mediaUrl && (!existing || !existing.video_url || existing.video_url.includes('instagram.com'))) {
        console.log(`[Database] Uploading reel video for shortcode ${reel.shortcode} to R2...`);
        const res = await tryUploadToR2(reel.mediaUrl, 'video', reel.shortcode);
        finalVideoUrl = res.url;
        if (res.error) {
          isRejected = true;
          rejectReason = res.error;
        }
      }

      // Handle thumbnail upload to R2 if not already uploaded/proxied
      if (reel.thumbnailUrl && (!existing || !existing.reel_thumbnail || existing.reel_thumbnail.includes('instagram.com'))) {
        console.log(`[Database] Uploading reel thumbnail for shortcode ${reel.shortcode} to R2...`);
        const res = await tryUploadToR2(reel.thumbnailUrl, 'thumbnail', reel.shortcode);
        finalThumbnailUrl = res.url;
        if (res.error) {
          isRejected = true;
          rejectReason = res.error;
        }
      }

      const rawCaption = reel.caption || (existing ? existing.caption : null);
      const cleanCaption = stripNonBmpChars(rawCaption);

      const updateData = {
        caption: cleanCaption,
        video_url: safeDbUrl(finalVideoUrl, 255),
        reel_thumbnail: safeDbUrl(finalThumbnailUrl, 255),
        is_processed: true,
        is_approved: false, // Default is_approved is 0
        is_rejected: isRejected,
        reject_reason: rejectReason,
        like_count: reel.likeCount !== undefined ? reel.likeCount : (existing ? existing.like_count : null),
        comment_count: reel.commentCount !== undefined ? reel.commentCount : (existing ? existing.comment_count : null),
        view_count: reel.viewCount !== undefined ? reel.viewCount : (existing ? existing.view_count : null),
        updated_at: new Date()
      };

      let saved;
      if (existing) {
        saved = await prisma.instagram_reels.update({
          where: { id: existing.id },
          data: updateData
        });
      } else {
        saved = await prisma.instagram_reels.create({
          data: {
            instagram_user_id: bigIntUserId,
            raw_video_url: rawVideoUrl,
            ...updateData,
            created_at: new Date()
          }
        });
      }

      savedReels.push(saved);
    } catch (err) {
      console.error(`[Database] Error saving reel ${reel.shortcode}:`, err.message);
    }
  }

  return savedReels;
}
