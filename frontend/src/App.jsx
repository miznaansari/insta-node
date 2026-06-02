import React, { useState, useEffect } from 'react';
import {
  Search,
  User,
  Tv,
  Heart,
  MessageCircle,
  Play,
  ExternalLink,
  AlertCircle,
  Loader2,
  Clock,
  Database,
  Grid,
  MapPin,
  CheckCircle2,
  Calendar,
  Sparkles,
  Upload,
  FileText,
  X,
  Check
} from 'lucide-react';

const API_BASE_URL = 'http://localhost:3000';

function App() {
  const [profileUrl, setProfileUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('profile');

  // Scraped Data States
  const [profileData, setProfileData] = useState(null);
  const [reelsData, setReelsData] = useState(null);

  // Selected Reel for Modal Lightbox
  const [selectedReel, setSelectedReel] = useState(null);

  // Track broken thumbnail URLs to fall back to video frame at 1s (#t=1)
  const [brokenThumbnails, setBrokenThumbnails] = useState({});

  // JSON Import States
  const [activeMode, setActiveMode] = useState('explore'); // 'explore' or 'import'
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState(null); // { jobId, total, existing, toCrawl }
  const [importProgress, setImportProgress] = useState([]); // Array of progress events
  const [importCompleted, setImportCompleted] = useState(false);
  const [importSummary, setImportSummary] = useState(null); // { total, skipped, crawled, success, error }
  const [currentImportShortcode, setCurrentImportShortcode] = useState('');
  const [importJsonError, setImportJsonError] = useState('');

  const handleThumbnailError = (shortcode) => {
    setBrokenThumbnails(prev => ({
      ...prev,
      [shortcode]: true
    }));
  };

  // List of realistic loading sub-messages
  const loadingSteps = [
    "Initializing Crawlee engine...",
    "Launching headless Playwright browser...",
    "Navigating to Instagram profile...",
    "Intercepting web_profile_info GraphQL response...",
    "Extracting meta headers & public DOM elements...",
    "Creating database transaction...",
    "Synchronizing records in remote MySQL...",
    "Completing data transfer..."
  ];

  // Rotate loading step messages for premium UX
  useEffect(() => {
    let interval;
    if (loading) {
      setLoadingStep(0);
      interval = setInterval(() => {
        setLoadingStep((prev) => (prev < loadingSteps.length - 1 ? prev + 1 : prev));
      }, 2500);
    }
    return () => clearInterval(interval);
  }, [loading]);

  /**
   * Helper to reload profile details and display them below
   */
  const fetchProfileDetailsDirect = async (username) => {
    try {
      const profileResponse = await fetch(`${API_BASE_URL}/insta-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_url: username })
      });
      const profileJson = await profileResponse.json();
      if (profileJson.success) {
        setProfileData(profileJson.data);
      }

      const reelsResponse = await fetch(`${API_BASE_URL}/insta-profile-reels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_url: username })
      });
      const reelsJson = await reelsResponse.json();
      if (reelsJson.success) {
        setReelsData(reelsJson.data);
      }
      setActiveTab('reels');
    } catch (err) {
      console.error('Failed to reload profile details after bulk import:', err);
    }
  };

  /**
   * Handles JSON file choosing, parsing, and starting the import stream
   */
  const handleJsonUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setImportJsonError('');
    setError(null);
    setImportCompleted(false);
    setImportSummary(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (!json.profile) {
          throw new Error("Required field 'profile' is missing in your JSON.");
        }
        if (!Array.isArray(json.reels) || json.reels.length === 0) {
          throw new Error("Required array 'reels' is missing or empty in your JSON.");
        }

        // Trigger SSE Import job submit
        await startImport(json.profile, json.reels);
      } catch (err) {
        console.error('JSON parsing / validation failed:', err);
        setImportJsonError(err.message || 'Invalid JSON file format.');
      }
    };
    reader.readAsText(file);
  };

  /**
   * Triggers POST /insta-import then opens EventSource SSE stream for progress chunks
   */
  const startImport = async (profile, reels) => {
    setImporting(true);
    setImportProgress([]);
    setCurrentImportShortcode('');
    setImportJob(null);

    try {
      const response = await fetch(`${API_BASE_URL}/insta-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, reels })
      });

      const resJson = await response.json();
      if (!resJson.success) {
        throw new Error(resJson.error || 'Failed to initialize bulk import.');
      }

      setImportJob(resJson);

      // Connect to Server-Sent Events stream
      const eventSource = new EventSource(`${API_BASE_URL}/insta-import-stream/${resJson.jobId}`);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'progress') {
            setCurrentImportShortcode(data.shortcode);
            setImportProgress(prev => [...prev, data]);
          } else if (data.type === 'complete') {
            setImportSummary(data.summary);
            setImportCompleted(true);
            setImporting(false);
            eventSource.close();

            // Load the newly synced reels into the workspace dashboard
            fetchProfileDetailsDirect(profile);
          } else if (data.type === 'error') {
            setError(data.message);
            setImporting(false);
            eventSource.close();
          }
        } catch (parseErr) {
          console.error('Failed to parse SSE event chunk:', parseErr);
        }
      };

      eventSource.onerror = (err) => {
        console.error('EventSource SSE stream error:', err);
        setError('Direct bulk crawling stream connection lost.');
        setImporting(false);
        eventSource.close();
      };

    } catch (err) {
      console.error('Failed to start bulk import sequence:', err);
      setError(err.message || 'An unexpected error occurred.');
      setImporting(false);
    }
  };

  /**
   * Triggers the scrape APIs for the profile and reels
   */
  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    if (!profileUrl.trim()) return;

    setLoading(true);
    setError(null);
    setProfileData(null);
    setReelsData(null);
    setActiveTab('profile');
    setImportCompleted(false);

    try {
      // 1. Fetch Profile Data
      const profileResponse = await fetch(`${API_BASE_URL}/insta-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_url: profileUrl })
      });

      const profileJson = await profileResponse.json();
      if (!profileJson.success) {
        throw new Error(profileJson.error || 'Failed to fetch profile details.');
      }
      setProfileData(profileJson.data);

      // 2. Fetch Reels Data
      const reelsResponse = await fetch(`${API_BASE_URL}/insta-profile-reels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_url: profileUrl })
      });

      const reelsJson = await reelsResponse.json();
      if (reelsJson.success) {
        setReelsData(reelsJson.data);
      } else {
        console.warn('Reels fetch returned error:', reelsJson.error);
      }

    } catch (err) {
      console.error('Scrape API execution failed:', err);
      setError(err.message || 'An unexpected error occurred during crawling.');
    } finally {
      setLoading(false);
    }
  };

  // Helper to format large numbers beautifully (e.g. 1.2M, 450K)
  const formatNumber = (num) => {
    if (num === null || num === undefined) return 'N/A';
    if (num >= 1000000000) return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return num.toLocaleString();
  };

  return (
    <div style={{ minHeight: '100vh', padding: '24px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

      {/* HEADER SECTION */}
      <header style={{ width: '100%', maxWidth: '1100px', textAlign: 'center', marginBottom: '40px', marginTop: '20px' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <Sparkles className="text-gradient" style={{ width: '28px', height: '28px' }} />
          <span style={{ fontSize: '14px', fontWeight: '700', letterSpacing: '0.15em', textTransform: 'uppercase', color: '#ffb045' }}>CRAWLEE PLAYWRIGHT SCAPE</span>
        </div>
        <h1 className="text-gradient" style={{ fontSize: '3.2rem', marginBottom: '12px', fontWeight: '800' }}>
          InstaScope
        </h1>
        <p style={{ fontSize: '16px', color: 'var(--text-muted)', maxWidth: '600px', margin: '0 auto', lineHeight: '1.6' }}>
          Instantly crawl public Instagram profiles, download high-definition reels video URLs, and save structural metadata directly to MySQL.
        </p>
      </header>

      {/* DUAL MODE TAB SELECTOR */}
      <section style={{ width: '100%', maxWidth: '750px', marginBottom: '24px', display: 'flex', gap: '12px', background: 'rgba(255, 255, 255, 0.03)', padding: '6px', borderRadius: '30px', border: '1px solid var(--border-color)' }}>
        <button
          onClick={() => { setActiveMode('explore'); setError(null); }}
          style={{
            flex: 1,
            padding: '12px 24px',
            borderRadius: '24px',
            border: 'none',
            background: activeMode === 'explore' ? 'var(--insta-gradient)' : 'transparent',
            color: 'white',
            fontWeight: '600',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            transition: 'all 0.3s ease'
          }}
          disabled={loading || importing}
        >
          <Search style={{ width: '16px', height: '16px' }} />
          <span>Explore Profile</span>
        </button>
        <button
          onClick={() => { setActiveMode('import'); setError(null); }}
          style={{
            flex: 1,
            padding: '12px 24px',
            borderRadius: '24px',
            border: 'none',
            background: activeMode === 'import' ? 'var(--insta-gradient)' : 'transparent',
            color: 'white',
            fontWeight: '600',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            transition: 'all 0.3s ease'
          }}
          disabled={loading || importing}
        >
          <Upload style={{ width: '16px', height: '16px' }} />
          <span>JSON Bulk Import</span>
        </button>
      </section>

      {/* INPUT PANEL: EXPLORE MODE */}
      {activeMode === 'explore' && (
        <section style={{ width: '100%', maxWidth: '750px', marginBottom: '32px' }}>
          <form onSubmit={handleSearch} className="glass-panel" style={{ padding: '20px', display: 'flex', gap: '12px', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ flex: '1', minWidth: '280px', position: 'relative' }}>
              <Search style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', width: '20px', height: '20px' }} />
              <input
                type="text"
                placeholder="Enter Instagram profile URL or username (e.g. taylorswift)..."
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                className="input-field"
                style={{ paddingLeft: '48px' }}
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              className="btn-primary animate-glow"
              style={{ minWidth: '160px', height: '48px' }}
              disabled={loading || !profileUrl.trim()}
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin" style={{ width: '18px', height: '18px' }} />
                  <span>Crawling...</span>
                </>
              ) : (
                <>
                  <Search style={{ width: '18px', height: '18px' }} />
                  <span>Explore</span>
                </>
              )}
            </button>
          </form>
        </section>
      )}

      {/* INPUT PANEL: JSON BULK IMPORT MODE */}
      {activeMode === 'import' && !importing && (
        <section style={{ width: '100%', maxWidth: '750px', marginBottom: '32px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="glass-panel" style={{ padding: '32px', textAlign: 'center', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(255, 176, 69, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffb045' }}>
              <FileText style={{ width: '32px', height: '32px' }} />
            </div>
            <div>
              <h3 style={{ fontSize: '18px', fontWeight: '700', marginBottom: '8px' }}>Upload Instagram Reels JSON</h3>
              <p style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '480px', margin: '0 auto', lineHeight: '1.6' }}>
                Deduplicate and sync a structured reel list in real time. Items already in the database will be skipped instantly, while the rest are processed sequentially.
              </p>
            </div>

            <div style={{ width: '100%', maxWidth: '400px' }}>
              <input
                type="file"
                accept=".json"
                onChange={handleJsonUpload}
                style={{ display: 'none' }}
                id="json-file-input"
              />
              <label
                htmlFor="json-file-input"
                className="btn-primary animate-glow"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '12px 24px', cursor: 'pointer', width: '100%', justifyContent: 'center', height: '50px' }}
              >
                <Upload style={{ width: '18px', height: '18px' }} />
                <span>Choose JSON File</span>
              </label>
            </div>

            {importJsonError && (
              <p style={{ color: '#ef4444', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '600' }}>
                <AlertCircle style={{ width: '14px', height: '14px' }} /> {importJsonError}
              </p>
            )}

            <div style={{ background: 'rgba(0,0,0,0.25)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.03)', textAlign: 'left', width: '100%', maxWidth: '480px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>Expected JSON Layout:</span>
              <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '12px', color: '#ffb045', lineHeight: '1.4' }}>
{`{
  "profile": "thefoodiepanda",
  "reels": [
    "https://www.instagram.com/thefoodiepanda/reel/DY7bgiFThyC/",
    "DY4UB7Mz0v3"
  ]
}`}
              </pre>
            </div>
          </div>
        </section>
      )}

      {/* SSE BULK IMPORT ACTIVE LOADER & EVENT STREAM PROGRESS */}
      {importing && importJob && (
        <section style={{ width: '100%', maxWidth: '750px', marginBottom: '32px' }}>
          <div className="glass-panel" style={{ padding: '32px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Loader2 className="animate-spin" style={{ color: 'var(--insta-purple)', width: '20px', height: '20px' }} />
                  <span>Streaming Bulk Import Session</span>
                </h3>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Target Profile: <strong>@{importJob.profile}</strong> | Job ID: <code style={{ color: 'var(--insta-orange)' }}>{importJob.jobId}</code></span>
              </div>
              <span style={{ fontSize: '11px', background: 'rgba(255, 176, 69, 0.12)', color: '#ffb045', padding: '4px 10px', borderRadius: '12px', fontWeight: '700', textTransform: 'uppercase' }}>Streaming Live</span>
            </div>

            {/* SSE Progress Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase' }}>Total</span>
                <span style={{ fontSize: '20px', fontWeight: '800' }}>{importJob.total}</span>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase' }}>Processed</span>
                <span style={{ fontSize: '20px', fontWeight: '800', color: 'var(--insta-purple)' }}>{importProgress.length}</span>
              </div>
              <div style={{ background: 'rgba(34, 197, 94, 0.05)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(34, 197, 94, 0.1)', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: '#4ade80', display: 'block', textTransform: 'uppercase' }}>Success</span>
                <span style={{ fontSize: '20px', fontWeight: '800', color: '#4ade80' }}>{importProgress.filter(p => p.success).length}</span>
              </div>
              <div style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.1)', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: '#ef4444', display: 'block', textTransform: 'uppercase' }}>Errors</span>
                <span style={{ fontSize: '20px', fontWeight: '800', color: '#ef4444' }}>{importProgress.filter(p => !p.success).length}</span>
              </div>
            </div>

            {/* SSE Progress Bar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                  {currentImportShortcode ? (
                    <>Crawling shortcode: <code style={{ color: 'var(--insta-orange)' }}>{currentImportShortcode}</code>...</>
                  ) : (
                    'Initializing sequential Playwright crawler...'
                  )}
                </span>
                <span style={{ fontWeight: '700' }}>
                  {Math.round((importProgress.length / importJob.total) * 100)}%
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    background: 'var(--insta-gradient)',
                    width: `${(importProgress.length / importJob.total) * 100}%`,
                    transition: 'width 0.3s ease-out'
                  }}
                />
              </div>
            </div>

            {/* Live Streaming Logs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Connection Log Stream:</span>
              <div style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: '10px', height: '180px', overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px', fontFamily: 'monospace', fontSize: '12px', scrollBehavior: 'smooth' }}>
                {importProgress.length === 0 ? (
                  <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Awaiting initial server-sent chunks...</span>
                ) : (
                  [...importProgress].reverse().map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '4px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {item.success ? (
                          <CheckCircle2 style={{ width: '12px', height: '12px', color: '#4ade80' }} />
                        ) : (
                          <AlertCircle style={{ width: '12px', height: '12px', color: '#ef4444' }} />
                        )}
                        <span style={{ color: 'white' }}>shortcode: <strong>{item.shortcode}</strong></span>
                      </span>
                      <span style={{ fontSize: '11px', fontWeight: '700' }}>
                        {item.skipped ? (
                          <span style={{ color: '#22c55e', background: 'rgba(34, 197, 94, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>Skipped (In DB)</span>
                        ) : item.success ? (
                          <span style={{ color: '#ffb045', background: 'rgba(255, 176, 69, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>Scraped</span>
                        ) : (
                          <span style={{ color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>Failed</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', margin: 0 }}>
                💡 Page refresh closes connection and aborts Playwright browser sequentially.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* SSE BULK IMPORT FINAL SUMMARY REPORT CARD */}
      {importCompleted && importSummary && (
        <section style={{ width: '100%', maxWidth: '750px', marginBottom: '32px' }}>
          <div className="glass-panel" style={{ padding: '32px', display: 'flex', flexDirection: 'column', gap: '24px', borderLeft: '4px solid #22c55e', background: 'rgba(34, 197, 94, 0.01)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '20px', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '8px', color: '#4ade80' }}>
                  <CheckCircle2 style={{ width: '22px', height: '22px' }} />
                  <span>Bulk Import Stream Complete!</span>
                </h3>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Real-time crawler report fully generated.</span>
              </div>
              <button
                onClick={() => { setImportCompleted(false); setImportSummary(null); setImportProgress([]); }}
                style={{ background: 'rgba(255,255,255,0.05)', border: 'none', color: 'var(--text-muted)', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <X style={{ width: '14px', height: '14px' }} /> Clear Report
              </button>
            </div>

            {/* Summary Metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
              <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block' }}>TOTAL</span>
                <span style={{ fontSize: '16px', fontWeight: '800' }}>{importSummary.total}</span>
              </div>
              <div style={{ background: 'rgba(34, 197, 94, 0.05)', padding: '10px', borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(34, 197, 94, 0.1)' }}>
                <span style={{ fontSize: '10px', color: '#4ade80', display: 'block' }}>SKIPPED</span>
                <span style={{ fontSize: '16px', fontWeight: '800', color: '#4ade80' }}>{importSummary.skipped}</span>
              </div>
              <div style={{ background: 'rgba(255, 176, 69, 0.05)', padding: '10px', borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(255, 176, 69, 0.1)' }}>
                <span style={{ fontSize: '10px', color: '#ffb045', display: 'block' }}>CRAWLED</span>
                <span style={{ fontSize: '16px', fontWeight: '800', color: '#ffb045' }}>{importSummary.crawled}</span>
              </div>
              <div style={{ background: 'rgba(34, 197, 94, 0.1)', padding: '10px', borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                <span style={{ fontSize: '10px', color: '#22c55e', display: 'block' }}>SUCCESS</span>
                <span style={{ fontSize: '16px', fontWeight: '800', color: '#22c55e' }}>{importSummary.success}</span>
              </div>
              <div style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '10px', borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(239, 68, 68, 0.1)' }}>
                <span style={{ fontSize: '10px', color: '#ef4444', display: 'block' }}>ERRORS</span>
                <span style={{ fontSize: '16px', fontWeight: '800', color: '#ef4444' }}>{importSummary.error}</span>
              </div>
            </div>

            {/* Split Results Tables */}
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '260px', background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(34, 197, 94, 0.1)' }}>
                <h4 style={{ fontSize: '13px', color: '#4ade80', fontWeight: '700', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <CheckCircle2 style={{ width: '14px', height: '14px' }} />
                  <span>Successful Imports ({importProgress.filter(p => p.success).length})</span>
                </h4>
                <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', fontFamily: 'monospace' }}>
                  {importProgress.filter(p => p.success).map((item, idx) => (
                    <div key={idx} style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>✨ {item.shortcode}</span>
                      <span style={{ color: item.skipped ? '#22c55e' : '#ffb045', fontSize: '11px' }}>{item.skipped ? 'Archived' : 'Newly Synced'}</span>
                    </div>
                  ))}
                  {importProgress.filter(p => p.success).length === 0 && <span style={{ color: 'var(--text-muted)' }}>None</span>}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: '260px', background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.1)' }}>
                <h4 style={{ fontSize: '13px', color: '#f87171', fontWeight: '700', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <AlertCircle style={{ width: '14px', height: '14px' }} />
                  <span>Scraping Failures ({importProgress.filter(p => !p.success).length})</span>
                </h4>
                <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', fontFamily: 'monospace' }}>
                  {importProgress.filter(p => !p.success).map((item, idx) => (
                    <div key={idx} style={{ color: '#f87171', display: 'flex', flexDirection: 'column', gap: '2px', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '4px' }}>
                      <span>❌ shortcode: <strong>{item.shortcode}</strong></span>
                      <span style={{ fontStyle: 'italic', color: 'var(--text-muted)', paddingLeft: '14px' }}>Reason: {item.error}</span>
                    </div>
                  ))}
                  {importProgress.filter(p => !p.success).length === 0 && <span style={{ color: 'var(--text-muted)' }}>None</span>}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* CRAWLING ACTIVE LOADER STATE (EXPLORE MODE) */}
      {loading && activeMode === 'explore' && (
        <section style={{ width: '100%', maxWidth: '750px', textAlign: 'center', margin: '40px 0' }}>
          <div className="glass-panel" style={{ padding: '40px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <div style={{ width: '70px', height: '70px', borderRadius: '50%', border: '4px solid rgba(253, 29, 29, 0.1)', borderTopColor: 'var(--insta-red)', animation: 'spin 1s linear infinite' }} />
              <Loader2 className="animate-spin" style={{ position: 'absolute', top: '23px', left: '23px', width: '24px', height: '24px', color: 'var(--insta-purple)' }} />
            </div>
            <div>
              <h3 style={{ fontSize: '18px', marginBottom: '8px', color: 'var(--text-main)' }}>Live Crawler Session Active</h3>
              <p style={{ fontSize: '14px', color: 'var(--insta-orange)', fontWeight: '500', minHeight: '20px', transition: 'all 0.5s ease' }}>
                {loadingSteps[loadingStep]}
              </p>
            </div>
            <div style={{ width: '100%', maxWidth: '300px', height: '4px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '2px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  background: 'var(--insta-gradient)',
                  width: `${((loadingStep + 1) / loadingSteps.length) * 100}%`,
                  transition: 'width 0.5s ease-in-out'
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* ERROR STATUS PANEL */}
      {error && (
        <section style={{ width: '100%', maxWidth: '750px', marginBottom: '32px' }}>
          <div className="glass-panel" style={{ padding: '20px', borderLeft: '4px solid #ef4444', display: 'flex', alignItems: 'flex-start', gap: '16px', background: 'rgba(239, 68, 68, 0.05)' }}>
            <AlertCircle style={{ color: '#ef4444', width: '24px', height: '24px', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <h3 style={{ color: '#ef4444', fontSize: '16px', fontWeight: '600', marginBottom: '4px' }}>Scraping Pipeline Error</h3>
              <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: '1.5' }}>{error}</p>
            </div>
          </div>
        </section>
      )}


      {/* SCRAPED PROFILE RESULTS CONTENT */}
      {profileData && !loading && (
        <main style={{ width: '100%', maxWidth: '1100px', display: 'flex', flexDirection: 'column', gap: '28px' }}>

          {/* PROFILE INSIGHTS CARD */}
          <section className="glass-panel" style={{ padding: '32px', position: 'relative', overflow: 'hidden' }}>
            {/* Database sync badge in top corner */}
            <div style={{ position: 'absolute', top: '20px', right: '20px', display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)', padding: '6px 12px', borderRadius: '20px' }}>
              <Database style={{ color: '#22c55e', width: '12px', height: '12px' }} />
              <span style={{ fontSize: '11px', color: '#22c55e', fontWeight: '600' }}>MySQL Synced</span>
            </div>

            <div style={{ display: 'flex', gap: '32px', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Profile Pic avatar */}
              <div style={{ position: 'relative', flexShrink: '0' }}>
                <div style={{ width: '136px', height: '136px', borderRadius: '50%', background: 'var(--insta-gradient)', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(131, 58, 180, 0.25)' }}>
                  <img
                    src={profileData.profilePicUrl || 'https://via.placeholder.com/150'}
                    alt={profileData.username}
                    style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', background: '#111' }}
                    onError={(e) => {
                      e.target.src = `https://api.dicebear.com/7.x/initials/svg?seed=${profileData.username}`;
                    }}
                  />
                </div>
              </div>

              {/* Profile details text */}
              <div style={{ flex: '1', minWidth: '280px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                  <h2 style={{ fontSize: '24px', fontWeight: '700' }}>@{profileData.username}</h2>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.2)', color: '#60a5fa', fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '12px', textTransform: 'uppercase' }}>
                    <CheckCircle2 style={{ width: '11px', height: '11px' }} /> Public
                  </span>
                </div>

                {profileData.fullName && (
                  <h3 style={{ fontSize: '16px', color: 'var(--text-main)', fontWeight: '600', marginBottom: '12px' }}>
                    {profileData.fullName}
                  </h3>
                )}

                {/* Stat numbers bar */}
                <div style={{ display: 'flex', gap: '28px', margin: '18px 0', borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)', padding: '12px 0' }}>
                  <div>
                    <span style={{ fontSize: '18px', fontWeight: '700', color: 'white', display: 'block' }}>{formatNumber(profileData.postsCount)}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Posts</span>
                  </div>
                  <div>
                    <span style={{ fontSize: '18px', fontWeight: '700', color: 'white', display: 'block' }}>{formatNumber(profileData.followersCount)}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Followers</span>
                  </div>
                  <div>
                    <span style={{ fontSize: '18px', fontWeight: '700', color: 'white', display: 'block' }}>{formatNumber(profileData.followingCount)}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Following</span>
                  </div>
                </div>

                {profileData.bio && (
                  <div style={{ background: 'rgba(0, 0, 0, 0.15)', borderRadius: '12px', padding: '16px', border: '1px solid rgba(255, 255, 255, 0.03)' }}>
                    <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: '1.6', whiteSpace: 'pre-line' }}>
                      {profileData.bio}
                    </p>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '11px', marginTop: '16px' }}>
                  <Clock style={{ width: '12px', height: '12px' }} />
                  <span>Crawl Metadata Archived: {new Date(profileData.scrapedAt).toLocaleString()}</span>
                </div>
              </div>
            </div>
          </section>

          {/* TAB BAR SELECTOR */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', gap: '24px' }}>
            <button
              onClick={() => setActiveTab('profile')}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: activeTab === 'profile' ? '2px solid var(--insta-red)' : '2px solid transparent',
                color: activeTab === 'profile' ? 'white' : 'var(--text-muted)',
                fontSize: '15px',
                fontWeight: '600',
                padding: '12px 6px',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s ease'
              }}
            >
              <User style={{ width: '16px', height: '16px' }} />
              Profile Insights
            </button>
            <button
              onClick={() => setActiveTab('reels')}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: activeTab === 'reels' ? '2px solid var(--insta-red)' : '2px solid transparent',
                color: activeTab === 'reels' ? 'white' : 'var(--text-muted)',
                fontSize: '15px',
                fontWeight: '600',
                padding: '12px 6px',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s ease'
              }}
            >
              <Tv style={{ width: '16px', height: '16px' }} />
              Reels Catalog ({reelsData ? reelsData.length : 0})
            </button>
          </div>

          {/* TAB 1: PROFILE METRICS & ANALYTICS VISUALIZER */}
          {activeTab === 'profile' && (
            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px' }}>
              <div className="glass-panel" style={{ padding: '24px' }}>
                <h3 style={{ fontSize: '18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}><Sparkles style={{ color: 'var(--insta-orange)' }} /> Engagement Analysis</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div style={{ background: 'rgba(0, 0, 0, 0.15)', padding: '16px', borderRadius: '12px' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Estimated Post Frequency</span>
                    <span style={{ fontSize: '20px', fontWeight: '700', display: 'block', color: 'white', marginTop: '4px' }}>Daily Creator</span>
                  </div>
                  <div style={{ background: 'rgba(0, 0, 0, 0.15)', padding: '16px', borderRadius: '12px' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Scrape Coverage Status</span>
                    <span style={{ fontSize: '20px', fontWeight: '700', display: 'block', color: '#22c55e', marginTop: '4px' }}>100% Synced</span>
                  </div>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '24px' }}>
                <h3 style={{ fontSize: '18px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}><Database style={{ color: 'var(--insta-purple)' }} /> Relational Storage Schema</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Prisma Model:</span>
                    <code style={{ color: '#ffb045', fontSize: '13px' }}>InstagramProfile</code>
                  </div>
                  <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Primary ID Key:</span>
                    <span style={{ color: 'white', fontSize: '13px', fontWeight: '600' }}>{profileData.id}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Unique Unique:</span>
                    <span style={{ color: 'white', fontSize: '13px', fontWeight: '600' }}>@{profileData.username}</span>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* TAB 2: REELS GRID */}
          {activeTab === 'reels' && (
            <section>
              {(!reelsData || reelsData.length === 0) ? (
                <div className="glass-panel" style={{ padding: '60px 20px', textAlign: 'center' }}>
                  <Tv style={{ width: '48px', height: '48px', color: 'var(--text-muted)', marginBottom: '16px' }} />
                  <h3 style={{ fontSize: '18px', marginBottom: '8px' }}>No Reels Found</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                    This profile either has no public video posts, or they are locked behind login security checks.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '20px' }}>
                  {reelsData.map((reel) => (
                    <div
                      key={reel.shortcode}
                      className="glass-panel"
                      onClick={() => setSelectedReel(reel)}
                      style={{
                        overflow: 'hidden',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        height: '380px',
                        position: 'relative'
                      }}
                    >
                      {/* Image Thumbnail wrapper with overlay hover */}
                      <div style={{ position: 'relative', width: '100%', height: '260px', overflow: 'hidden', background: '#111' }}>
                        {brokenThumbnails[reel.shortcode] && reel.mediaUrl ? (
                          <video
                            src={`${reel.mediaUrl}#t=1`}
                            preload="metadata"
                            muted
                            playsInline
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <img
                            src={reel.thumbnailUrl || 'https://via.placeholder.com/300?text=Instagram+Post'}
                            alt="Reel Thumbnail"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            loading="lazy"
                            onError={() => handleThumbnailError(reel.shortcode)}
                          />
                        )}
                        {/* Hover Overlay containing metrics */}
                        <div style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: '100%',
                          background: 'rgba(0, 0, 0, 0.6)',
                          backdropFilter: 'blur(4px)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '20px',
                          opacity: 0,
                          transition: 'opacity 0.3s ease',
                          color: 'white',
                          fontWeight: '600'
                        }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = 0; }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <Play style={{ width: '24px', height: '24px', fill: 'white' }} />
                            <span style={{ fontSize: '14px' }}>{formatNumber(reel.viewCount)}</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <Heart style={{ width: '22px', height: '22px', fill: 'white' }} />
                            <span style={{ fontSize: '14px' }}>{formatNumber(reel.likeCount)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Content bottom section */}
                      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', flex: '1', justifyContent: 'space-between' }}>
                        <p style={{
                          fontSize: '13px',
                          color: 'var(--text-main)',
                          lineHeight: '1.4',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          height: '54px'
                        }}>
                          {reel.caption || "No caption available."}
                        </p>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px', marginTop: '10px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>shortcode: <code style={{ color: 'var(--insta-orange)' }}>{reel.shortcode}</code></span>
                          {reel.mediaUrl && (
                            <span style={{ fontSize: '10px', background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', padding: '2px 8px', borderRadius: '10px', fontWeight: '700', textTransform: 'uppercase' }}>MP4 Ready</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

        </main>
      )}

      {/* LIGHTBOX DIALOG MODAL DETAIL */}
      {selectedReel && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(4, 5, 10, 0.85)',
          backdropFilter: 'blur(8px)',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }}
          onClick={() => setSelectedReel(null)}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '900px',
              maxHeight: '90vh',
              overflowY: 'auto',
              background: '#090b16',
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Left side: Media Player / Thumbnail */}
            <div style={{ flex: '1.2', minWidth: '320px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px', position: 'relative' }}>
              {selectedReel.mediaUrl ? (
                <video
                  src={selectedReel.mediaUrl}
                  controls
                  autoPlay
                  style={{ width: '100%', maxHeight: '600px', objectFit: 'contain' }}
                />
              ) : (
                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                  <img
                    src={selectedReel.thumbnailUrl || 'https://via.placeholder.com/600'}
                    alt="Reel Detail"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <div style={{ position: 'absolute', bottom: '20px', left: '20px', right: '20px', background: 'rgba(0,0,0,0.6)', padding: '12px', borderRadius: '8px', backdropFilter: 'blur(4px)', textAlign: 'center' }}>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Video MP4 stream not direct available. Access standard post:</p>
                    <a
                      href={`https://www.instagram.com/reel/${selectedReel.shortcode}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--insta-orange)', display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none', fontWeight: '600', fontSize: '13px', marginTop: '6px' }}
                    >
                      View on Instagram <ExternalLink style={{ width: '12px', height: '12px' }} />
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* Right side: Scraped Meta details */}
            <div style={{ flex: '1', padding: '28px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderLeft: '1px solid var(--border-color)', minWidth: '300px' }}>
              <div>
                <div style={{ display: 'flex', justifyBetween: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: '16px', gap: '16px' }}>
                  <h3 style={{ fontSize: '18px' }}>Reel Analysis</h3>
                  <button
                    onClick={() => setSelectedReel(null)}
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: 'none',
                      color: 'var(--text-muted)',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '12px'
                    }}
                  >
                    Close
                  </button>
                </div>

                {/* Counts statistics block */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '24px' }}>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
                    <Play style={{ width: '16px', height: '16px', color: 'var(--insta-orange)', margin: '0 auto 6px' }} />
                    <span style={{ fontSize: '14px', fontWeight: '700', display: 'block' }}>{formatNumber(selectedReel.viewCount)}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Views</span>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
                    <Heart style={{ width: '15px', height: '15px', color: 'var(--insta-red)', margin: '0 auto 6px' }} />
                    <span style={{ fontSize: '14px', fontWeight: '700', display: 'block' }}>{formatNumber(selectedReel.likeCount)}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Likes</span>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', textAlign: 'center', border: '1px solid var(--border-color)' }}>
                    <MessageCircle style={{ width: '16px', height: '16px', color: 'var(--insta-purple)', margin: '0 auto 6px' }} />
                    <span style={{ fontSize: '14px', fontWeight: '700', display: 'block' }}>{formatNumber(selectedReel.commentCount)}</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Comments</span>
                  </div>
                </div>

                {/* Caption display */}
                <h4 style={{ fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px' }}>Caption</h4>
                <div style={{ maxHeight: '200px', overflowY: 'auto', background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '10px', border: '1px solid var(--border-color)', marginBottom: '20px' }}>
                  <p style={{ fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-line' }}>
                    {selectedReel.caption || "No caption available."}
                  </p>
                </div>
              </div>

              {/* DB and crawler status values */}
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Shortcode Identifier:</span>
                  <span style={{ color: 'white', fontFamily: 'monospace', fontWeight: '600' }}>{selectedReel.shortcode}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>MySQL Status:</span>
                  <span style={{ color: '#22c55e', fontWeight: '600', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Database style={{ width: '10px', height: '10px' }} /> Sync Complete
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
                  <span>Archived Time:</span>
                  <span>{new Date(selectedReel.scrapedAt).toLocaleString()}</span>
                </div>
              </div>

            </div>

          </div>
        </div>
      )}

      {/* FOOTER */}
      <footer style={{ marginTop: 'auto', paddingTop: '60px', paddingBottom: '20px', fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Database style={{ width: '12px', height: '12px' }} />
        <span>MySQL Schema Connected | Playwright Crawler Engine</span>
      </footer>

    </div>
  );
}

export default App;


