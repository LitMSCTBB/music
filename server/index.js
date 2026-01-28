import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { load } from "cheerio";

const app = express();
const PORT = process.env.PORT || 5174;
const MIDI_CACHE = new Map();
const MAX_CACHE_ENTRIES = 20;

app.use(cors());

const pruneCache = () => {
  if (MIDI_CACHE.size <= MAX_CACHE_ENTRIES) {
    return;
  }
  const [oldestKey] = MIDI_CACHE.keys();
  MIDI_CACHE.delete(oldestKey);
};

const pickBestMidiLink = (html) => {
  const $ = load(html);
  const links = [];
  $("a[href$='.mid']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      links.push(href);
    }
  });
  if (!links.length) {
    return null;
  }
  const preferred = links.find((link) => link.toLowerCase().includes(".mid"));
  return preferred || links[0];
};

const ensureAbsoluteUrl = (baseUrl, url) => {
  if (!url) {
    return null;
  }
  if (url.startsWith("http")) {
    return url;
  }
  return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
};

const fetchMidiFromBitMidi = async (song) => {
  // BitMidi search results include direct .mid links.
  const searchUrl = `https://bitmidi.com/search?q=${encodeURIComponent(song)}`;
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    throw new Error("BitMidi search failed");
  }
  const html = await searchResponse.text();
  const midiPath = pickBestMidiLink(html);
  if (!midiPath) {
    return null;
  }
  const midiUrl = ensureAbsoluteUrl("https://bitmidi.com", midiPath);
  const midiResponse = await fetch(midiUrl);
  if (!midiResponse.ok) {
    throw new Error("MIDI download failed");
  }
  const arrayBuffer = await midiResponse.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    sourceUrl: midiUrl
  };
};

const fetchMidiFromFreeMidi = async (song) => {
  // FreeMidi search uses query string, links often end in .mid.
  const searchUrl = `https://freemidi.org/search?q=${encodeURIComponent(song)}`;
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    return null;
  }
  const html = await searchResponse.text();
  const $ = load(html);
  const candidates = [];
  $("a[href*='.mid'], a[href*='/midi/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.toLowerCase().includes(".mid")) {
      candidates.push(href);
    }
  });
  if (!candidates.length) {
    return null;
  }
  const midiUrl = ensureAbsoluteUrl("https://freemidi.org", candidates[0]);
  const midiResponse = await fetch(midiUrl);
  if (!midiResponse.ok) {
    return null;
  }
  const arrayBuffer = await midiResponse.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    sourceUrl: midiUrl
  };
};

const fetchMidiFromMidiDb = async (song) => {
  // MidiDB provides a format=mid link for direct downloads.
  const searchUrl = `https://www.mididb.com/search/${encodeURIComponent(song)}/?format=short`;
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    return null;
  }
  const html = await searchResponse.text();
  const $ = load(html);
  const firstLink = $("a[href*='?format=mid']").first().attr("href");
  if (!firstLink) {
    return null;
  }
  const midiUrl = ensureAbsoluteUrl("https://www.mididb.com", firstLink);
  const midiResponse = await fetch(midiUrl);
  if (!midiResponse.ok) {
    return null;
  }
  const arrayBuffer = await midiResponse.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    sourceUrl: midiUrl
  };
};

const fetchMidiFromMidiWorld = async (song) => {
  // MidiWorld supports filename-based searches.
  const searchUrl = `https://www.midiworld.com/search/${encodeURIComponent(song)}/`;
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    return null;
  }
  const html = await searchResponse.text();
  const $ = load(html);
  const candidates = [];
  $("a[href$='.mid']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      candidates.push(href);
    }
  });
  if (!candidates.length) {
    return null;
  }
  const midiUrl = ensureAbsoluteUrl("https://www.midiworld.com", candidates[0]);
  const midiResponse = await fetch(midiUrl);
  if (!midiResponse.ok) {
    return null;
  }
  const arrayBuffer = await midiResponse.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    sourceUrl: midiUrl
  };
};

const fetchMidiFromSources = async (song) => {
  const sources = [
    { name: "BitMidi", handler: fetchMidiFromBitMidi },
    { name: "FreeMidi", handler: fetchMidiFromFreeMidi },
    { name: "MidiDB", handler: fetchMidiFromMidiDb },
    { name: "MidiWorld", handler: fetchMidiFromMidiWorld }
  ];

  for (const source of sources) {
    try {
      const result = await source.handler(song);
      if (result) {
        return { ...result, source: source.name };
      }
    } catch (error) {
      console.warn(`${source.name} lookup failed`, error.message);
    }
  }
  return null;
};

app.get("/api/find-midi", async (req, res) => {
  const song = req.query.song;
  if (!song) {
    res.status(400).json({ error: "Missing song query" });
    return;
  }

  if (MIDI_CACHE.has(song)) {
    const cached = MIDI_CACHE.get(song);
    res.set("Content-Type", "audio/midi");
    res.set("X-MIDI-Source", cached.sourceUrl);
    res.set("X-MIDI-Provider", cached.provider);
    res.send(cached.buffer);
    return;
  }

  try {
    const result = await fetchMidiFromSources(song);
    if (!result) {
      res.status(404).json({ error: "No MIDI found" });
      return;
    }
    MIDI_CACHE.set(song, {
      buffer: result.buffer,
      sourceUrl: result.sourceUrl,
      provider: result.source
    });
    pruneCache();
    res.set("Content-Type", "audio/midi");
    res.set("X-MIDI-Source", result.sourceUrl);
    res.set("X-MIDI-Provider", result.source);
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/download-midi", async (req, res) => {
  const midiUrl = req.query.url;
  if (!midiUrl || typeof midiUrl !== "string") {
    res.status(400).json({ error: "Missing MIDI url" });
    return;
  }
  if (!midiUrl.toLowerCase().includes(".mid")) {
    res.status(400).json({ error: "URL must point to a .mid file" });
    return;
  }
  try {
    const response = await fetch(midiUrl);
    if (!response.ok) {
      res.status(404).json({ error: "Unable to download MIDI" });
      return;
    }
    const arrayBuffer = await response.arrayBuffer();
    res.set("Content-Type", "audio/midi");
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/transcribe-midi", (_, res) => {
  res.status(501).json({
    error: "Transcription not configured",
    instructions: [
      "Install Spotify Basic Pitch locally.",
      "Run: pip install basic-pitch",
      "Then: basic-pitch <input-audio-path> <output-directory>",
      "Serve the generated .mid via /api/download-midi."
    ]
  });
});

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Karaoke MIDI server running on ${PORT}`);
});
