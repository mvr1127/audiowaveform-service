const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/generate-waveform", async (req, res) => {
  let tempAudioPath = "";
  let tempJsonPath = "";

  try {
    const { url, accessToken, referenceId } = req.body;
    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!accessToken)
      return res.status(400).json({ error: "Missing accessToken" });
    if (!referenceId)
      return res.status(400).json({ error: "Missing referenceId" });

    console.log("Processing Dropbox URL:", url);
    console.log("Reference ID:", referenceId);

    // 1. Download the audio file from Dropbox using the API
    let dropboxRes;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      // Shared link - use get_shared_link_file
      console.log("Using shared link download method");
      dropboxRes = await fetch(
        "https://content.dropboxapi.com/2/sharing/get_shared_link_file",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": JSON.stringify({ url: url }),
          },
        }
      );
    } else {
      // Direct path - use files/download
      console.log("Using direct path download method");
      dropboxRes = await fetch(
        "https://content.dropboxapi.com/2/files/download",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Dropbox-API-Arg": JSON.stringify({ path: url }),
          },
        }
      );
    }

    if (!dropboxRes.ok) {
      const errorText = await dropboxRes.text();
      throw new Error(
        `Dropbox download failed: ${dropboxRes.status} - ${errorText}`
      );
    }

    // 2. Extract filename and extension from Dropbox API response
    let filename = "audio.mp3"; // default fallback
    const apiResultHeader = dropboxRes.headers.get("dropbox-api-result");
    if (apiResultHeader) {
      try {
        const apiResult = JSON.parse(apiResultHeader);
        filename = apiResult.name || filename;
        console.log("Extracted filename from Dropbox API:", filename);
      } catch (e) {
        console.warn("Failed to parse dropbox-api-result header:", e);
      }
    }

    // Extract file extension
    const extension = path.extname(filename) || ".mp3";
    console.log("Detected filename:", filename, "Extension:", extension);

    // 3. Create temp files with proper extensions
    const tempDir = os.tmpdir();
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempAudioPath = path.join(
      tempDir,
      `waveform-audio-${uniqueId}${extension}`
    );
    tempJsonPath = path.join(tempDir, `waveform-peaks-${uniqueId}.json`);

    console.log("Temp audio path:", tempAudioPath);
    console.log("Temp JSON path:", tempJsonPath);

    // 4. Write audio file to temp location
    const audioBuffer = await dropboxRes.buffer();
    fs.writeFileSync(tempAudioPath, audioBuffer);
    console.log(
      "Audio file saved to temp path, size:",
      audioBuffer.length,
      "bytes"
    );

    // 5. Run audiowaveform CLI
    console.log("Running audiowaveform CLI...");

    await new Promise((resolve, reject) => {
      const args = [
        "-i",
        tempAudioPath,
        "-o",
        tempJsonPath,
        "--pixels-per-second",
        "20",
        "--output-format",
        "json",
      ];

      console.log("audiowaveform args:", args);
      const proc = spawn("audiowaveform", args);

      let stderr = "";
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(null);
        } else {
          reject(
            new Error(`audiowaveform exited with code ${code}: ${stderr}`)
          );
        }
      });

      proc.on("error", reject);
    });

    console.log("audiowaveform completed, reading peaks JSON");

    // 6. Read the peaks from the JSON file
    const jsonStr = fs.readFileSync(tempJsonPath, "utf-8");
    const waveform = JSON.parse(jsonStr);

    console.log("Parsed waveform JSON:", {
      duration: waveform.duration,
      sampleRate: waveform.sample_rate,
      numPeaks: waveform.samples?.length,
      channels: waveform.channels,
    });

    // 7. Save peaks to Supabase
    console.log("Saving peaks to Supabase for reference:", referenceId);
    const { error: updateError } = await supabase
      .from("reference_items")
      .update({
        waveform_peaks: waveform.samples,
        waveform_duration: waveform.duration,
        waveform_sample_rate: waveform.sample_rate,
      })
      .eq("id", referenceId);

    if (updateError) {
      console.error("Error saving peaks to Supabase:", updateError);
      return res.status(500).json({
        error: "Failed to save peaks to database",
        details: updateError.message,
      });
    }

    console.log("Successfully saved peaks to Supabase");

    // 8. Return the peaks data
    res.json({
      peaks: waveform.samples,
      duration: waveform.duration,
      sampleRate: waveform.sample_rate,
      numPeaks: waveform.samples.length,
      channels: waveform.channels,
      saved: true,
    });
  } catch (err) {
    console.error("Waveform error:", err);
    res.status(500).json({
      error: "Failed to generate waveform",
      details: err.message,
    });
  } finally {
    // Clean up temp files
    try {
      if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        fs.unlinkSync(tempAudioPath);
        console.log("Cleaned up temp audio file");
      }
      if (tempJsonPath && fs.existsSync(tempJsonPath)) {
        fs.unlinkSync(tempJsonPath);
        console.log("Cleaned up temp JSON file");
      }
    } catch (cleanupErr) {
      console.error("Error cleaning up temp files:", cleanupErr);
    }
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Waveform service running on port ${PORT}`);
  console.log("Environment variables:");
  console.log("- SUPABASE_URL:", process.env.SUPABASE_URL ? "Set" : "Missing");
  console.log(
    "- SUPABASE_SERVICE_ROLE_KEY:",
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "Set" : "Missing"
  );
});
