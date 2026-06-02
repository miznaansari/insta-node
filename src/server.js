import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { scrapeInstagramData, extractUsername } from './scraper.js';
import { saveProfileToDb, saveReelsToDb, prisma } from './db.js';
import { handleBulkImportSubmit, handleBulkImportStream } from './bulkReelImport.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// Register endpoints (with spelling variations and new SSE bulk importer routes)
app.post('/insta-profile', handleProfileScrape);
app.post('/instra-profile', handleProfileScrape);

app.post('/insta-profile-reels', handleReelsScrape);
app.post('/instra-profile-reels', handleReelsScrape);

app.post('/insta-import', handleBulkImportSubmit);
app.get('/insta-import-stream/:jobId', handleBulkImportStream);

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
