import nodeCron from 'node-cron';
import { chromium } from 'playwright';
import { prisma, findOrCreateUser, saveReelsToDb, saveProfileToDb } from './db.js';
import { scrapeSingleReelDirect, scrapeInstagramData, extractUsername } from './scraper.js';

let isCronRunning = false;

/**
 * Parses raw Instagram URLs to extract username and shortcode.
 * Supports formats like:
 * - https://www.instagram.com/username/reel/shortcode/
 * - https://www.instagram.com/reel/shortcode/
 * - instagram.com/username/reel/shortcode
 * @param {string} urlStr 
 * @returns {{ username: string|null, shortcode: string } | null}
 */
export function parseInstagramUrl(urlStr) {
  if (!urlStr) return null;
  let str = urlStr.trim();

  if (str.includes('?')) {
    str = str.split('?')[0];
  }
  if (str.endsWith('/')) {
    str = str.slice(0, -1);
  }

  try {
    if (str.startsWith('http://') || str.startsWith('https://')) {
      const url = new URL(str);
      const pathParts = url.pathname.split('/').filter(Boolean);

      // Format: /username/reel/shortcode
      if (pathParts.length >= 3 && (pathParts[1] === 'reel' || pathParts[1] === 'reels' || pathParts[1] === 'p')) {
        return {
          username: pathParts[0],
          shortcode: pathParts[2]
        };
      }

      // Format: /reel/shortcode
      if (pathParts.length >= 2 && (pathParts[0] === 'reel' || pathParts[0] === 'reels' || pathParts[0] === 'p')) {
        return {
          username: null,
          shortcode: pathParts[1]
        };
      }

      // Format: /username
      if (pathParts.length === 1) {
        return {
          username: pathParts[0],
          shortcode: null
        };
      }
    }
  } catch (e) {
    // Ignore URL parse error and fall back to regex
  }

  // Fallback Regex
  const threePartMatch = str.match(/(?:instagram\.com\/)?([a-zA-Z0-9_\.]+)\/(?:reel|reels|p)\/([a-zA-Z0-9_\-]+)/i);
  if (threePartMatch) {
    return {
      username: threePartMatch[1],
      shortcode: threePartMatch[2]
    };
  }

  const twoPartMatch = str.match(/(?:instagram\.com\/)?(?:reel|reels|p)\/([a-zA-Z0-9_\-]+)/i);
  if (twoPartMatch) {
    return {
      username: null,
      shortcode: twoPartMatch[1]
    };
  }

  return null;
}

/**
 * Main execution logic for the DB-driven cron importer.
 */
export async function runCronImport() {
  if (isCronRunning) {
    console.log(`[Cron Importer] ⏳ A cron job execution is already running. Skipping this cycle.`);
    return;
  }

  isCronRunning = true;
  console.log(`\n======================================================`);
  console.log(`⏱️ [Cron Importer] Starting DB-driven Instagram extraction run...`);
  console.log(`======================================================`);

  let browser = null;
  let context = null;

  try {
    // 1. Fetch unprocessed reels from the database
    const pendingReels = await prisma.instagram_reels.findMany({
      where: { is_processed: false },
      take: 15, // Process in small batches to respect rate limits and reduce memory footprints
      orderBy: { created_at: 'asc' }
    });

    if (pendingReels.length === 0) {
      console.log(`[Cron Importer] No pending reels to process. Database is up to date.`);
      isCronRunning = false;
      return;
    }

    console.log(`[Cron Importer] Found ${pendingReels.length} unprocessed reels. Launching browser pool...`);

    // 2. Open Chromium browser context once for sequential processing
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--autoplay-policy=no-user-gesture-required'
      ],
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    for (let i = 0; i < pendingReels.length; i++) {
      const reel = pendingReels[i];
      console.log(`\n------------------------------------------------------`);
      console.log(`[Cron Importer] [${i + 1}/${pendingReels.length}] Processing Reel ID: ${reel.id}`);
      console.log(`[Cron Importer] Raw Video URL: "${reel.raw_video_url}"`);

      // Parse the raw video URL to find username and shortcode
      const parsed = parseInstagramUrl(reel.raw_video_url);
      if (!parsed || !parsed.shortcode) {
        console.error(`❌ [Cron Importer] Invalid raw video URL or shortcode could not be extracted.`);
        await prisma.instagram_reels.update({
          where: { id: reel.id },
          data: {
            is_processed: true,
            is_rejected: true,
            reject_reason: 'Failed to parse shortcode or username from raw_video_url.',
            updated_at: new Date()
          }
        });
        continue;
      }

      const { username, shortcode } = parsed;
      const targetUsername = username || 'unknown_creator';

      console.log(`[Cron Importer] Extracted username: "@${targetUsername}", shortcode: "${shortcode}"`);

      // Find or create user to satisfy database foreign keys
      let dbUser;
      try {
        dbUser = await findOrCreateUser(targetUsername);
      } catch (userErr) {
        console.error(`❌ [Cron Importer DB Error] Failed to find or create profile for "${targetUsername}":`, userErr.message);
        continue;
      }

      // Associate the reel to this user if not already set or mapping is different
      if (reel.instagram_user_id !== dbUser.id) {
        await prisma.instagram_reels.update({
          where: { id: reel.id },
          data: { instagram_user_id: dbUser.id }
        });
      }

      const page = await context.newPage();
      page.setDefaultNavigationTimeout(25000);

      try {
        // Scrape page and handle download/R2 upload flow
        const scrapedData = await scrapeSingleReelDirect(page, shortcode);

        // Update database with scraped R2 links and stats
        await saveReelsToDb(dbUser.id, [{
          id: reel.id,
          shortcode,
          mediaUrl: scrapedData.mediaUrl,
          thumbnailUrl: scrapedData.thumbnailUrl,
          caption: scrapedData.caption,
          likeCount: scrapedData.likeCount,
          commentCount: scrapedData.commentCount,
          viewCount: scrapedData.viewCount
        }]);

        // Mark user profile as processed too
        await prisma.instagram_user.update({
          where: { id: dbUser.id },
          data: {
            is_processed: true,
            updated_at: new Date()
          }
        });

        console.log(`✅ [Cron Importer] Successfully processed and synced reel shortcode: "${shortcode}"`);
      } catch (scrapeErr) {
        console.error(`❌ [Cron Importer Scraper Error] Failed to crawl shortcode "${shortcode}":`, scrapeErr.message);

        // Fail-safe: Mark reel as processed but rejected to avoid getting stuck in process loop
        await prisma.instagram_reels.update({
          where: { id: reel.id },
          data: {
            is_processed: true,
            is_rejected: true,
            reject_reason: scrapeErr.message || 'Scraping failed',
            updated_at: new Date()
          }
        });
      } finally {
        await page.close().catch(() => {});
        // Rest a bit between requests to emulate human browsing behaviors
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (error) {
    console.error(`❌ [Cron Importer Execution Error] Main loop crash:`, error.message);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    isCronRunning = false;
    console.log(`\n======================================================`);
    console.log(`🏁 [Cron Importer] Run complete. Browser pool released.`);
    console.log(`======================================================\n`);
  }
}

let isUserProfileCronRunning = false;

/**
 * Main execution logic for the DB-driven user profile cron importer.
 */
export async function runUserProfileCron() {
  if (isUserProfileCronRunning) {
    console.log(`[User Profile Cron] ⏳ A user profile cron execution is already running. Skipping this cycle.`);
    return;
  }

  isUserProfileCronRunning = true;
  console.log(`\n======================================================`);
  console.log(`⏱️ [User Profile Cron] Starting DB-driven user profile crawl...`);
  console.log(`======================================================`);

  try {
    // 1. Fetch unprocessed users from the database
    const pendingUsers = await prisma.instagram_user.findMany({
      where: {
        OR: [
          { is_processed: false },
          { is_processed: null }
        ]
      },
      take: 5, // Process in small batches to respect rate limits and reduce memory footprints
      orderBy: { created_at: 'asc' }
    });

    if (pendingUsers.length === 0) {
      console.log(`[User Profile Cron] No pending users to process. Database is up to date.`);
      isUserProfileCronRunning = false;
      return;
    }

    console.log(`[User Profile Cron] Found ${pendingUsers.length} unprocessed profiles. Processing sequentially...`);

    for (let i = 0; i < pendingUsers.length; i++) {
      const user = pendingUsers[i];
      console.log(`\n------------------------------------------------------`);
      console.log(`[User Profile Cron] [${i + 1}/${pendingUsers.length}] Processing User ID: ${user.id}`);
      
      const targetUser = user.username || (user.instagram_profile_url ? extractUsername(user.instagram_profile_url) : null);
      console.log(`[User Profile Cron] Username: "${targetUser}"`);

      if (!targetUser) {
        console.error(`❌ [User Profile Cron] Invalid username or profile url for user ID: ${user.id}`);
        await prisma.instagram_user.update({
          where: { id: user.id },
          data: {
            is_processed: true,
            updated_at: new Date()
          }
        });
        continue;
      }

      try {
        // Run standard Crawlee profile scraping with built-in fingerprints
        const scraped = await scrapeInstagramData(targetUser);

        // Update database with scraped profile stats
        await saveProfileToDb(scraped.profile);

        console.log(`✅ [User Profile Cron] Successfully processed and synced profile for: "${targetUser}"`);
      } catch (scrapeErr) {
        console.error(`❌ [User Profile Cron Scraper Error] Failed to crawl profile for "${targetUser}":`, scrapeErr.message);

        // Fail-safe: Mark profile as processed to avoid getting stuck in process loop
        await prisma.instagram_user.update({
          where: { id: user.id },
          data: {
            is_processed: true,
            updated_at: new Date()
          }
        });
      }

      // Rest a bit between requests to emulate human browsing behaviors
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (error) {
    console.error(`❌ [User Profile Cron Execution Error] Main loop crash:`, error.message);
  } finally {
    isUserProfileCronRunning = false;
    console.log(`\n======================================================`);
    console.log(`🏁 [User Profile Cron] Run complete.`);
    console.log(`======================================================\n`);
  }
}

/**
 * Initializes and schedules the cron jobs.
 */
export function initCronJobs() {
  console.log(`[Cron Manager] Initializing scheduled crawlers...`);
  
  // Schedule Reels Crawler every 1 minute
  nodeCron.schedule('*/1 * * * *', async () => {
    console.log(`[Cron Manager] Triggering scheduled Reels cron run...`);
    await runCronImport();
  });

  // Schedule User Profile Crawler every 1 minute
  nodeCron.schedule('*/1 * * * *', async () => {
    console.log(`[Cron Manager] Triggering scheduled User Profile cron run...`);
    await runUserProfileCron();
  });

  console.log(`[Cron Manager] Instagram cron jobs registered successfully! Run schedule: Every 1 Minute`);
  
  // Trigger runs immediately on startup in background
  console.log(`[Cron Manager] Performing immediate startup crawls in background...`);
  runCronImport().catch(err => {
    console.error(`❌ [Cron Manager Reels Startup Error]:`, err.message);
  });
  
  runUserProfileCron().catch(err => {
    console.error(`❌ [Cron Manager User Profile Startup Error]:`, err.message);
  });
}
