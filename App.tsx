import React, { useState, useRef, useEffect, useCallback } from 'react';
import { generateSpeech } from './services/geminiService';
import { decodeBase64, pcmToWavBlob } from './utils/audioUtils';
import { processTextForTiming, TextToken } from './utils/textUtils';
import VoiceSelector from './components/VoiceSelector';
import Visualizer from './components/Visualizer';
import { VoiceName, Language, SAMPLE_TEXTS, SampleText, Emotion, EMOTION_OPTIONS } from './types';

const App: React.FC = () => {
  // State
  const [text, setText] = useState<string>(SAMPLE_TEXTS[2].content); // Default to Tamil Greeting
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>(VoiceName.Kore);
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(Language.Tamil);
  const [selectedEmotion, setSelectedEmotion] = useState<Emotion>(Emotion.Neutral);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1.0);
  const [currentBlobUrl, setCurrentBlobUrl] = useState<string | null>(null);

  // Highlight / Reader Mode State
  const [isReaderMode, setIsReaderMode] = useState(false);
  const [tokens, setTokens] = useState<TextToken[]>([]);
  const [activeTokenId, setActiveTokenId] = useState<number | null>(null);
  const [hasGeneratedAudio, setHasGeneratedAudio] = useState(false);

  // Audio Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioCtx({ sampleRate: 24000 });

      const analyzerNode = audioContextRef.current.createAnalyser();
      analyzerNode.fftSize = 256;
      analyserRef.current = analyzerNode;
      setAnalyser(analyzerNode);
    }

    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }

    if (audioRef.current && audioContextRef.current && !mediaSourceRef.current && analyserRef.current) {
      try {
        mediaSourceRef.current = audioContextRef.current.createMediaElementSource(audioRef.current);
        mediaSourceRef.current.connect(analyserRef.current);
        analyserRef.current.connect(audioContextRef.current.destination);
      } catch (e) {
        console.error("Error creating MediaElementSource:", e);
      }
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed]);

  // Animation Loop for Highlighting
  const updateHighlight = useCallback(() => {
    if (audioRef.current && !audioRef.current.paused) {
      const currentTime = audioRef.current.currentTime;

      // Find the active token
      const active = tokens.find(t =>
        t.isWord &&
        t.start !== undefined &&
        t.end !== undefined &&
        currentTime >= t.start &&
        currentTime < t.end
      );

      if (active) {
        setActiveTokenId(active.id);
      } else if (currentTime >= (tokens[tokens.length - 1]?.end || 0)) {
        setActiveTokenId(null);
      }

      animationFrameRef.current = requestAnimationFrame(updateHighlight);
    }
  }, [tokens]);

  useEffect(() => {
    if (isPlaying) {
      animationFrameRef.current = requestAnimationFrame(updateHighlight);
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      setActiveTokenId(null);
    }
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isPlaying, updateHighlight]);

  const handleGenerate = async () => {
    if (!text.trim()) return;
    if (!import.meta.env.VITE_GEMINI_API_KEY) {
      setError("API Key is missing.");
      return;
    }

    setIsLoading(true);
    setError(null);
    stopAudio();
    setHasGeneratedAudio(false);

    try {
      initAudioContext();

      const base64Audio = await generateSpeech(text, selectedVoice, selectedEmotion);
      const rawBytes = decodeBase64(base64Audio);

      // Process WAV
      const wavBlob = pcmToWavBlob(rawBytes, 24000);
      const blobUrl = URL.createObjectURL(wavBlob);

      // Calculate Duration for Timings (Estimate based on PCM size)
      // 24kHz * 16bit * 1ch = 48000 bytes/sec
      const estimatedDuration = rawBytes.length / 48000;
      const calculatedTokens = processTextForTiming(text, estimatedDuration);
      setTokens(calculatedTokens);

      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
      setCurrentBlobUrl(blobUrl);
      setHasGeneratedAudio(true);

      // Auto-switch to reader mode
      setIsReaderMode(true);

      if (audioRef.current) {
        audioRef.current.src = blobUrl;
        audioRef.current.playbackRate = speed;
        try {
          await audioRef.current.play();
          setIsPlaying(true);
        } catch (e) {
          console.warn("Autoplay blocked:", e);
        }
      }

    } catch (err: any) {
      setError(err.message || "Failed to generate speech");
    } finally {
      setIsLoading(false);
    }
  };

  const handleReplay = async () => {
    if (audioRef.current && currentBlobUrl) {
      initAudioContext();
      audioRef.current.currentTime = 0;
      audioRef.current.playbackRate = speed;
      setIsReaderMode(true);
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (e) {
        console.error("Playback failed:", e);
      }
    }
  };

  const handleDownload = () => {
    if (currentBlobUrl) {
      const a = document.createElement('a');
      a.href = currentBlobUrl;
      a.download = `vocalize-${selectedVoice}-${selectedEmotion.toLowerCase()}-${Date.now()}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  const handleLanguageChange = (lang: Language) => {
    setSelectedLanguage(lang);
    // Find first sample text for this language
    const defaultSample = SAMPLE_TEXTS.find(s => s.language === lang);
    if (defaultSample) setText(defaultSample.content);
  };

  const handleSampleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sampleId = e.target.value;
    const sample = SAMPLE_TEXTS.find(s => s.id === sampleId);
    if (sample) {
      setText(sample.content);
      setSelectedLanguage(sample.language);
      setHasGeneratedAudio(false);
      setIsReaderMode(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">

      {/* Ambient Background Blobs */}
      <div className="absolute top-0 -left-4 w-72 h-72 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
      <div className="absolute top-0 -right-4 w-72 h-72 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
      <div className="absolute -bottom-8 left-20 w-72 h-72 bg-pink-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-4000"></div>

      {/* Navbar */}
      <nav className="sticky top-0 z-50 backdrop-blur-xl bg-slate-950/70 border-b border-slate-800/50 animate-enter">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
              Vocalize AI
            </span>
          </div>
          <div className="text-xs font-medium px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300">
            Gemini 2.5 Preview
          </div>
        </div>
      </nav>

      <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 relative z-10">

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-full">

          {/* Left Panel: Configuration */}
          <div className="lg:col-span-4 space-y-6 animate-enter delay-100">
            <div className="bg-slate-900/40 backdrop-blur-md border border-slate-800/50 rounded-2xl p-6 shadow-xl hover:shadow-2xl hover:bg-slate-900/50 transition-all duration-500">

              <div className="mb-6">
                <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-3">Language & Samples</label>

                {/* Language Toggle */}
                <div className="flex p-1 bg-slate-950/50 rounded-xl border border-slate-800/50 mb-4">
                  <button
                    onClick={() => handleLanguageChange(Language.Tamil)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${selectedLanguage === Language.Tamil
                        ? 'bg-slate-800 text-white shadow-lg scale-[1.02]'
                        : 'text-slate-400 hover:text-slate-200'
                      }`}
                  >
                    Tamil
                  </button>
                  <button
                    onClick={() => handleLanguageChange(Language.English)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${selectedLanguage === Language.English
                        ? 'bg-slate-800 text-white shadow-lg scale-[1.02]'
                        : 'text-slate-400 hover:text-slate-200'
                      }`}
                  >
                    English
                  </button>
                </div>

                {/* Sample Dropdown */}
                <select
                  onChange={handleSampleSelect}
                  className="w-full bg-slate-950/50 border border-slate-800/50 text-slate-300 text-sm rounded-lg p-3 outline-none focus:ring-2 focus:ring-indigo-500/50 hover:bg-slate-900/50 transition-all duration-300"
                >
                  <option value="">Load a Sample Text...</option>
                  {SAMPLE_TEXTS.map(sample => (
                    <option key={sample.id} value={sample.id}>
                      {sample.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-6">
                <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-3">Voice Model</label>
                <VoiceSelector
                  selectedVoice={selectedVoice}
                  onSelect={setSelectedVoice}
                  disabled={isLoading || isPlaying}
                />
              </div>

              {/* Emotional Tone Selector */}
              <div className="mb-6">
                <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold mb-3">Emotional Tone</label>
                <div className="grid grid-cols-3 gap-2">
                  {EMOTION_OPTIONS.map((emotion) => (
                    <button
                      key={emotion.id}
                      onClick={() => setSelectedEmotion(emotion.id)}
                      disabled={isLoading || isPlaying}
                      className={`
                          flex flex-col items-center justify-center p-2 rounded-xl border transition-all duration-200
                          ${selectedEmotion === emotion.id
                          ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-200 shadow-[0_0_10px_rgba(99,102,241,0.2)]'
                          : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'}
                          ${(isLoading || isPlaying) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:scale-105 active:scale-95'}
                        `}
                    >
                      <span className="text-xl mb-1 filter drop-shadow-md">{emotion.emoji}</span>
                      <span className="text-[10px] font-medium tracking-wide uppercase">{emotion.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-xs uppercase tracking-wider text-slate-500 font-bold">Speech Rate</label>
                  <span className="text-xs font-mono bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded transition-all">{speed.toFixed(2)}x</span>
                </div>
                <div className="relative flex items-center w-full h-10">
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
                  />
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 font-medium">
                  <span className="cursor-pointer hover:text-indigo-400 transition-colors" onClick={() => setSpeed(0.5)}>0.5x</span>
                  <span className="cursor-pointer hover:text-indigo-400 transition-colors" onClick={() => setSpeed(1.0)}>1.0x</span>
                  <span className="cursor-pointer hover:text-indigo-400 transition-colors" onClick={() => setSpeed(1.5)}>1.5x</span>
                  <span className="cursor-pointer hover:text-indigo-400 transition-colors" onClick={() => setSpeed(2.0)}>2.0x</span>
                </div>
              </div>

            </div>
          </div>

          {/* Right Panel: Output & Controls */}
          <div className="lg:col-span-8 flex flex-col space-y-6 animate-enter delay-200">

            {/* Input / Reader Area */}
            <div className={`
              relative flex-grow min-h-[300px] bg-slate-900/40 backdrop-blur-md border rounded-2xl p-1 shadow-xl group focus-within:ring-2 focus-within:ring-indigo-500/30 transition-all duration-500 flex flex-col
              ${isReaderMode ? 'border-indigo-500/30 shadow-[0_0_20px_rgba(79,70,229,0.1)]' : 'border-slate-800/50'}
            `}>

              {/* Toolbar */}
              {hasGeneratedAudio && (
                <div className="absolute top-3 right-3 z-10 flex space-x-2 animate-enter">
                  <button
                    onClick={() => setIsReaderMode(!isReaderMode)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800/80 backdrop-blur text-xs font-medium text-indigo-300 border border-indigo-500/30 hover:bg-slate-700 hover:scale-105 transition-all active:scale-95"
                  >
                    {isReaderMode ? 'Edit Text' : 'Reader Mode'}
                  </button>
                </div>
              )}

              {isReaderMode && hasGeneratedAudio ? (
                <div className="w-full h-full bg-transparent p-6 text-lg leading-relaxed text-slate-300 overflow-y-auto max-h-[500px] custom-scrollbar rounded-xl animate-enter">
                  {tokens.map((token) => (
                    <span
                      key={token.id}
                      className={`
                         transition-all duration-200 rounded px-1 py-0.5 mx-0.5
                         ${token.id === activeTokenId
                          ? 'bg-indigo-600/90 text-white shadow-lg scale-110 font-medium inline-block transform origin-center'
                          : 'hover:bg-slate-800/50 hover:text-slate-100'}
                       `}
                    >
                      {token.text}
                    </span>
                  ))}
                </div>
              ) : (
                <textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setHasGeneratedAudio(false);
                  }}
                  className="w-full h-full bg-transparent p-6 text-lg leading-relaxed text-slate-200 outline-none resize-none placeholder:text-slate-600 rounded-xl transition-colors animate-enter"
                  placeholder="Enter text here to synthesize..."
                  disabled={isLoading}
                />
              )}

              {!isReaderMode && (
                <div className="absolute bottom-4 right-4 text-xs text-slate-600 pointer-events-none">
                  {text.length} chars
                </div>
              )}
            </div>

            {/* Visualizer & Actions */}
            <div className="bg-slate-900/40 backdrop-blur-md border border-slate-800/50 rounded-2xl p-6 shadow-xl hover:shadow-2xl transition-all duration-500">

              {/* Visualizer Container */}
              <div className={`
                 relative w-full h-40 bg-slate-950/50 rounded-xl overflow-hidden border mb-6 group transition-all duration-700
                 ${isPlaying ? 'border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.2)] animate-pulse-glow' : 'border-slate-800/50'}
               `}>
                <audio
                  ref={audioRef}
                  className="hidden"
                  onEnded={() => {
                    setIsPlaying(false);
                    setActiveTokenId(null);
                  }}
                  onPause={() => setIsPlaying(false)}
                  onPlay={() => setIsPlaying(true)}
                  crossOrigin="anonymous"
                />

                {isPlaying ? (
                  <>
                    <Visualizer analyser={analyser} isPlaying={isPlaying} />
                    <div className="absolute top-3 right-3 flex items-center gap-2">
                      <span className="animate-pulse w-2 h-2 bg-red-500 rounded-full shadow-[0_0_10px_rgba(239,68,68,0.5)]"></span>
                      <span className="text-[10px] uppercase tracking-wider text-red-400 font-bold drop-shadow-md">Playing</span>
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                    <div className="flex items-center space-x-1 h-12 mb-2 opacity-50">
                      {[...Array(7)].map((_, i) => (
                        <div
                          key={i}
                          className="w-1.5 bg-slate-500 rounded-full animate-pulse"
                          style={{
                            height: `${30 + Math.random() * 40}%`,
                            animationDelay: `${i * 0.1}s`
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-xs font-medium uppercase tracking-widest opacity-70">Visualization Ready</span>
                  </div>
                )}
              </div>

              {/* Control Bar */}
              <div className="flex flex-col sm:flex-row gap-4">

                {/* Primary Action */}
                <div className="flex-grow">
                  {!isPlaying ? (
                    <button
                      onClick={handleGenerate}
                      disabled={isLoading || !text.trim()}
                      className={`
                          w-full h-14 rounded-xl font-bold text-lg shadow-lg transition-all duration-300
                          flex items-center justify-center space-x-2
                          ${isLoading
                          ? 'bg-slate-800 text-slate-500 cursor-wait border border-slate-700'
                          : 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-indigo-500/25 hover:shadow-indigo-500/40 transform hover:-translate-y-1 hover:scale-[1.01] active:scale-[0.98]'}
                        `}
                    >
                      {isLoading ? (
                        <>
                          <svg className="animate-spin h-5 w-5 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <span>Generating...</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                          </svg>
                          <span>{hasGeneratedAudio ? "Regenerate Audio" : "Generate Audio"}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={stopAudio}
                      className="w-full h-14 rounded-xl font-bold text-lg bg-red-500/10 text-red-500 border border-red-500/50 hover:bg-red-500/20 transition-all flex items-center justify-center space-x-2 transform hover:-translate-y-1 active:scale-[0.98]"
                    >
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                      </svg>
                      <span>Stop Playback</span>
                    </button>
                  )}
                </div>

                {/* Secondary Actions */}
                <div className="flex space-x-3">
                  <button
                    onClick={handleReplay}
                    disabled={!currentBlobUrl || isLoading || isPlaying}
                    className="h-14 w-14 flex items-center justify-center rounded-xl bg-slate-800 border border-slate-700 text-indigo-400 hover:bg-slate-700 hover:border-slate-600 hover:text-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-110 active:scale-95"
                    title="Replay"
                  >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>

                  <button
                    onClick={handleDownload}
                    disabled={!currentBlobUrl || isLoading}
                    className="h-14 w-14 flex items-center justify-center rounded-xl bg-slate-800 border border-slate-700 text-emerald-400 hover:bg-slate-700 hover:border-slate-600 hover:text-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:scale-110 active:scale-95"
                    title="Download Audio"
                  >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </button>
                </div>

              </div>

              {error && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start text-red-300 text-sm animate-enter">
                  <svg className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

            </div>
          </div>

        </div>

      </main>

      {/* Footer */}
      <footer className="py-6 text-center text-slate-600 text-xs relative z-10 animate-enter delay-300">
        <p>Powered by Google Gemini 2.5 • High Fidelity TTS</p>
      </footer>

    </div>
  );
};

export default App;