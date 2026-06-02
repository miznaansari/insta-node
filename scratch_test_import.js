
async function testImport() {
  const payload = {
    profile: "food__o__graphy",
    reels: [
      "https://www.instagram.com/reel/DY3wKphpXZJ/",
      "https://www.instagram.com/reel/DY_qeXCJ6iC/"
    ]
  };

  console.log("Sending POST /insta-import...");
  const response = await fetch("http://localhost:3000/insta-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const initData = await response.json();
  console.log("Job Initialized:", initData);

  if (!initData.success) {
    console.error("Job initialization failed.");
    return;
  }

  const jobId = initData.jobId;
  console.log(`Connecting to SSE stream for Job ${jobId}...`);

  // Start reading the SSE stream
  const streamRes = await fetch(`http://localhost:3000/insta-import-stream/${jobId}`);
  
  for await (const chunk of streamRes.body) {
    const lines = Buffer.from(chunk).toString().split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const sseData = JSON.parse(line.substring(6));
          console.log(`[SSE Event]`, JSON.stringify(sseData, null, 2));
        } catch (e) {
          console.log(`[SSE Plain]`, line);
        }
      }
    }
  }
  console.log("SSE Stream Ended.");
}

testImport().catch(err => {
  console.error("Test failed:", err);
});
