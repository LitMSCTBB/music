import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { load } from "cheerio";

const app = express();
const PORT = process.env.PORT || 5174;
const MIDI_CACHE = new Map();
const MAX_CACHE_ENTRIES = 20;

app.use(cors());

const logInfo = (message, meta = {}) => {
  const timestamp = new Date().toISOString();
  if (Object.keys(meta).length) {
    console.log(`[${timestamp}] ${message}`, meta);
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
};

const normalizeSongTitle = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const scoreCandidate = (candidate, query) => {
  const normalizedQuery = normalizeSongTitle(query);
  const normalizedCandidate = normalizeSongTitle(candidate);
  if (!normalizedCandidate) {
    return 0;
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    return 1;
  }
  const queryParts = normalizedQuery.split(" ");
  const candidateParts = normalizedCandidate.split(" ");
  const matches = queryParts.filter((part) => candidateParts.includes(part)).length;
  return matches / Math.max(queryParts.length, 1);
};

const pickBestCandidate = (candidates, query) => {
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, query)
    }))
    .sort((a, b) => b.score - a.score);
  return scored;
};

const pruneCache = () => {
  if (MIDI_CACHE.size <= MAX_CACHE_ENTRIES) {
    return;
  }
  const [oldestKey] = MIDI_CACHE.keys();
  MIDI_CACHE.delete(oldestKey);
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
  logInfo("BitMidi search", { searchUrl });
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    throw new Error("BitMidi search failed");
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
    logInfo("BitMidi returned no midi links");
    return null;
  }
  const ranked = pickBestCandidate(candidates, song);
  logInfo("BitMidi candidates", {
    total: ranked.length,
    top: ranked.slice(0, 5)
  });
  const midiUrl = ensureAbsoluteUrl("https://bitmidi.com", ranked[0].candidate);
  logInfo("BitMidi selected candidate", { midiUrl });
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
  logInfo("FreeMidi search", { searchUrl });
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
    logInfo("FreeMidi returned no midi links");
    return null;
  }
  const ranked = pickBestCandidate(candidates, song);
  logInfo("FreeMidi candidates", {
    total: ranked.length,
    top: ranked.slice(0, 5)
  });
  const midiUrl = ensureAbsoluteUrl("https://freemidi.org", ranked[0].candidate);
  logInfo("FreeMidi selected candidate", { midiUrl });
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
  // MidiDB search endpoint: https://www.mididb.com/search.asp?q=...&formatID=1
  const searchUrl = `https://www.mididb.com/search.asp?q=${encodeURIComponent(song)}&formatID=1`;
  logInfo("MidiDB search", { searchUrl });
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    return null;
  }
  const html = await searchResponse.text();
  const $ = load(html);
  const links = $("a[href]")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter(
      (href) =>
        href &&
        (href.toLowerCase().includes(".mid") ||
          href.toLowerCase().includes("formatid=1") ||
          href.toLowerCase().includes("format=mid"))
    );
  if (!links.length) {
    logInfo("MidiDB returned no midi links");
    return null;
  }
  const ranked = pickBestCandidate(links, song);
  logInfo("MidiDB candidates", {
    total: ranked.length,
    top: ranked.slice(0, 5)
  });
  const midiUrl = ensureAbsoluteUrl("https://www.mididb.com", ranked[0].candidate);
  logInfo("MidiDB selected candidate", { midiUrl });
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
  // MidiWorld search endpoint: https://www.midiworld.com/search/?q=...
  const searchUrl = `https://www.midiworld.com/search/?q=${encodeURIComponent(song)}`;
  logInfo("MidiWorld search", { searchUrl });
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    return null;
  }
  const html = await searchResponse.text();
  const $ = load(html);
  const candidates = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) {
      return;
    }
    const normalized = href.toLowerCase();
    if (normalized.includes(".mid")) {
      candidates.push(href);
      return;
    }
    if (normalized.includes("midis/") || normalized.includes("midi/")) {
      candidates.push(href);
    }
  });
  if (!candidates.length) {
    logInfo("MidiWorld returned no midi links");
    return null;
  }
  const ranked = pickBestCandidate(candidates, song);
  logInfo("MidiWorld candidates", {
    total: ranked.length,
    top: ranked.slice(0, 5)
  });
  const midiUrl = ensureAbsoluteUrl("https://www.midiworld.com", ranked[0].candidate);
  logInfo("MidiWorld selected candidate", { midiUrl });
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

  logInfo("Starting MIDI lookup", { song });
  for (const source of sources) {
    try {
      logInfo("Searching source", { source: source.name });
      const result = await source.handler(song);
      if (result) {
        logInfo("MIDI found", { source: source.name, url: result.sourceUrl });
        return { ...result, source: source.name };
      }
      logInfo("No MIDI found in source", { source: source.name });
    } catch (error) {
      logInfo("Source lookup failed", { source: source.name, error: error.message });
    }
  }
  logInfo("No MIDI found in any source", { song });
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
