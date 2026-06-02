import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { scrapeInstagramData, extractUsername, extractShortcode, scrapeMultipleReelsDirect } from './scraper.js';
import { saveProfileToDb, saveReelsToDb, findOrCreateProfile, prisma } from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory active import jobs store
const importJobs = new Map();

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    service: 'instagram-crawlee-api'
  });
});

/**
 * Endpoint for Instagram profile details: username, fullName, bio, counts, profilePic.
 * Maps to /insta-profile and /instra-profile.
 */
const handleProfileScrape = async (req, res) => {
  const { profile_url } = req.body;

  if (!profile_url) {
    return res.status(400).json({
      success: false,
      error: 'profile_url is required in request body.'
    });
  }

  const username = extractUsername(profile_url);
  if (!username) {
    return res.status(400).json({
      success: false,
      error: 'Could not extract a valid username from the provided profile_url.'
    });
  }

  console.log(`\n📥 [API] POST /insta-profile called for username: "${username}"`);

  try {
    // 1. Crawl Instagram for the latest data using Crawlee Playwright
    const scraped = await scrapeInstagramData(username);

    // 2. Persist the crawled profile metadata into the remote MySQL database via Prisma
    const dbProfile = await saveProfileToDb(scraped.profile);

    // 3. Save any scraped reels/posts to MySQL as well for later use
    if (scraped.reels && scraped.reels.length > 0) {
      await saveReelsToDb(dbProfile.id, scraped.reels);
    }

    console.log(`✅ [API] Profile successfully synced and returned for: "${username}"`);

    // 4. Return successful scraped details
    return res.json({
      success: true,
      message: 'Profile scraped and database synchronized successfully.',
      data: dbProfile
    });
  } catch (error) {
    console.error(`❌ [Express API Error] Failed to scrape profile for "${username}":`, error.message);

    // Fail-safe fallback: Check if we have cached profile data in the database
    try {
      const cachedProfile = await prisma.instagramProfile.findUnique({
        where: { username }
      });
      if (cachedProfile) {
        console.log(`⚠️ [Express API Fallback] Returning cached database record for "${username}".`);
        return res.json({
          success: true,
          message: 'Scraping request failed (blocked/throttled). Returning cached database records.',
          data: cachedProfile
        });
      }
    } catch (dbErr) {
      console.error('[Express API Fallback Error] Database cache lookup failed:', dbErr.message);
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch Instagram profile and no cache was found.',
      details: error.message
    });
  }
};

/**
 * Endpoint for Instagram reels related to the profile.
 * Maps to /insta-profile-reels and /instra-profile-reels.
 */
const handleReelsScrape = async (req, res) => {
  const { profile_url } = req.body;

  if (!profile_url) {
    return res.status(400).json({
      success: false,
      error: 'profile_url is required in request body.'
    });
  }

  const username = extractUsername(profile_url);
  if (!username) {
    return res.status(400).json({
      success: false,
      error: 'Could not extract a valid username from the provided profile_url.'
    });
  }

  console.log(`\n📥 [API] POST /insta-profile-reels called for username: "${username}"`);

  try {
    // 1. Crawl Instagram for latest data (this fetches both profile and recent post reels)
    const scraped = await scrapeInstagramData(username);

    // 2. Sync profile details in the database first to ensure relational key constraints pass
    const dbProfile = await saveProfileToDb(scraped.profile);

    // 3. Upsert all scraped reels in database
    let dbReels = [];
    if (scraped.reels && scraped.reels.length > 0) {
      dbReels = await saveReelsToDb(dbProfile.id, scraped.reels);
    } else {
      // If scraper didn't pull any fresh reels, retrieve whatever we have saved in MySQL
      dbReels = await prisma.instagramReel.findMany({
        where: { profileId: dbProfile.id }
      });
    }

    console.log(`✅ [API] Reels successfully synced. Scraped ${dbReels.length} reels for: "${username}"`);

    return res.json({
      success: true,
      message: `Scraped and synchronized ${dbReels.length} reels to the database.`,
      data: dbReels
    });
  } catch (error) {
    console.error(`[Express API Error] Failed to scrape reels for "${username}":`, error.message);

    // Fail-safe fallback: Check if we have cached reels in the database
    try {
      const cachedProfile = await prisma.instagramProfile.findUnique({
        where: { username }
      });
      if (cachedProfile) {
        const cachedReels = await prisma.instagramReel.findMany({
          where: { profileId: cachedProfile.id }
        });
        if (cachedReels && cachedReels.length > 0) {
          console.log(`[Express API Fallback] Scraper failed. Returning ${cachedReels.length} cached database reels for "${username}".`);
          return res.json({
            success: true,
            message: 'Scraping request failed (blocked/throttled). Returning cached database reels.',
            data: cachedReels
          });
        }
      }
    } catch (dbErr) {
      console.error('[Express API Fallback Error] Database cache lookup failed:', dbErr.message);
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch Instagram reels and no cache was found.',
      details: error.message
    });
  }
};

/**
 * Endpoint to submit a JSON list of reels for bulk importing.
 * Deduplicates and checks against database for pre-existing records.
 */
const handleImportSubmit = async (req, res) => {
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

  console.log(`\n📥 [API] POST /insta-import received. Total reels provided: ${reels.length} for user "${username}"`);

  try {
    // 1. Extract and deduplicate shortcodes from input
    const uniqueShortcodes = Array.from(new Set(
      reels.map(r => extractShortcode(r)).filter(Boolean)
    ));

    console.log(`🔍 [API] Deduplicated to ${uniqueShortcodes.length} unique shortcodes.`);

    // 2. Query MySQL via Prisma to check which shortcodes already exist
    const existingRecords = await prisma.instagramReel.findMany({
      where: {
        shortcode: { in: uniqueShortcodes }
      },
      include: {
        profile: true
      }
    });

    const existingShortcodesMap = new Map(existingRecords.map(r => [r.shortcode, r]));

    const existingReels = [];
    const reelsToCrawl = [];

    uniqueShortcodes.forEach(shortcode => {
      if (existingShortcodesMap.has(shortcode)) {
        existingReels.push(existingShortcodesMap.get(shortcode));
      } else {
        reelsToCrawl.push(shortcode);
      }
    });

    // 3. Create a unique jobId and save state in our jobs Map
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const jobState = {
      id: jobId,
      profile: username,
      totalCount: uniqueShortcodes.length,
      existingCount: existingReels.length,
      toCrawlCount: reelsToCrawl.length,
      existingReels,
      reelsToCrawl,
      results: [],
      status: 'pending',
      cancelled: false
    };

    importJobs.set(jobId, jobState);

    console.log(`✅ [API] Bulk job "${jobId}" created. ${existingReels.length} already in DB (will skip), ${reelsToCrawl.length} to crawl.`);

    return res.json({
      success: true,
      jobId,
      total: uniqueShortcodes.length,
      existing: existingReels.length,
      toCrawl: reelsToCrawl.length
    });
  } catch (error) {
    console.error('❌ [Express API Error] Failed to initialize import job:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to initialize bulk import job.',
      details: error.message
    });
  }
};

/**
 * SSE endpoint to stream live bulk scraping progress and final report.
 * Listens to client disconnect to cancel Playwright crawl execution instantly.
 */
const handleImportStream = async (req, res) => {
  const { jobId } = req.params;
  const job = importJobs.get(jobId);

  if (!job) {
    res.status(404).send('Job not found.');
    return;
  }

  // Set headers for Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  console.log(`⚡ [SSE] Client connected to stream for job "${jobId}".`);

  job.status = 'running';

  // Listen to client disconnects (e.g. page refresh, tab close)
  req.on('close', () => {
    console.log(`🛑 [SSE] Client disconnected from job "${jobId}". Flagging cancellation.`);
    job.cancelled = true;
  });

  // 1. Immediately stream all pre-existing reels as successful/skipped
  for (const reel of job.existingReels) {
    if (job.cancelled) break;

    const progressData = {
      type: 'progress',
      shortcode: reel.shortcode,
      success: true,
      skipped: true,
      data: reel
    };

    job.results.push({ shortcode: reel.shortcode, success: true, skipped: true, data: reel });
    res.write(`data: ${JSON.stringify(progressData)}\n\n`);
  }

  // 2. If there are no new reels to crawl, finish immediately!
  if (job.reelsToCrawl.length === 0) {
    console.log(`🎉 [SSE] All ${job.totalCount} reels already exist in database. Job "${jobId}" complete!`);
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      summary: {
        total: job.totalCount,
        skipped: job.existingCount,
        crawled: 0,
        success: job.existingCount,
        error: 0
      }
    })}\n\n`);
    res.end();
    job.status = 'completed';
    return;
  }

  // 3. Ensure target profile exists/skeleton created in database
  let dbProfile;
  try {
    dbProfile = await findOrCreateProfile(job.profile);
  } catch (err) {
    console.error(`❌ [SSE Database Error] Profile lookup/creation failed for user "${job.profile}":`, err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: `Database profile initialization failed: ${err.message}` })}\n\n`);
    res.end();
    return;
  }

  // 4. Begin sequential crawling of the remaining reels using Playwright
  await scrapeMultipleReelsDirect(job.reelsToCrawl, job, async (shortcode, success, data, errorMsg) => {
    if (job.cancelled) return;

    if (success && data) {
      // Persist the crawled reel to the database linked to the profile ID
      let savedReel = data;
      try {
        const savedList = await saveReelsToDb(dbProfile.id, [data]);
        if (savedList && savedList.length > 0) {
          savedReel = savedList[0];
        }
      } catch (dbErr) {
        console.error(`⚠️ [SSE Database Warning] Failed to save scraped reel "${shortcode}":`, dbErr.message);
      }

      const progressData = {
        type: 'progress',
        shortcode,
        success: true,
        skipped: false,
        data: savedReel
      };

      job.results.push({ shortcode, success: true, skipped: false, data: savedReel });
      res.write(`data: ${JSON.stringify(progressData)}\n\n`);
    } else {
      const progressData = {
        type: 'progress',
        shortcode,
        success: false,
        skipped: false,
        error: errorMsg || 'Scraping failed.'
      };

      job.results.push({ shortcode, success: false, skipped: false, error: errorMsg });
      res.write(`data: ${JSON.stringify(progressData)}\n\n`);
    }
  });

  // 5. Stream final complete report and close stream
  if (job.cancelled) {
    console.log(`🛑 [SSE] Job "${jobId}" cancelled midway due to client disconnect.`);
    res.end();
    return;
  }

  const finalSuccess = job.results.filter(r => r.success).length;
  const finalError = job.results.filter(r => !r.success).length;

  console.log(`🎉 [SSE] Job "${jobId}" completed successfully! Succeeded: ${finalSuccess}, Failed: ${finalError}`);

  res.write(`data: ${JSON.stringify({
    type: 'complete',
    summary: {
      total: job.totalCount,
      skipped: job.existingCount,
      crawled: job.toCrawlCount,
      success: finalSuccess,
      error: finalError
    }
  })}\n\n`);

  res.end();
  job.status = 'completed';
};

// Register endpoints (with spelling variations and new SSE bulk importer routes)
app.post('/insta-profile', handleProfileScrape);
app.post('/instra-profile', handleProfileScrape);

app.post('/insta-profile-reels', handleReelsScrape);
app.post('/instra-profile-reels', handleReelsScrape);

app.post('/insta-import', handleImportSubmit);
app.get('/insta-import-stream/:jobId', handleImportStream);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Express Global Error]:', err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Instagram Crawlee API Server listening on port ${PORT}`);
  console.log(`🩺 Health: http://localhost:${PORT}/health`);
  console.log(`👤 Profile API: http://localhost:${PORT}/insta-profile`);
  console.log(`🎥 Reels API:   http://localhost:${PORT}/insta-profile-reels`);
  console.log(`======================================================\n`);
});
