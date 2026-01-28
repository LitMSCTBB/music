import { useEffect, useMemo, useRef, useState } from "react";
import { Midi } from "@tonejs/midi";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";

const SCORE_WINDOW_SECONDS = 0.2;
const STABILITY_WINDOW = 15;

const hzToMidi = (frequency) => 69 + 12 * Math.log2(frequency / 440);
const midiToNote = (midi) => {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const note = noteNames[Math.round(midi) % 12];
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${note}${octave}`;
};

const autoCorrelate = (buffer, sampleRate) => {
  const size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i += 1) {
    const value = buffer[i];
    rms += value * value;
  }
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) {
    return -1;
  }
  let r1 = 0;
  let r2 = size - 1;
  const threshold = 0.2;
  for (let i = 0; i < size / 2; i += 1) {
    if (Math.abs(buffer[i]) < threshold) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < size / 2; i += 1) {
    if (Math.abs(buffer[size - i]) < threshold) {
      r2 = size - i;
      break;
    }
  }
  const trimmed = buffer.slice(r1, r2);
  const trimmedSize = trimmed.length;
  const correlations = new Array(trimmedSize).fill(0);
  for (let lag = 0; lag < trimmedSize; lag += 1) {
    for (let i = 0; i < trimmedSize - lag; i += 1) {
      correlations[lag] += trimmed[i] * trimmed[i + lag];
    }
  }
  let maxIndex = -1;
  let maxValue = -1;
  for (let i = 1; i < trimmedSize; i += 1) {
    if (correlations[i] > maxValue) {
      maxValue = correlations[i];
      maxIndex = i;
    }
  }
  if (maxIndex <= 0) {
    return -1;
  }
  return sampleRate / maxIndex;
};

const extractMelody = (midi) => {
  const tracks = midi.tracks.filter((track) => track.notes.length > 0);
  if (!tracks.length) {
    return [];
  }
  const ranked = tracks.map((track) => {
    const pitches = track.notes.map((note) => note.midi);
    const avgPitch = pitches.reduce((sum, p) => sum + p, 0) / pitches.length;
    return {
      track,
      score: avgPitch + pitches.length * 0.01
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].track.notes
    .map((note) => ({
      time: note.time,
      midi: note.midi,
      duration: note.duration
    }))
    .sort((a, b) => a.time - b.time);
};

const getCurrentNote = (notes, currentTime, pointerRef) => {
  let index = pointerRef.current;
  while (index < notes.length && currentTime > notes[index].time + notes[index].duration) {
    index += 1;
  }
  pointerRef.current = index;
  return notes[index];
};

export default function App() {
  const [songQuery, setSongQuery] = useState("");
  const [songTitle, setSongTitle] = useState("Ready to score a song");
  const [notes, setNotes] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Enter a song to start.");
  const [showUpload, setShowUpload] = useState(false);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [feedback, setFeedback] = useState("WAITING");
  const [currentPitch, setCurrentPitch] = useState(null);
  const [targetPitch, setTargetPitch] = useState(null);
  const [isListening, setIsListening] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  const audioRef = useRef(null);
  const analyserRef = useRef(null);
  const dataRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const startTimeRef = useRef(0);
  const pointerRef = useRef(0);
  const scoreTimeRef = useRef(0);
  const stableFramesRef = useRef(0);
  const lastCentsRef = useRef(null);

  const totalDuration = useMemo(() => {
    if (!notes.length) {
      return 0;
    }
    const last = notes[notes.length - 1];
    return last.time + last.duration;
  }, [notes]);

  useEffect(() => {
    if (score > 0 && score % 50 === 0) {
      confetti({
        particleCount: 120,
        spread: 70,
        origin: { y: 0.7 }
      });
    }
  }, [score]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      if (audioRef.current) {
        audioRef.current.close();
      }
    };
  }, []);

  const stopListening = () => {
    setIsListening(false);
    if (notes.length) {
      setStatus("Stopped. Ready when you are.");
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    if (audioRef.current) {
      audioRef.current.close();
      audioRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const startListening = async () => {
    if (!notes.length) {
      setError("Load a song first.");
      return;
    }
    setError("");
    setCelebrate(false);
    setStatus("Listening... sing along!");
    pointerRef.current = 0;
    scoreTimeRef.current = 0;
    stableFramesRef.current = 0;
    lastCentsRef.current = null;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    audioRef.current = audioContext;
    analyserRef.current = analyser;
    dataRef.current = new Float32Array(analyser.fftSize);
    streamRef.current = stream;
    startTimeRef.current = audioContext.currentTime;
    setIsListening(true);

    const update = () => {
      analyser.getFloatTimeDomainData(dataRef.current);
      const frequency = autoCorrelate(dataRef.current, audioContext.sampleRate);
      const now = audioContext.currentTime - startTimeRef.current;
      const expected = getCurrentNote(notes, now, pointerRef);
      if (expected) {
        setTargetPitch(expected.midi);
      }

      if (frequency !== -1) {
        const midiValue = hzToMidi(frequency);
        setCurrentPitch(midiValue);
        if (expected) {
          const cents = (midiValue - expected.midi) * 100;
          const error = Math.abs(cents);
          let points = 0;
          let label = "OFF";
          if (error <= 35) {
            points = 3;
            label = "ON NOTE";
          } else if (error <= 70) {
            points = 1;
            label = "CLOSE";
          }

          const shouldScore = now - scoreTimeRef.current >= SCORE_WINDOW_SECONDS;
          if (shouldScore) {
            scoreTimeRef.current = now;
            if (points > 0) {
              setScore((prev) => prev + points);
              setStreak((prev) => prev + 1);
            } else {
              setStreak(0);
            }
          }

          if (label === "ON NOTE" && expected.duration > 0.6) {
            const lastCents = lastCentsRef.current ?? cents;
            if (Math.abs(lastCents - cents) < 8) {
              stableFramesRef.current += 1;
              if (stableFramesRef.current >= STABILITY_WINDOW) {
                setScore((prev) => prev + 1);
                stableFramesRef.current = 0;
              }
            } else {
              stableFramesRef.current = 0;
            }
            lastCentsRef.current = cents;
          } else {
            stableFramesRef.current = 0;
            lastCentsRef.current = null;
          }
          setFeedback(label);
        }
      } else {
        setCurrentPitch(null);
        setFeedback("WAITING");
      }

      if (expected && now > totalDuration + 1) {
        setCelebrate(true);
        stopListening();
        return;
      }

      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);
  };

  const laneNotes = useMemo(() => {
    if (!notes.length || !targetPitch) {
      return [];
    }
    const start = Math.max(0, pointerRef.current - 3);
    const end = Math.min(notes.length, pointerRef.current + 6);
    return notes.slice(start, end);
  }, [notes, targetPitch]);

  const handleMidiArrayBuffer = (arrayBuffer, titleOverride) => {
    const midi = new Midi(arrayBuffer);
    const melody = extractMelody(midi);
    if (!melody.length) {
      throw new Error("MIDI parsed but no melody track was detected.");
    }
    setNotes(melody);
    setSongTitle(titleOverride || songQuery);
    setStatus("MIDI loaded. Ready to sing!");
    setShowUpload(false);
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    if (!songQuery) {
      return;
    }
    setIsLoading(true);
    setError("");
    setStatus("Searching for MIDI...");
    setCelebrate(false);
    setNotes([]);
    setScore(0);
    setStreak(0);
    setFeedback("WAITING");

    try {
      const response = await fetch(`/api/find-midi?song=${encodeURIComponent(songQuery)}`);
      if (!response.ok) {
        throw new Error("No MIDI found. Try another song or upload one manually.");
      }
      const arrayBuffer = await response.arrayBuffer();
      handleMidiArrayBuffer(arrayBuffer, songQuery);
    } catch (err) {
      setError(err.message);
      setStatus("No MIDI found. Drag and drop a file below.");
      setShowUpload(true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpload = async (file) => {
    if (!file) {
      return;
    }
    if (!file.name.toLowerCase().endsWith(".mid")) {
      setError("Please upload a .mid file.");
      return;
    }
    setError("");
    setStatus("Parsing uploaded MIDI...");
    const arrayBuffer = await file.arrayBuffer();
    handleMidiArrayBuffer(arrayBuffer, file.name.replace(/\\.mid$/i, ""));
  };

  const handleDrop = (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    handleUpload(file);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-midnight via-slate-950 to-black px-6 py-8 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-sm uppercase tracking-[0.3em] text-neon">Auto Karaoke Score</p>
          <h1 className="text-4xl font-semibold md:text-5xl">{songTitle}</h1>
          <p className="max-w-2xl text-slate-300">
            Search any song title, pull a MIDI automatically, and watch your voice light up the pitch lane.
          </p>
        </header>

        <form onSubmit={handleSearch} className="flex flex-col gap-3 md:flex-row md:items-center">
          <input
            value={songQuery}
            onChange={(event) => setSongQuery(event.target.value)}
            placeholder="Type a song title"
            className="flex-1 rounded-full border border-slate-700 bg-slate-900/80 px-6 py-3 text-lg text-white shadow-glow focus:border-neon focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-full bg-neon px-8 py-3 text-lg font-semibold text-midnight shadow-glow transition hover:scale-[1.02]"
            disabled={isLoading}
          >
            {isLoading ? "Searching..." : "Search MIDI"}
          </button>
          <button
            type="button"
            onClick={isListening ? stopListening : startListening}
            className="rounded-full border border-magenta px-8 py-3 text-lg font-semibold text-magenta transition hover:bg-magenta hover:text-midnight"
            disabled={!notes.length}
          >
            {isListening ? "Stop" : "Start Singing"}
          </button>
        </form>

        <p className="text-sm text-slate-300">{status}</p>
        {error && <p className="text-sm text-red-300">{error}</p>}

        {showUpload && (
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            className="glass rounded-3xl border border-dashed border-slate-700 p-6 text-center"
          >
            <p className="text-sm uppercase tracking-[0.3em] text-slate-400">Manual MIDI Upload</p>
            <p className="mt-3 text-base text-slate-200">
              Drag & drop a .mid file here, or click to select one.
            </p>
            <label className="mt-4 inline-block cursor-pointer rounded-full border border-neon px-6 py-2 text-sm font-semibold text-neon">
              Choose File
              <input
                type="file"
                accept=".mid"
                className="hidden"
                onChange={(event) => handleUpload(event.target.files[0])}
              />
            </label>
          </div>
        )}

        <section className="grid gap-4 md:grid-cols-3">
          {[
            { label: "Score", value: score },
            { label: "Streak", value: streak },
            { label: "Status", value: feedback }
          ].map((item) => (
            <div key={item.label} className="glass rounded-3xl border border-slate-800 p-6">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">{item.label}</p>
              <p className="mt-4 text-3xl font-semibold text-white">{item.value}</p>
            </div>
          ))}
        </section>

        <section className="glass rounded-[32px] border border-slate-800 p-6 md:p-10">
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Live Pitch Lane</p>
                <p className="text-lg text-slate-200">
                  Target: {targetPitch ? midiToNote(targetPitch) : "--"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Mic</p>
                <p className="text-lg text-neon">
                  {currentPitch ? midiToNote(currentPitch) : "--"}
                </p>
              </div>
            </div>

            <div className="relative h-48 rounded-3xl bg-slate-950/60 p-4">
              <div className="absolute inset-x-6 top-1/2 h-px bg-magenta/40" />
              {laneNotes.map((note) => {
                const offset = (note.time - (notes[pointerRef.current]?.time || 0)) * 20;
                const top = 50 - (note.midi - targetPitch) * 4;
                return (
                  <div
                    key={`${note.time}-${note.midi}`}
                    className="absolute left-8 h-3 w-24 rounded-full bg-neon/70"
                    style={{ transform: `translate(${offset}px, ${top}px)` }}
                  />
                );
              })}
              {currentPitch && targetPitch && (
                <motion.div
                  layout
                  className={`absolute right-8 h-4 w-4 rounded-full shadow-glow ${
                    feedback === "ON NOTE"
                      ? "bg-emerald-400"
                      : feedback === "CLOSE"
                        ? "bg-yellow-300"
                        : "bg-magenta"
                  }`}
                  style={{ top: `calc(50% - ${(currentPitch - targetPitch) * 4}px)` }}
                />
              )}
            </div>

            <div className="flex items-center justify-between text-sm text-slate-400">
              <p>Expected timeline: {notes.length} melody notes</p>
              <p>Duration: {totalDuration.toFixed(1)}s</p>
            </div>
          </div>
        </section>
      </div>

      <AnimatePresence>
        {celebrate && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="text-center">
              <p className="text-sm uppercase tracking-[0.3em] text-neon">Performance Complete</p>
              <h2 className="mt-4 text-5xl font-semibold text-white">Certified Superstar!</h2>
              <p className="mt-4 text-lg text-slate-300">Final score: {score}</p>
              <button
                onClick={() => setCelebrate(false)}
                className="mt-8 rounded-full bg-neon px-8 py-3 text-lg font-semibold text-midnight"
              >
                Sing Again
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
