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

const fetchMidiFromBitMidi = async (song) => {
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
  const midiUrl = midiPath.startsWith("http")
    ? midiPath
    : `https://bitmidi.com${midiPath}`;
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

const fetchMidiFromFallback = async (song) => {
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
  const midiUrl = firstLink.startsWith("http")
    ? firstLink
    : `https://www.mididb.com${firstLink}`;
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

app.get("/fetch-midi", async (req, res) => {
  const song = req.query.song;
  if (!song) {
    res.status(400).json({ error: "Missing song query" });
    return;
  }

  if (MIDI_CACHE.has(song)) {
    const cached = MIDI_CACHE.get(song);
    res.set("Content-Type", "audio/midi");
    res.set("X-MIDI-Source", cached.sourceUrl);
    res.send(cached.buffer);
    return;
  }

  try {
    let result = await fetchMidiFromBitMidi(song);
    if (!result) {
      result = await fetchMidiFromFallback(song);
    }
    if (!result) {
      res.status(404).json({ error: "No MIDI found" });
      return;
    }
    MIDI_CACHE.set(song, result);
    pruneCache();
    res.set("Content-Type", "audio/midi");
    res.set("X-MIDI-Source", result.sourceUrl);
    res.send(result.buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Karaoke MIDI server running on ${PORT}`);
});
