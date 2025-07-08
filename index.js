const express = require('express');
const fetch = require('node-fetch');
const { writeFile, unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const app = express();
app.use(express.json({ limit: '100mb' }));

app.post('/generate-waveform', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    // Download audio file
    const audioRes = await fetch(url);
    if (!audioRes.ok) return res.status(500).json({ error: 'Failed to download audio' });
    const audioBuffer = await audioRes.buffer();
    const tempAudioPath = join(tmpdir(), `${randomUUID()}.wav`);
    await writeFile(tempAudioPath, audioBuffer);

    // Run audiowaveform
    const tempJsonPath = join(tmpdir(), `${randomUUID()}.json`);
    await execFileAsync('audiowaveform', [
      '-i', tempAudioPath,
      '-o', tempJsonPath,
      '--pixels-per-second', '20',
      '--output-format', 'json'
    ]);

    // Read peaks
    const peaksJson = JSON.parse(await require('fs').promises.readFile(tempJsonPath, 'utf-8'));

    // Clean up
    await unlink(tempAudioPath);
    await unlink(tempJsonPath);

    res.json({ peaks: peaksJson.data });
  } catch (err) {
    console.error('Waveform error:', err);
    res.status(500).json({ error: 'Failed to generate waveform', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`audiowaveform service running on port ${PORT}`));