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
  process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Get a valid Dropbox access token for a user, refreshing if necessary
 */
async function getValidDropboxToken(userId) {
  try {
    console.log("🔍 Getting valid Dropbox token for user:", userId);

    // First, try to get the current token
    const { data: profile, error: fetchError } = await supabase
      .from("profiles")
      .select(
        "dropbox_access_token, dropbox_refresh_token, dropbox_token_expires_at"
      )
      .eq("user_id", userId)
      .single();

    if (fetchError || !profile?.dropbox_access_token) {
      console.error("❌ No access token found for user:", userId);
      return { success: false, error: "No access token available" };
    }

    // Check if token is expired (with 5 minute buffer)
    const now = new Date();
    const expiresAt = new Date(profile.dropbox_token_expires_at);
    const bufferTime = 5 * 60 * 1000; // 5 minutes in milliseconds

    if (now.getTime() < expiresAt.getTime() - bufferTime) {
      console.log("✅ Token is still valid for user:", userId);
      return {
        success: true,
        accessToken: profile.dropbox_access_token,
        refreshed: false,
      };
    }

    // Token is expired, refresh it
    console.log("🔄 Token expired, refreshing for user:", userId);

    if (!profile.dropbox_refresh_token) {
      console.error("❌ No refresh token found for user:", userId);
      return { success: false, error: "No refresh token available" };
    }

    // Exchange refresh token for new access token
    const response = await fetch("https://api.dropboxapi.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: profile.dropbox_refresh_token,
        client_id: process.env.VITE_DROPBOX_CLIENT_ID,
        client_secret: process.env.VITE_DROPBOX_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Token refresh failed:", errorText);
      return {
        success: false,
        error: `Token refresh failed: ${response.status} - ${errorText}`,
      };
    }

    const newTokens = await response.json();

    // Calculate new expiration time (4 hours from now)
    const newExpiresAt = new Date();
    newExpiresAt.setHours(newExpiresAt.getHours() + 4);

    // Update database with new access token and expiration
    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        dropbox_access_token: newTokens.access_token,
        dropbox_token_expires_at: newExpiresAt.toISOString(),
      })
      .eq("user_id", userId);

    if (updateError) {
      console.error(
        "❌ Failed to update database with new token:",
        updateError
      );
      return { success: false, error: "Failed to save new token to database" };
    }

    console.log("✅ Token refreshed successfully for user:", userId);

    return {
      success: true,
      accessToken: newTokens.access_token,
      refreshed: true,
    };
  } catch (error) {
    console.error("❌ Error getting valid Dropbox token:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

app.post("/generate-waveform", async (req, res) => {
  let tempAudioPath = "";
  let tempJsonPath = "";

  try {
    // Initialize Supabase client inside the handler to avoid build-time issues
    const supabaseUrl =
      process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("Missing Supabase environment variables:", {
        PUBLIC_SUPABASE_URL: !!process.env.PUBLIC_SUPABASE_URL,
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!supabaseServiceKey,
      });
      return res.status(500).json({
        error: "Missing Supabase configuration",
        details:
          "PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY must be set",
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { url, accessToken, referenceId } = req.body;
    if (!url) return res.status(400).json({ error: "Missing url" });
    if (!referenceId)
      return res.status(400).json({ error: "Missing referenceId" });

    console.log("Processing Dropbox URL:", url);
    console.log("Reference ID:", referenceId);

    let userId = null;
    let validAccessToken = null;

    // Handle preview requests differently
    if (referenceId === "preview") {
      console.log("🎵 Preview request detected - using shared link access");

      // For preview, we'll try to access the file as a public shared link
      // This doesn't require user authentication
      validAccessToken = null; // We'll use public access
    } else {
      // Get the reference to find the user ID
      const { data: reference, error: refError } = await supabase
        .from("reference_items")
        .select("user_id")
        .eq("id", referenceId)
        .single();

      if (refError || !reference) {
        console.error("❌ Reference not found:", refError);
        return res.status(404).json({ error: "Reference not found" });
      }

      userId = reference.user_id;

      // Get a valid Dropbox access token (refresh if necessary)
      const tokenResult = await getValidDropboxToken(userId);
      if (!tokenResult.success) {
        console.error(
          "❌ Failed to get valid Dropbox token:",
          tokenResult.error
        );
        return res.status(401).json({
          error: "Dropbox authentication failed",
          details: tokenResult.error,
        });
      }

      validAccessToken = tokenResult.accessToken;
      console.log(
        "🔑 Using Dropbox access token:",
        !!validAccessToken,
        tokenResult.refreshed ? "(refreshed)" : "(existing)"
      );
    }

    // 1. Download the audio file from Dropbox using the API
    let dropboxRes;
    if (referenceId === "preview") {
      // For preview, try to download directly from the shared link
      console.log("🎵 Preview mode - downloading directly from shared link");

      // Convert Dropbox shared link to direct download link
      const directUrl = url.replace(
        "www.dropbox.com",
        "dl.dropboxusercontent.com"
      );
      console.log("Direct download URL:", directUrl);

      dropboxRes = await fetch(directUrl, {
        method: "GET",
      });
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      // Shared link - use get_shared_link_file
      console.log("Using shared link download method");
      dropboxRes = await fetch(
        "https://content.dropboxapi.com/2/sharing/get_shared_link_file",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${validAccessToken}`,
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
            Authorization: `Bearer ${validAccessToken}`,
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

    if (referenceId === "preview") {
      // For preview, extract filename from URL
      try {
        const urlParts = url.split("/");
        const lastPart = urlParts[urlParts.length - 1];
        const filenameFromUrl = lastPart.split("?")[0]; // Remove query params
        if (filenameFromUrl && filenameFromUrl.includes(".")) {
          filename = filenameFromUrl;
          console.log("Extracted filename from URL:", filename);
        }
      } catch (e) {
        console.warn("Failed to extract filename from URL:", e);
      }
    } else {
      // Use Dropbox API response headers
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
        "--split-channels",
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

    console.log("Raw waveform JSON:", JSON.stringify(waveform, null, 2));

    console.log("Parsed waveform JSON:", {
      version: waveform.version,
      channels: waveform.channels,
      sampleRate: waveform.sample_rate,
      samplesPerPixel: waveform.samples_per_pixel,
      bits: waveform.bits,
      length: waveform.length,
      dataLength: waveform.data?.length,
    });

    // Check if we have valid data array
    if (
      !waveform.data ||
      !Array.isArray(waveform.data) ||
      waveform.data.length === 0
    ) {
      console.error("❌ No valid data array generated by audiowaveform");
      console.error("Waveform structure:", Object.keys(waveform));
      return res.status(500).json({
        error: "Failed to generate valid waveform data",
        details: "audiowaveform did not produce expected data array",
      });
    }

    // 7. Save peaks to Supabase (skip for preview requests)
    if (referenceId !== "preview") {
      console.log("Saving peaks to Supabase for reference:", referenceId);
      const { error: updateError } = await supabase
        .from("reference_items")
        .update({
          waveform_peaks: waveform.data,
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
    } else {
      console.log("🎵 Preview mode - skipping database save");
    }

    // 8. Return the peaks data
    const responseData = {
      waveform: {
        data: waveform.data,
        version: waveform.version,
        channels: waveform.channels,
        sampleRate: waveform.sample_rate,
        samplesPerPixel: waveform.samples_per_pixel,
        bits: waveform.bits,
        length: waveform.length,
        numPeaks: waveform.data.length,
      },
      saved: referenceId !== "preview",
    };

    console.log(
      "✅ Waveform generated successfully:",
      waveform.data.length,
      "peaks",
      referenceId === "preview" ? "(preview mode)" : ""
    );

    res.json(responseData);
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
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: {
      PUBLIC_SUPABASE_URL: process.env.PUBLIC_SUPABASE_URL ? "Set" : "Missing",
      SUPABASE_URL: process.env.SUPABASE_URL ? "Set" : "Missing",
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
        ? "Set"
        : "Missing",
      VITE_DROPBOX_CLIENT_ID: process.env.VITE_DROPBOX_CLIENT_ID
        ? "Set"
        : "Missing",
      VITE_DROPBOX_CLIENT_SECRET: process.env.VITE_DROPBOX_CLIENT_SECRET
        ? "Set"
        : "Missing",
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Waveform service running on port ${PORT}`);
  console.log("Environment variables:");
  console.log(
    "- PUBLIC_SUPABASE_URL:",
    process.env.PUBLIC_SUPABASE_URL ? "Set" : "Missing"
  );
  console.log("- SUPABASE_URL:", process.env.SUPABASE_URL ? "Set" : "Missing");
  console.log(
    "- SUPABASE_SERVICE_ROLE_KEY:",
    process.env.SUPABASE_SERVICE_ROLE_KEY ? "Set" : "Missing"
  );
  console.log(
    "- VITE_DROPBOX_CLIENT_ID:",
    process.env.VITE_DROPBOX_CLIENT_ID ? "Set" : "Missing"
  );
  console.log(
    "- VITE_DROPBOX_CLIENT_SECRET:",
    process.env.VITE_DROPBOX_CLIENT_SECRET ? "Set" : "Missing"
  );
});
