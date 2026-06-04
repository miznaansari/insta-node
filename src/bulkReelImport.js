import { PlaywrightCrawler, Configuration } from 'crawlee';
import { scrapeSingleReelDirect, extractUsername, extractShortcode } from './scraper.js';
import { findOrCreateProfile, saveReelsToDb, prisma } from './db.js';
import { isValidVideoBuffer } from './r2.js';

// In-memory active import jobs store
export const bulkImportJobs = new Map();

/**
 * Express handler to submit a JSON list of reels for bulk importing.
 */
export const handleBulkImportSubmit = async (req, res) => {
  const { profile, reels } = req.body;

  if (!profile) {
    return res.status(400).json({
      success: false,
      error: 'profile is required in request body.'
    });
  }

  if (!Array.isArray(reels) || reels.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'reels must be a non-empty array of Instagram reel URLs/shortcodes.'
    });
  }

  const username = extractUsername(profile);
  if (!username) {
    return res.status(400).json({
      success: false,
      error: 'Invalid profile username.'
    });
  }

  console.log(`\n📥 [Bulk Importer] POST /insta-import received. Total reels provided: ${reels.length} for user "${username}"`);

  try {
    // Extract and deduplicate shortcodes from input
    const uniqueShortcodes = Array.from(new Set(
      reels.map(r => extractShortcode(r)).filter(Boolean)
    ));

    console.log(`🔍 [Bulk Importer] Deduplicated to ${uniqueShortcodes.length} unique shortcodes.`);

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const jobState = {
      id: jobId,
      profile: username,
      totalCount: uniqueShortcodes.length,
      shortcodes: uniqueShortcodes,
      results: [],
      status: 'pending',
      cancelled: false
    };

    bulkImportJobs.set(jobId, jobState);

    console.log(`✅ [Bulk Importer] Job "${jobId}" initialized for @${username} with ${uniqueShortcodes.length} reels.`);

    return res.json({
      success: true,
      jobId,
      total: uniqueShortcodes.length
    });
  } catch (error) {
    console.error('❌ [Bulk Importer Error] Failed to initialize import job:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize bulk import job.',
      details: error.message
    });
  }
};

/**
 * SSE endpoint to stream live bulk scraping progress.
 */
export const handleBulkImportStream = async (req, res) => {
  const { jobId } = req.params;
  const job = bulkImportJobs.get(jobId);

  if (!job) {
    res.status(404).send('Job not found.');
    return;
  }

  // Set headers for Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  console.log(`⚡ [Bulk Importer SSE] Client connected to stream for job "${jobId}".`);

  job.status = 'running';

  // Listen to client disconnects (e.g. page refresh, tab close)
  req.on('close', () => {
    if (job.status === 'completed' || res.writableEnded) {
      return;
    }
    console.log(`🛑 [Bulk Importer SSE] Client disconnected from job "${jobId}". Flagging cancellation.`);
    job.cancelled = true;
  });

  let dbProfile;
  try {
    console.log(`[Bulk Importer] Resolving skeleton database profile for user "${job.profile}"...`);
    // Create/find a skeleton database profile record WITHOUT scraping the profile metadata page
    dbProfile = await findOrCreateProfile(job.profile);
  } catch (err) {
    console.error(`❌ [Bulk Importer Database Error] Profile lookup/creation failed:`, err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: `Database profile initialization failed: ${err.message}` })}\n\n`);
    res.end();
    return;
  }

  // Begin sequential crawling of the specified reels using PlaywrightCrawler from Crawlee
  const crawler = new PlaywrightCrawler({
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
          '--autoplay-policy=no-user-gesture-required' // satisfy autoplay requirements
        ],
      },
    },
    maxConcurrency: 1, // Sequential crawling to avoid aggressive throttling
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 60,

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
      }
    ],

    async requestHandler({ page, request, log }) {
      const { shortcode } = request.userData;

      if (job.cancelled) {
        log.info(`[Bulk Importer] Job was cancelled. Aborting crawler pool.`);
        crawler.autoscaledPool.abort();
        return;
      }

      log.info(`\n==========================================`);
      log.info(`[BULK IMPORT] PROCESSING SHORTCODE: "${shortcode}" via Crawlee`);
      log.info(`==========================================\n`);

      page.setDefaultNavigationTimeout(25000);

      // Perform extraction (scrapeSingleReelDirect will reuse page.videoChunks and skip page.goto if already navigated)
      const data = await scrapeSingleReelDirect(page, shortcode);
      
      if (job.cancelled) return;

      // Persist the crawled reel to the database linked to the profile ID
      let savedReel = data;
      try {
        const savedList = await saveReelsToDb(dbProfile.id, [data]);
        if (savedList && savedList.length > 0) {
          savedReel = savedList[0];
        }
      } catch (dbErr) {
        log.warning(`⚠️ [Bulk Importer DB Warning] Failed to save scraped reel "${shortcode}": ${dbErr.message}`);
      }

      const progressData = {
        type: 'progress',
        shortcode,
        success: true,
        data: savedReel
      };

      job.results.push({ shortcode, success: true, data: savedReel });
      res.write(`data: ${JSON.stringify(progressData)}\n\n`);
    },

    async failedRequestHandler({ request, error, log }) {
      const { shortcode } = request.userData;
      log.error(`[Bulk Importer] Crawlee failed crawling shortcode ${shortcode}: ${error.message}`);
      
      if (job.cancelled) return;

      const progressData = {
        type: 'progress',
        shortcode,
        success: false,
        error: error.message || 'Scraping failed.'
      };

      job.results.push({ shortcode, success: false, error: error.message });
      res.write(`data: ${JSON.stringify(progressData)}\n\n`);
    }
  }, new Configuration({ persistStorage: false }));

  const requests = job.shortcodes.map(shortcode => ({
    url: `https://www.instagram.com/reel/${shortcode}/`,
    userData: { shortcode },
    uniqueKey: `${shortcode}_${Date.now()}` // Bypass cached/duplicate key requests
  }));

  try {
    await crawler.run(requests);
  } catch (crawlErr) {
    console.error(`[Bulk Importer] PlaywrightCrawler run encountered an error:`, crawlErr.message);
  } finally {
    console.log(`[Bulk Importer] PlaywrightCrawler run complete.`);
  }

  if (job.cancelled) {
    console.log(`🛑 [Bulk Importer SSE] Job "${jobId}" cancelled midway.`);
    res.end();
    return;
  }

  const finalSuccess = job.results.filter(r => r.success).length;
  const finalError = job.results.filter(r => !r.success).length;

  console.log(`🎉 [Bulk Importer SSE] Job "${jobId}" completed successfully! Succeeded: ${finalSuccess}, Failed: ${finalError}`);

  res.write(`data: ${JSON.stringify({
    type: 'complete',
    summary: {
      total: job.totalCount,
      success: finalSuccess,
      error: finalError
    }
  })}\n\n`);

  job.status = 'completed';
  res.end();
};
