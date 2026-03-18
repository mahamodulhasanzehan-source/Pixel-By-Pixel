import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UploadCloud, File as FileIcon, X, CheckCircle, AlertCircle, RefreshCw, QrCode, Download, ArrowRight, Smartphone, Edit2, Clock } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useWebRTC, FileInfo, FileProgress } from './hooks/useWebRTC';
import { QRScanner } from './components/QRScanner';

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const Doodles = () => (
  <svg className="fixed inset-0 z-[-1] w-full h-full opacity-[0.05] pointer-events-none" xmlns="http://www.w3.org/2000/svg">
    <pattern id="doodles" x="0" y="0" width="120" height="120" patternUnits="userSpaceOnUse">
      {/* Cross */}
      <path d="M 15 15 L 25 25 M 25 15 L 15 25" stroke="white" strokeWidth="2" strokeLinecap="round"/>
      {/* Circle */}
      <circle cx="60" cy="20" r="4" fill="none" stroke="white" strokeWidth="2"/>
      {/* Squiggle */}
      <path d="M 90 15 Q 100 5 110 15 T 130 15" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"/>
      {/* Square */}
      <rect x="20" y="70" width="10" height="10" fill="none" stroke="white" strokeWidth="2" transform="rotate(15 25 75)"/>
      {/* Arc */}
      <path d="M 50 90 C 60 80 80 80 90 90" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"/>
      {/* Dots */}
      <circle cx="100" cy="70" r="2" fill="white"/>
      <circle cx="40" cy="50" r="2" fill="white"/>
      <circle cx="80" cy="40" r="1.5" fill="white"/>
      {/* Triangle */}
      <polygon points="10,50 15,40 20,50" fill="none" stroke="white" strokeWidth="2" strokeLinejoin="round"/>
      {/* Plus */}
      <path d="M 100 100 L 100 110 M 95 105 L 105 105" stroke="white" strokeWidth="2" strokeLinecap="round"/>
    </pattern>
    <rect x="0" y="0" width="100%" height="100%" fill="url(#doodles)" />
  </svg>
);

export default function App() {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [receiveCode, setReceiveCode] = useState('');
  const [mode, setMode] = useState<'send' | 'receive'>('send');
  const [showScanner, setShowScanner] = useState(false);
  const [timeLeft, setTimeLeft] = useState(600);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const {
    state,
    code,
    filesInfo,
    progress,
    error,
    speed,
    isSender,
    startSession,
    joinSession,
    acceptTransfer,
    cancelTransfer,
    receivedFiles,
  } = useWebRTC();

  const resetAll = useCallback(() => {
    cancelTransfer(false);
    setSelectedFiles([]);
    setReceiveCode('');
  }, [cancelTransfer]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('code');
    if (urlCode && urlCode.length === 6) {
      setMode('receive');
      setReceiveCode(urlCode);
      joinSession(urlCode);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [joinSession]);

  useEffect(() => {
    if (state === 'waiting') {
      setTimeLeft(600);
      const interval = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            clearInterval(interval);
            resetAll();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [state, resetAll]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const newFiles = Array.from(e.dataTransfer.files);
      setSelectedFiles(prev => [...prev, ...newFiles]);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files);
      setSelectedFiles(prev => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);
  const totalTransferred = (Object.values(progress) as FileProgress[]).reduce((acc, p) => acc + p.bytesTransferred, 0);
  const totalBytesToTransfer = filesInfo.reduce((acc, f) => acc + f.size, 0);
  const overallProgress = totalBytesToTransfer > 0 ? (totalTransferred / totalBytesToTransfer) * 100 : 0;
  const timeRemaining = speed > 0 ? (totalBytesToTransfer - totalTransferred) / speed : 0;

  const handleSend = () => {
    if (selectedFiles.length > 0) {
      startSession(selectedFiles);
    }
  };

  const handleReceive = (e: React.FormEvent) => {
    e.preventDefault();
    if (receiveCode.length === 6) {
      joinSession(receiveCode);
    }
  };

  const handleScan = (scannedCode: string) => {
    setShowScanner(false);
    setReceiveCode(scannedCode);
    joinSession(scannedCode);
  };

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const handleSaveToFolders = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
        acceptTransfer(handle, false);
      } catch (err) {
        console.error('Directory selection cancelled or failed:', err);
      }
    } else {
      // Fallback for browsers without showDirectoryPicker
      acceptTransfer(undefined, false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-blue-500/30 relative overflow-x-hidden">
      <Doodles />
      
      {showScanner && (
        <QRScanner
          onScan={handleScan}
          onClose={() => setShowScanner(false)}
        />
      )}
      
      <header className="border-b border-slate-800/50 bg-slate-950/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={resetAll}>
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shadow-[0_0_15px_rgba(37,99,235,0.5)]">
              <UploadCloud className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold text-lg tracking-tight">Pixel by Pixel</span>
          </div>
          
          {state === 'idle' && (
            <div className="flex bg-slate-900 rounded-full p-1 border border-slate-800">
              <button
                onClick={() => setMode('send')}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                  mode === 'send' 
                    ? 'bg-slate-800 text-white shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Send
              </button>
              <button
                onClick={() => setMode('receive')}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                  mode === 'receive' 
                    ? 'bg-slate-800 text-white shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Receive
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mb-8 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 text-red-400"
            >
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-medium text-red-300">Transfer Error</h3>
                <p className="text-sm mt-1">{error}</p>
              </div>
              <button onClick={resetAll} className="p-1 hover:bg-red-500/20 rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          )}

          {state === 'idle' && mode === 'send' && (
            <motion.div
              key="send-setup"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="grid md:grid-cols-[1fr_380px] gap-8"
            >
              <div className="space-y-6">
                <div>
                  <h1 className="text-4xl font-semibold tracking-tight mb-2">Send Files Securely</h1>
                  <p className="text-slate-400 text-lg">Fast, peer-to-peer transfer directly from your browser.</p>
                </div>

                <div
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                  className={`
                    relative border-2 border-dashed rounded-3xl p-12 text-center transition-all duration-200 ease-out
                    flex flex-col items-center justify-center min-h-[320px]
                    ${dragActive 
                      ? 'border-blue-500 bg-blue-500/5 scale-[1.02]' 
                      : 'border-slate-800 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900'}
                  `}
                >
                  <div className="w-16 h-16 mb-6 rounded-2xl bg-slate-800 flex items-center justify-center shadow-inner">
                    <UploadCloud className={`w-8 h-8 ${dragActive ? 'text-blue-400' : 'text-slate-400'}`} />
                  </div>
                  <h3 className="text-xl font-medium mb-2">Drag & drop files here</h3>
                  <p className="text-slate-400 mb-8">or use the buttons below to browse</p>
                  
                  <div className="flex flex-wrap justify-center gap-4">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                    >
                      <FileIcon className="w-4 h-4" />
                      Select Files
                    </button>
                    <button
                      onClick={() => folderInputRef.current?.click()}
                      className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                    >
                      <UploadCloud className="w-4 h-4" />
                      Select Folder
                    </button>
                  </div>
                  
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                  />
                  <input
                    type="file"
                    // @ts-ignore - webkitdirectory is non-standard but widely supported
                    webkitdirectory="true"
                    directory="true"
                    multiple
                    className="hidden"
                    ref={folderInputRef}
                    onChange={handleFileChange}
                  />
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col h-[500px]">
                <h3 className="font-medium text-lg mb-4 flex items-center justify-between">
                  <span>Selected Files</span>
                  <span className="text-sm font-normal text-slate-400 bg-slate-800 px-2 py-0.5 rounded-full">
                    {selectedFiles.length}
                  </span>
                </h3>
                
                <div className="flex-1 overflow-y-auto pr-2 space-y-2 custom-scrollbar">
                  {selectedFiles.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-500 space-y-3">
                      <FileIcon className="w-10 h-10 opacity-20" />
                      <p className="text-sm">No files selected yet</p>
                    </div>
                  ) : (
                    selectedFiles.map((file, idx) => (
                      <div key={idx} className="flex items-center gap-3 p-3 bg-slate-950 rounded-xl border border-slate-800/50 group">
                        <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">
                          <FileIcon className="w-5 h-5 text-slate-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{file.name}</p>
                          <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
                        </div>
                        <button
                          onClick={() => removeFile(idx)}
                          className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {selectedFiles.length > 0 && (
                  <div className="pt-6 mt-4 border-t border-slate-800">
                    <div className="flex justify-between items-center mb-4 text-sm">
                      <span className="text-slate-400">Total Size</span>
                      <span className="font-medium">{formatBytes(totalSize)}</span>
                    </div>
                    <button
                      onClick={handleSend}
                      className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-all shadow-[0_0_20px_rgba(37,99,235,0.3)] hover:shadow-[0_0_25px_rgba(37,99,235,0.5)] flex items-center justify-center gap-2"
                    >
                      Generate Code <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {state === 'idle' && mode === 'receive' && (
            <motion.div
              key="receive-setup"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-md mx-auto mt-12"
            >
              <div className="text-center mb-10">
                <div className="w-20 h-20 mx-auto bg-blue-500/10 rounded-full flex items-center justify-center mb-6">
                  <Download className="w-10 h-10 text-blue-400" />
                </div>
                <h1 className="text-3xl font-semibold tracking-tight mb-3">Receive Files</h1>
                <p className="text-slate-400">Enter the 6-digit code from the sender device to start downloading.</p>
              </div>

              <form onSubmit={handleReceive} className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
                <div className="mb-8">
                  <label className="block text-sm font-medium text-slate-400 mb-3 text-center uppercase tracking-wider">
                    Input Transfer Code
                  </label>
                  <input
                    type="text"
                    maxLength={6}
                    value={receiveCode}
                    onChange={(e) => setReceiveCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full bg-slate-950 border-2 border-slate-800 focus:border-blue-500 rounded-2xl px-6 py-5 text-center text-4xl font-mono tracking-[0.5em] text-white outline-none transition-colors placeholder:text-slate-700"
                    placeholder="000000"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={receiveCode.length !== 6}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                >
                  Connect & Download
                </button>
                
                <div className="mt-6 pt-6 border-t border-slate-800 text-center">
                  <p className="text-sm text-slate-500 mb-4">Or scan QR code with your mobile device</p>
                  <button 
                    type="button" 
                    onClick={() => setShowScanner(true)}
                    className="inline-flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
                  >
                    <Smartphone className="w-4 h-4" />
                    Open Camera Scanner
                  </button>
                </div>
              </form>
            </motion.div>
          )}

          {state === 'confirming' && (
            <motion.div
              key="confirming"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-md mx-auto mt-12"
            >
              <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl text-center">
                <div className="w-16 h-16 mx-auto bg-blue-500/10 rounded-full flex items-center justify-center mb-6">
                  <Download className="w-8 h-8 text-blue-400" />
                </div>
                <h2 className="text-2xl font-semibold mb-2">Incoming Transfer</h2>
                <p className="text-slate-400 mb-8">
                  {filesInfo.length} files ({formatBytes(totalBytesToTransfer)})
                </p>

                <div className="space-y-4">
                  {isMobile ? (
                    <button
                      onClick={() => acceptTransfer()}
                      className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-all"
                    >
                      Accept Transfer
                    </button>
                  ) : (
                    <button
                      onClick={handleSaveToFolders}
                      className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-all"
                    >
                      {'showDirectoryPicker' in window ? 'Select Folder to Save' : 'Download Files'}
                    </button>
                  )}
                  
                  <button
                    onClick={resetAll}
                    className="w-full py-4 bg-transparent hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl font-medium transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {state === 'waiting' && (
            <motion.div
              key="waiting"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-3xl mx-auto text-center mt-8"
            >
              <h2 className="text-2xl font-medium mb-2">Ready to Send</h2>
              <p className="text-slate-400 mb-8">Share this code or QR with the receiving device.</p>

              <div className="grid md:grid-cols-2 gap-8 bg-slate-900 border border-slate-800 rounded-3xl p-8 md:p-12 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-slate-800">
                  <motion.div 
                    className="h-full bg-blue-500"
                    initial={{ width: '100%' }}
                    animate={{ width: `${(timeLeft / 600) * 100}%` }}
                    transition={{ ease: "linear", duration: 1 }}
                  />
                </div>
                
                <div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-slate-800 pb-8 md:pb-0 md:pr-8">
                  <p className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-4">Transfer Code</p>
                  <div className="text-6xl font-mono tracking-widest text-blue-400 font-bold bg-blue-500/10 px-6 py-4 rounded-2xl border border-blue-500/20">
                    {code}
                  </div>
                  <p className="text-sm text-slate-500 mt-6 flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Waiting for receiver to connect...
                  </p>
                  <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Expires in {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
                  </p>
                </div>
                
                <div className="flex flex-col items-center justify-center pt-8 md:pt-0 md:pl-8">
                  <p className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-4">Scan QR Code</p>
                  <div className="bg-white p-4 rounded-2xl shadow-lg">
                    <QRCodeSVG 
                      value={`${window.location.origin}?code=${code}`} 
                      size={180}
                      level="H"
                      includeMargin={false}
                      fgColor="#000000"
                      bgColor="#FFFFFF"
                    />
                  </div>
                </div>
              </div>
              
              <div className="flex justify-center gap-4 mt-8">
                <button
                  onClick={() => cancelTransfer(true)}
                  className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-medium transition-colors flex items-center gap-2"
                >
                  <Edit2 className="w-4 h-4" />
                  Edit Files
                </button>
                <button
                  onClick={resetAll}
                  className="px-6 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl font-medium transition-colors flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Cancel Transfer
                </button>
              </div>
            </motion.div>
          )}

          {(state === 'connecting' || state === 'transferring' || state === 'completed') && (
            <motion.div
              key="transfer"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="max-w-3xl mx-auto mt-8"
            >
              <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="text-2xl font-semibold flex items-center gap-3">
                      {state === 'connecting' && <><RefreshCw className="w-6 h-6 animate-spin text-blue-400" /> Connecting...</>}
                      {state === 'transferring' && <><ArrowRight className="w-6 h-6 text-blue-400" /> Transferring Files</>}
                      {state === 'completed' && <><CheckCircle className="w-6 h-6 text-emerald-400" /> Transfer Complete</>}
                    </h2>
                    <p className="text-slate-400 mt-1">
                      {isSender ? 'Sending to receiver' : 'Receiving from sender'}
                    </p>
                  </div>
                  
                  {state === 'transferring' && (
                    <div className="text-right">
                      <div className="text-xl font-mono text-blue-400">{formatBytes(speed)}/s</div>
                      <div className="text-sm text-slate-500">~{formatTime(timeRemaining)} remaining</div>
                    </div>
                  )}
                </div>

                {/* Overall Progress */}
                <div className="mb-10">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="font-medium text-slate-300">Total Progress</span>
                    <span className="font-mono text-slate-400">
                      {formatBytes(totalTransferred)} / {formatBytes(totalBytesToTransfer)}
                    </span>
                  </div>
                  <div className="h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                    <motion.div 
                      className={`h-full ${state === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${overallProgress}%` }}
                      transition={{ ease: "linear", duration: 0.5 }}
                    />
                  </div>
                </div>

                {/* File List */}
                <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {filesInfo.map((file) => {
                    const fileProg = progress[file.id];
                    const percent = fileProg ? (fileProg.bytesTransferred / fileProg.totalBytes) * 100 : 0;
                    const isDone = fileProg?.completed;

                    return (
                      <div key={file.id} className="bg-slate-950 rounded-xl p-4 border border-slate-800/50">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3 min-w-0">
                            <FileIcon className={`w-5 h-5 shrink-0 ${isDone ? 'text-emerald-400' : 'text-slate-400'}`} />
                            <p className="text-sm font-medium truncate">{file.name}</p>
                          </div>
                          <span className="text-xs font-mono text-slate-500 shrink-0 ml-4">
                            {fileProg ? formatBytes(fileProg.bytesTransferred) : '0 B'} / {formatBytes(file.size)}
                          </span>
                        </div>
                        <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                          <motion.div 
                            className={`h-full ${isDone ? 'bg-emerald-500' : 'bg-blue-500/80'}`}
                            initial={{ width: 0 }}
                            animate={{ width: `${percent}%` }}
                            transition={{ ease: "linear", duration: 0.2 }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {state === 'completed' && !isSender && receivedFiles.length > 0 && (
                  <div className="mt-8 space-y-4">
                    {isMobile && (
                      <button
                        onClick={async () => {
                          const files = receivedFiles.map(rf => new File([rf.blob], rf.info.name, { type: rf.info.type }));
                          if (navigator.canShare && navigator.canShare({ files })) {
                            try {
                              await navigator.share({ files, title: 'Saved from Pixel by Pixel' });
                            } catch (e) {
                              console.error('Share failed', e);
                            }
                          } else {
                            // Fallback to sharing one by one if batch fails
                            for (const file of files) {
                              if (navigator.canShare && navigator.canShare({ files: [file] })) {
                                try {
                                  await navigator.share({ files: [file] });
                                } catch (e) {
                                  console.error('Share failed for', file.name, e);
                                }
                              }
                            }
                          }
                        }}
                        className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.3)] hover:shadow-[0_0_25px_rgba(37,99,235,0.5)]"
                      >
                        <Download className="w-5 h-5" />
                        Save to Photos
                      </button>
                    )}
                    <button
                      onClick={() => {
                        receivedFiles.forEach(rf => {
                          const url = URL.createObjectURL(rf.blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = rf.info.name;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        });
                      }}
                      className={`w-full py-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 ${
                        isMobile 
                          ? 'bg-slate-800 hover:bg-slate-700 text-white' 
                          : 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]'
                      }`}
                    >
                      <FileIcon className="w-5 h-5" />
                      Save to Files
                    </button>
                  </div>
                )}

                <div className="mt-8 pt-6 border-t border-slate-800 text-center">
                  <button
                    onClick={resetAll}
                    className={`px-8 py-3 rounded-xl font-medium transition-colors ${
                      state === 'completed'
                        ? 'bg-transparent hover:bg-slate-800 text-slate-400 hover:text-white'
                        : 'bg-slate-800 hover:bg-slate-700 text-white'
                    }`}
                  >
                    {state === 'completed' ? 'Start New Transfer' : 'Cancel Transfer'}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Custom Scrollbar Styles */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: #334155;
          border-radius: 20px;
        }
      `}} />
    </div>
  );
}
