import { useRef, useState, useEffect, useCallback } from 'react';
import RippleDistortion from './RippleDistortion';
import VoiceAuroraWave from './VoiceAuroraWave';
import VoiceDropdown from './VoiceDropdown';
import SpeedDropdown from './SpeedDropdown';
import './App.css';

const VOICES = [
  { id: 'en-US-AriaNeural', label: 'American Female', desc: 'warm, clear' },
  { id: 'en-US-GuyNeural', label: 'American Male', desc: 'confident, natural' },
  { id: 'en-GB-SoniaNeural', label: 'British Female', desc: 'crisp, professional' },
  { id: 'en-GB-RyanNeural', label: 'British Male', desc: 'deep, calm' },
  { id: 'en-IN-NeerjaNeural', label: 'Indian Female', desc: 'warm, familiar' },
  { id: 'en-IN-PrabhatNeural', label: 'Indian Male', desc: 'clear, friendly' },
  { id: 'en-AU-NatashaNeural', label: 'Australian Female', desc: 'relaxed' },
  { id: 'en-AU-WilliamNeural', label: 'Australian Male', desc: 'casual' },
  { id: 'en-US-JennyNeural', label: 'American Female', desc: 'friendly, upbeat' },
  { id: 'en-GB-LibbyNeural', label: 'British Female', desc: 'young, energetic' },
];

function formatEta(s) {
  const total = Math.max(0, Math.ceil(Number(s) || 0));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${parseFloat(value.toFixed(i === 0 ? 0 : 2))} ${units[i]}`;
}

function AnalogClock({ progress, total, remaining }) {
  const CX = 100, CY = 100, R = 88;
  const CIRCUM = 2 * Math.PI * R;
  const hasCountdown = Number.isFinite(total) && total > 0 && Number.isFinite(remaining);
  const norm = hasCountdown
    ? Math.min(Math.max((total - Math.min(remaining, total)) / total, 0), 1)
    : Math.min(Math.max(progress / 100, 0), 1);
  const offset = CIRCUM * (1 - norm);
  const minuteDeg = norm * 360;
  const hourDeg = minuteDeg / 12;

  const ticks = Array.from({ length: 60 }, (_, i) => {
    const major = i % 5 === 0;
    const angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const outer = R;
    const inner = major ? R - 10 : R - 5;
    return {
      x1: CX + Math.cos(angle) * outer,
      y1: CY + Math.sin(angle) * outer,
      x2: CX + Math.cos(angle) * inner,
      y2: CY + Math.sin(angle) * inner,
      major,
    };
  });

  return (
    <svg viewBox="0 0 200 200" className="clock-svg">
      <circle className="face-ring" cx={CX} cy={CY} r={R} />
      {ticks.map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          className={t.major ? 'tick-major' : 'tick'} />
      ))}
      <circle
        className="sweep-arc"
        cx={CX} cy={CY} r={R}
        strokeDasharray={CIRCUM}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${CX} ${CY})`}
      />
      <line className="hand-hour"
        x1={CX} y1={CY} x2={CX} y2={46}
        transform={`rotate(${hourDeg} ${CX} ${CY})`} />
      <line className="hand-minute"
        x1={CX} y1={CY} x2={CX} y2={30}
        transform={`rotate(${minuteDeg} ${CX} ${CY})`} />
    </svg>
  );
}

function VoiceAuroraVisualizer({ audioRef }) {
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);

    setIsPlaying(!audio.paused);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [audioRef]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => { });
    } else {
      audio.pause();
    }
  };

  return (
    <div className="visualizer-container">
      <VoiceAuroraWave
        size={340}
        audioRef={audioRef}
        isListeningControlled={isPlaying}
        onToggle={togglePlayback}
        label={isPlaying ? "Playing" : "Click to play voice"}
      />
    </div>
  );
}

export default function App() {
  const [file, setFile] = useState(null);
  const [voice, setVoice] = useState('en-US-AriaNeural');
  const [speed, setSpeed] = useState(0);
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(0);
  const [pagesLabel, setPagesLabel] = useState('');
  const [statusText, setStatusText] = useState('');
  const [eta, setEta] = useState(null);
  const [etaTotal, setEtaTotal] = useState(null);
  const etaPhaseRef = useRef(null);
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [ocrUsed, setOcrUsed] = useState(false);
  const pollRef = useRef(null);
  const audioRef = useRef(null);
  const dropRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const renderProgress = useCallback((job) => {
    let pct = 0, lbl = '', txt = '';
    if (job.phase === 'extracting' || job.phase === 'ocr') {
      const done = job.pages_done || 0, total = job.pages_total || 1;
      pct = (done / total) * 40;
      lbl = `Page ${done} of ${total}`;
      txt = job.phase === 'ocr'
        ? `Running OCR on page ${job.ocr_page_number || done}… (scanned page detected)`
        : `Reading page ${done} of ${total}…`;
    } else if (job.phase === 'converting') {
      const done = job.chunks_done || 0, total = job.chunks_total || 1;
      pct = 40 + (done / total) * 60;
      lbl = job.ocr_used ? 'OCR used on scanned pages' : '';
      txt = `Converting to audio… part ${done} of ${total}`;
    } else if (job.phase === 'starting') {
      txt = 'Starting…';
    }
    setProgress(pct);
    setPagesLabel(lbl);
    setStatusText(txt);
    const pagesSeen = job.pages_done || 0;
    const hidden = pagesSeen < 3 && job.phase === 'extracting';
    const remaining = hidden || job.eta_seconds == null ? null : job.eta_seconds;
    setEta(remaining);
    if (remaining !== null) {
      const etaPhase = job.phase === 'converting' ? 'converting' : 'extracting';
      if (etaPhaseRef.current !== etaPhase) {
        etaPhaseRef.current = etaPhase;
        setEtaTotal(remaining);
      } else {
        setEtaTotal(prev => (prev == null || remaining > prev ? remaining : prev));
      }
    }
  }, []);

  const pollJob = useCallback(async (jobId) => {
    try {
      const res = await fetch(`/progress/${jobId}`);
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Server error (${res.status}): ${txt.replace(/<[^>]*>/g, '').trim().slice(0, 120)}`);
      }
      const job = await res.json();
      if (job.error) throw new Error(job.error);
      if (job.status === 'error') throw new Error(job.error || 'Conversion failed.');
      if (job.status === 'done') {
        stopPolling();
        setAudioUrl(job.audio_url);
        setWordCount(job.word_count || 0);
        setOcrUsed(job.ocr_used || false);
        setStatus('done');
        return;
      }
      renderProgress(job);
    } catch (e) {
      stopPolling();
      setError(e.message);
      setStatus('error');
    }
  }, [stopPolling, renderProgress]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) { setError('Please choose a PDF first.'); setStatus('error'); return; }
    setStatus('loading');
    setError('');
    setAudioUrl('');
    setProgress(0);
    setPagesLabel('');
    setStatusText('Uploading…');
    setEta(null);
    setEtaTotal(null);
    etaPhaseRef.current = null;

    const fd = new FormData();
    fd.append('pdf', file);
    fd.append('voice', voice);
    fd.append('speed', speed);

    try {
      const res = await fetch('/convert', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Something went wrong.');
      pollRef.current = setInterval(() => pollJob(data.job_id), 1200);
    } catch (e) {
      setError(e.message);
      setStatus('error');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    dropRef.current?.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.pdf')) setFile(f);
  };

  useEffect(() => () => stopPolling(), [stopPolling]);

  return (
    <>
      <RippleDistortion strength={28} />

      {/* Film grain overlay */}
      <div className="grain" />

      <div className="wrap">
        <header>
          <div className="eyebrow">Papervoice</div>
          <h1>Turn any PDF into<br /><em>something you can hear.</em></h1>
          <p className="sub">Drop in a document, pick a voice, and listen instead of reading. Free, no account needed.</p>
          <div className="wave-signature">
            {Array.from({ length: 11 }).map((_, i) => <span key={i} />)}
          </div>
        </header>

        <div className="card">
          <form onSubmit={handleSubmit}>
            {/* Drop zone */}
            <label
              className={`drop${file ? ' has-file' : ''}`}
              ref={dropRef}
              onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add('dragover'); }}
              onDragLeave={() => dropRef.current?.classList.remove('dragover')}
              onDrop={handleDrop}
            >
              <input type="file" accept="application/pdf" style={{ display: 'none' }}
                onChange={e => setFile(e.target.files[0] || null)} />
              <div className="drop-icon">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path d="M11 14V4M11 4L7 8M11 4l4 4" stroke="#f5f5f5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3 16v1a2 2 0 002 2h12a2 2 0 002-2v-1" stroke="#f5f5f5" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
              <div className="drop-text">
                {file ? file.name : <>Drag your PDF here <span>browse</span></>}
              </div>
              <div className="drop-sub">{file ? formatFileSize(file.size) : 'Up to 25 MB · PDF only'}</div>
            </label>

            {/* Controls */}
            <div className="controls">
              <div className="field">
                <label>Voice</label>
                <VoiceDropdown voices={VOICES} value={voice} onChange={setVoice} />
              </div>
              <div className="field">
                <label>Speed</label>
                <SpeedDropdown value={speed} onChange={setSpeed} />
              </div>
            </div>

            <button type="submit" className="btn-convert" disabled={status === 'loading'}>
              {status === 'loading' ? 'Converting…' : 'Convert to audio'}
            </button>

            {/* Status */}
            {status === 'loading' && (
              <div className="status-box">
                <div className="clock-wrap">
                  <AnalogClock progress={progress} total={etaTotal} remaining={eta} />
                  <div className="clock-eta">
                    <span className="eta-value">{eta === null ? '…' : formatEta(eta)}</span>
                    <span className="eta-label">remaining</span>
                  </div>
                </div>
                <div className="status-line">
                  <div className="spinner" />
                  <span>{statusText}</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
                </div>
                {pagesLabel && <div className="status-meta">{pagesLabel}</div>}
              </div>
            )}

            {/* Error */}
            {status === 'error' && (
              <div className="error-box">{error}</div>
            )}

            {/* Result */}
            {status === 'done' && (
              <div className="result-box">
                <VoiceAuroraVisualizer audioRef={audioRef} />
                <div className="result-meta">
                  {wordCount.toLocaleString()} words{ocrUsed ? ' · OCR used on scanned pages' : ''}
                </div>
                <audio ref={audioRef} src={audioUrl} controls />
                <a href={audioUrl} className="download-link" download="audio.mp3">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 9V2M7 9L4 6M7 9l3-3" stroke="#111" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M2 11h10" stroke="#111" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  Download mp3
                </a>
              </div>
            )}
          </form>
        </div>

        <footer>Nothing you upload is stored</footer>
      </div>
    </>
  );
}
