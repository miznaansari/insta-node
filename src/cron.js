import nodeCron from 'node-cron';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import { prisma, findOrCreateUser, saveReelsToDb, saveProfileToDb } from './db.js';
import { scrapeSingleReelDirect, scrapeInstagramData, extractUsername, getProxyConfiguration } from './scraper.js';

let isCronRunning = false;
let consecutiveFailures = 0;
let cronCooldownUntil = null;

/**
 * Checks if the cron is currently cooling down.
 * @returns {boolean}
 */
export function checkCronCooldown() {
  if (cronCooldownUntil && Date.now() < cronCooldownUntil) {
    const minutesLeft = Math.ceil((cronCooldownUntil - Date.now()) / (60 * 1000));
    console.warn(`[Cron Manager] ⏳ Cron is cooling down. Skipping run. ${minutesLeft} minute(s) remaining.`);
    return true;
  }
  return false;
}

/**
 * Records a request failure and sets cooldown if we reach consecutive threshold.
 * @param {string} reason
 */
export function handleCronFailure(reason) {
  consecutiveFailures++;
  console.warn(`[Cron Manager] ⚠️ Failure recorded (${consecutiveFailures}/2). Reason: ${reason}`);
  if (consecutiveFailures >= 2) {
    const cooldownMins = Math.floor(Math.random() * 6) + 10; // 10 to 15
    cronCooldownUntil = Date.now() + cooldownMins * 60 * 1000;
    consecutiveFailures = 0; // reset counter
    console.error(`[Cron Manager] 🛑 2 consecutive failures detected. Cooling down all cron jobs for ${cooldownMins} minutes (until ${new Date(cronCooldownUntil).toLocaleTimeString()}).`);
  }
}

/**
 * Resets the consecutive failure counter upon a successful scrape.
 */
export function resetCronFailures() {
  if (consecutiveFailures > 0) {
    console.log(`[Cron Manager] 😊 Successful scrape completed. Resetting failure counter (was ${consecutiveFailures}).`);
    consecutiveFailures = 0;
  }
}


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

  if (checkCronCooldown()) {
    return;
  }

  isCronRunning = true;
  console.log(`\n======================================================`);
  console.log(`⏱️ [Cron Importer] Starting DB-driven Instagram extraction run...`);
  console.log(`======================================================`);

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

    console.log(`[Cron Importer] Found ${pendingReels.length} unprocessed reels. Launching Crawlee PlaywrightCrawler...`);

    const crawler = new PlaywrightCrawler({
      useSessionPool: true,
      sessionPoolOptions: {
        maxPoolSize: 10,
      },
      headless: true,
      browserPoolOptions: {
        useFingerprints: true, // Use realistic fingerprints to bypass anti-bot challenges
      },
      launchContext: {
        launchOptions: {
          args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--autoplay-policy=no-user-gesture-required'
          ],
        },
      },
      maxConcurrency: 1, // Sequential crawling to avoid aggressive throttling
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 90,

      preNavigationHooks: [
        async ({ page }) => {
          // Setup response interceptor for streaming video bytes
          page.videoChunks = [];
          page.videoResponseHandler = async (response) => {
            try {
              const resUrl = response.url();
              const headers = response.headers();
              const contentType = headers['content-type'] || '';
              
              // Catch MP4/dynamic video streams
              if (
                contentType.includes('video/') || 
                resUrl.includes('.mp4') || 
                resUrl.includes('/videoplayback') || 
                (contentType.includes('application/octet-stream') && (resUrl.includes('bytestart=') || resUrl.includes('bytelength=')))
              ) {
                const buffer = await response.body();
                const { isValidVideoBuffer } = await import('./r2.js');
                if (isValidVideoBuffer(buffer)) {
                  page.videoChunks.push({
                    url: resUrl,
                    buffer,
                    size: buffer.length,
                    contentType: contentType
                  });
                }
              }
            } catch (err) {
              // Body can be drained or closed, skip
            }
          };
          page.on('response', page.videoResponseHandler);

          // Request interceptor to block analytics/trackers (reducing telemetry fingerprints)
          await page.route('**/*', async (route) => {
            const url = route.request().url();
            if (
              url.includes('graph.instagram.com/logging_client') ||
              url.includes('instagram.com/logging_client') ||
              url.includes('/api/v1/ads/') ||
              url.includes('facebook.com/tr') ||
              url.includes('google-analytics.com')
            ) {
              await route.abort();
            } else {
              await route.continue();
            }
          });
        }
      ],

      async requestHandler({ page, request, session, log }) {
        const { reelId, rawVideoUrl } = request.userData;

        log.info(`[Cron Importer] Processing Reel ID: ${reelId}`);
        log.info(`[Cron Importer] Raw Video URL: "${rawVideoUrl}"`);

        // Parse the raw video URL to find username and shortcode
        const parsed = parseInstagramUrl(rawVideoUrl);
        if (!parsed || !parsed.shortcode) {
          log.error(`❌ [Cron Importer] Invalid raw video URL or shortcode could not be extracted.`);
          await prisma.instagram_reels.update({
            where: { id: reelId },
            data: {
              is_processed: true,
              is_rejected: true,
              reject_reason: 'Failed to parse shortcode or username from raw_video_url.',
              updated_at: new Date()
            }
          });
          return;
        }

        const { username, shortcode } = parsed;
        const targetUsername = username || 'unknown_creator';

        log.info(`[Cron Importer] Extracted username: "@${targetUsername}", shortcode: "${shortcode}"`);

        // Find or create user to satisfy database foreign keys
        let dbUser;
        try {
          dbUser = await findOrCreateUser(targetUsername);
        } catch (userErr) {
          log.error(`❌ [Cron Importer DB Error] Failed to find or create profile for "${targetUsername}": ${userErr.message}`);
          return;
        }

        // Associate the reel to this user if not already set or mapping is different
        const existingReel = await prisma.instagram_reels.findUnique({ where: { id: reelId } });
        if (existingReel && existingReel.instagram_user_id !== dbUser.id) {
          await prisma.instagram_reels.update({
            where: { id: reelId },
            data: { instagram_user_id: dbUser.id }
          });
        }

        // Add randomized delay before navigation to simulate human browsing (25 to 55 seconds)
        const delayMs = Math.floor(Math.random() * (55000 - 25000 + 1)) + 25000;
        log.info(`[Cron Importer] Waiting ${Math.round(delayMs / 1000)}s before accessing page to evade bot detection...`);
        await page.waitForTimeout(delayMs);

        // Scrape page and handle download/R2 upload flow
        const scrapedData = await scrapeSingleReelDirect(page, shortcode);

        // Check if page redirected to login page (Instagram blocking)
        if (page.url().includes('instagram.com/accounts/login')) {
          log.error(`❌ [Cron Importer Blocked] Redirected to login page for shortcode "${shortcode}". Retiring session.`);
          session.retire();
          throw new Error('Instagram blocked scraping: redirected to login page.');
        }

        // Simulate basic human interaction telemetry: scrolling down and up slightly
        try {
          log.info(`[Cron Importer] Simulating basic human interaction...`);
          await page.evaluate(async () => {
            window.scrollBy(0, 400);
            await new Promise(r => setTimeout(r, 800));
            window.scrollBy(0, -200);
          });
        } catch (e) {
          // ignore telemetry simulation errors
        }

        // Update database with scraped R2 links and stats
        await saveReelsToDb(dbUser.id, [{
          id: reelId,
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

        // Successful scrape completed! Reset the failure counter.
        resetCronFailures();

        log.info(`✅ [Cron Importer] Successfully processed and synced reel shortcode: "${shortcode}"`);

        // Extra post-scrape human-like delay
        const postDelay = Math.floor(Math.random() * 4000) + 2000; // 2s to 6s
        await page.waitForTimeout(postDelay);
      },

      async failedRequestHandler({ request, error, log }) {
        const { reelId, shortcode } = request.userData;
        log.error(`❌ [Cron Importer Scraper Error] Failed to crawl Reel ID ${reelId} (shortcode: "${shortcode || 'unknown'}"): ${error.message}`);

        // Track the failure to see if we need a cooldown
        handleCronFailure(error.message || 'Scraping failed');

        // Fail-safe: Mark reel as processed but rejected to avoid getting stuck in process loop
        await prisma.instagram_reels.update({
          where: { id: reelId },
          data: {
            is_processed: true,
            is_rejected: true,
            reject_reason: error.message || 'Scraping failed after retries',
            updated_at: new Date()
          }
        });
      }
    }, new Configuration({ persistStorage: false }));

    const requests = pendingReels.map(reel => {
      const parsed = parseInstagramUrl(reel.raw_video_url);
      const shortcode = parsed ? parsed.shortcode : '';
      return {
        url: `https://www.instagram.com/reel/${shortcode || 'dummy'}/`,
        userData: {
          reelId: reel.id,
          rawVideoUrl: reel.raw_video_url,
          shortcode
        },
        uniqueKey: `${reel.id}_${Date.now()}` // Bypass cached/duplicate key requests
      };
    });

    await crawler.run(requests);

  } catch (error) {
    console.error(`❌ [Cron Importer Execution Error] Crawlee run crash:`, error.message);
  } finally {
    isCronRunning = false;
    console.log(`\n======================================================`);
    console.log(`🏁 [Cron Importer] Run complete. Crawlee browser pool released.`);
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

  if (checkCronCooldown()) {
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

      // Add randomized delay before scraping to simulate human browsing (20 to 40 seconds)
      if (i > 0) {
        const delayMs = Math.floor(Math.random() * (40000 - 20000 + 1)) + 20000;
        console.log(`[User Profile Cron] Waiting ${Math.round(delayMs / 1000)}s before next user crawl to evade blocks...`);
        await new Promise(r => setTimeout(r, delayMs));
      }

      try {
        // Run standard Crawlee profile scraping with built-in fingerprints
        const scraped = await scrapeInstagramData(targetUser);

        // Update database with scraped profile stats
        await saveProfileToDb(scraped.profile);

        // Reset failures on success
        resetCronFailures();

        console.log(`✅ [User Profile Cron] Successfully processed and synced profile for: "${targetUser}"`);
      } catch (scrapeErr) {
        console.error(`❌ [User Profile Cron Scraper Error] Failed to crawl profile for "${targetUser}":`, scrapeErr.message);

        // Track the failure to see if we need a cooldown
        handleCronFailure(scrapeErr.message || 'Profile scraping failed');

        // Fail-safe: Mark profile as processed to avoid getting stuck in process loop
        await prisma.instagram_user.update({
          where: { id: user.id },
          data: {
            is_processed: true,
            updated_at: new Date()
          }
        });
      }
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
