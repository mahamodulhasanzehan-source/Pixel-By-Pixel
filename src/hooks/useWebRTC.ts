import { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';

export type TransferState = 'idle' | 'creating' | 'waiting' | 'confirming' | 'connecting' | 'transferring' | 'completed' | 'error';

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface FileProgress {
  id: string;
  bytesTransferred: number;
  totalBytes: number;
  completed: boolean;
}

const clearOPFS = async () => {
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      const root = await navigator.storage.getDirectory();
      // @ts-ignore
      for await (const [name, handle] of root.entries()) {
        if (handle.kind === 'file') {
          await root.removeEntry(name).catch(e => console.warn('Failed to remove OPFS file:', e));
        }
      }
    }
  } catch (e) {
    console.warn('Failed to clear OPFS:', e);
  }
};

export function useWebRTC() {
  const [state, setState] = useState<TransferState>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [filesInfo, setFilesInfo] = useState<FileInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, FileProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(0);
  const [isSender, setIsSender] = useState<boolean>(false);
  const [receivedFiles, setReceivedFiles] = useState<{info: FileInfo, blob: Blob}[]>([]);

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef<number>(0);
  const currentReceivingFileRef = useRef<FileInfo | null>(null);
  const lastSpeedCalcRef = useRef<{ time: number; bytes: number }>({ time: 0, bytes: 0 });
  const totalBytesTransferredRef = useRef<number>(0);
  const fileAckRef = useRef<string | null>(null);
  const fileWritableRef = useRef<any>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastProgressUpdateRef = useRef<number>(0);

  const directoryHandleRef = useRef<any>(null);
  const opfsRootRef = useRef<any>(null);
  const currentFileHandleRef = useRef<any>(null);

  const cleanupConnection = useCallback(() => {
    if (connRef.current) {
      connRef.current.close();
      connRef.current = null;
    }
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Clean up any leftover OPFS files from previous sessions
    clearOPFS();
    
    return () => {
      cleanupConnection();
    };
  }, [cleanupConnection]);

  const setupConnection = (conn: DataConnection, isSenderSide: boolean) => {
    connRef.current = conn;

    conn.on('open', () => {
      console.log('Data connection open');
      if (isSenderSide) {
        // Sender sends file info when receiver connects
        conn.send({
          type: 'files-info',
          filesInfo: filesInfoRef.current,
        });
      }
    });

    conn.on('data', (data: any) => {
      const knownTypes = ['files-info', 'receiver-ready', 'header', 'eof', 'file-saved', 'cancel', 'graceful-close'];
      if (typeof data === 'object' && data !== null && knownTypes.includes(data.type)) {
        if (data.type === 'files-info' && !isSenderSide) {
          setFilesInfo(data.filesInfo);
          const initialProgress: Record<string, FileProgress> = {};
          data.filesInfo.forEach((f: FileInfo) => {
            initialProgress[f.id] = { id: f.id, bytesTransferred: 0, totalBytes: f.size, completed: false };
          });
          setProgress(initialProgress);
          setState('confirming');
        } else if (data.type === 'receiver-ready' && isSenderSide) {
          setState('transferring');
          startSendingFiles();
        } else if (data.type === 'header') {
          writeQueueRef.current = writeQueueRef.current.then(async () => {
            currentReceivingFileRef.current = data.file;
            receiveBufferRef.current = [];
            receivedSizeRef.current = 0;
            
            if (directoryHandleRef.current || opfsRootRef.current) {
              try {
                let fileHandle;
                if (directoryHandleRef.current) {
                  fileHandle = await directoryHandleRef.current.getFileHandle(data.file.name, { create: true });
                } else {
                  fileHandle = await opfsRootRef.current.getFileHandle(data.file.name, { create: true });
                  currentFileHandleRef.current = fileHandle;
                }
                
                if (fileHandle.createWritable) {
                  fileWritableRef.current = await fileHandle.createWritable();
                } else {
                  fileWritableRef.current = null;
                  currentFileHandleRef.current = null;
                }
              } catch (e) {
                console.error('Failed to create writable:', e);
                fileWritableRef.current = null;
                currentFileHandleRef.current = null;
              }
            }
          });
        } else if (data.type === 'eof') {
          writeQueueRef.current = writeQueueRef.current.then(async () => {
            if (directoryHandleRef.current || opfsRootRef.current) {
              if (fileWritableRef.current) {
                try {
                  await fileWritableRef.current.close();
                } catch (e) {
                  console.error('Error closing writable:', e);
                }
                fileWritableRef.current = null;
                
                if (directoryHandleRef.current) {
                  await finishFileReceive();
                } else if (opfsRootRef.current && currentFileHandleRef.current) {
                  try {
                    const file = await currentFileHandleRef.current.getFile();
                    setReceivedFiles(prev => [...prev, { info: currentReceivingFileRef.current!, blob: file }]);
                  } catch (e) {
                    console.error('Error getting file from OPFS:', e);
                  }
                  currentFileHandleRef.current = null;
                  await finishFileReceive();
                }
              } else {
                await saveReceivedFileMemory();
              }
            } else {
              await saveReceivedFileMemory();
            }
          });
        } else if (data.type === 'file-saved') {
          fileAckRef.current = data.fileId;
        } else if (data.type === 'cancel') {
          setError('Transfer cancelled by the other party');
          setState('error');
          cleanupConnection();
        } else if (data.type === 'graceful-close') {
          cleanupConnection();
          setState('idle');
          setCode(null);
          setFiles([]);
          setFilesInfo([]);
          setProgress({});
          setSpeed(0);
        }
      } else {
        // Binary chunk (ArrayBuffer, Uint8Array, Blob, etc)
        writeQueueRef.current = writeQueueRef.current.then(async () => {
          const byteLength = data.byteLength || data.size || data.length || 0;
          if (currentReceivingFileRef.current) {
            if (directoryHandleRef.current || opfsRootRef.current) {
              if (fileWritableRef.current) {
                try {
                  await fileWritableRef.current.write(data);
                } catch (e) {
                  console.error('Write error:', e);
                }
              } else {
                receiveBufferRef.current.push(data instanceof Blob ? data : new Blob([data]));
              }
            } else {
              receiveBufferRef.current.push(data instanceof Blob ? data : new Blob([data]));
            }
            
            receivedSizeRef.current += byteLength;
            totalBytesTransferredRef.current += byteLength;

            const fileId = currentReceivingFileRef.current.id;
            const now = Date.now();
            
            if (now - lastProgressUpdateRef.current > 100 || receivedSizeRef.current >= currentReceivingFileRef.current.size) {
              setProgress(prev => ({
                ...prev,
                [fileId]: {
                  ...prev[fileId],
                  bytesTransferred: receivedSizeRef.current,
                }
              }));
              lastProgressUpdateRef.current = now;
            }

            updateSpeed(totalBytesTransferredRef.current);
          }
        });
      }
    });

    conn.on('close', () => {
      console.log('Connection closed');
      if (stateRef.current !== 'completed' && stateRef.current !== 'idle' && stateRef.current !== 'error') {
        setError('Connection lost');
        setState('error');
      }
    });

    conn.on('error', (err) => {
      console.error('Connection error:', err);
      setError('Connection error occurred');
      setState('error');
    });
  };

  // Refs to access latest state in callbacks
  const stateRef = useRef(state);
  const filesInfoRef = useRef(filesInfo);
  const filesRef = useRef(files);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { filesInfoRef.current = filesInfo; }, [filesInfo]);
  useEffect(() => { filesRef.current = files; }, [files]);

  useEffect(() => {
    if (state === 'transferring' && !isSender) {
      const p = Object.values(progress) as FileProgress[];
      if (p.length > 0 && p.every(f => f.completed)) {
        setState('completed');
      }
    }
  }, [progress, state, isSender]);

  const startSession = (selectedFiles: File[]) => {
    cleanupConnection();
    setIsSender(true);
    setFiles(selectedFiles);
    setState('creating');
    totalBytesTransferredRef.current = 0;
    lastSpeedCalcRef.current = { time: Date.now(), bytes: 0 };
    fileAckRef.current = null;

    const info = selectedFiles.map((f, i) => ({
      id: `file-${i}`,
      name: f.name,
      size: f.size,
      type: f.type,
    }));
    setFilesInfo(info);

    const initialProgress: Record<string, FileProgress> = {};
    info.forEach(f => {
      initialProgress[f.id] = { id: f.id, bytesTransferred: 0, totalBytes: f.size, completed: false };
    });
    setProgress(initialProgress);

    // Generate 6 digit code
    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    const peerId = `pxl-transfer-${newCode}`;

    const peer = new Peer(peerId);
    peerRef.current = peer;

    peer.on('open', (id) => {
      setCode(newCode);
      setState('waiting');
    });

    peer.on('connection', (conn) => {
      setupConnection(conn, true);
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'unavailable-id') {
        // Try again with a new code
        startSession(selectedFiles);
      } else {
        setError('Failed to create session');
        setState('error');
      }
    });
  };

  const joinSession = (sessionCode: string) => {
    cleanupConnection();
    setIsSender(false);
    setCode(sessionCode);
    setState('connecting');
    totalBytesTransferredRef.current = 0;
    lastSpeedCalcRef.current = { time: Date.now(), bytes: 0 };
    fileAckRef.current = null;

    const peer = new Peer();
    peerRef.current = peer;

    peer.on('open', () => {
      const conn = peer.connect(`pxl-transfer-${sessionCode}`, {
        reliable: true,
      });
      setupConnection(conn, false);
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      setError('Failed to connect to sender');
      setState('error');
    });
  };

  const acceptTransfer = async (handle?: any) => {
    directoryHandleRef.current = handle || null;
    
    if (!handle) {
      try {
        if (navigator.storage && navigator.storage.getDirectory) {
          opfsRootRef.current = await navigator.storage.getDirectory();
        }
      } catch (e) {
        console.warn('OPFS not available, falling back to RAM', e);
      }
    }
    
    if (connRef.current && connRef.current.open) {
      connRef.current.send({ type: 'receiver-ready' });
      setState('transferring');
    } else {
      setError('Connection lost');
      setState('error');
    }
  };

  const startSendingFiles = async () => {
    if (!connRef.current) return;

    for (let i = 0; i < filesRef.current.length; i++) {
      const file = filesRef.current[i];
      const fileInfo = filesInfoRef.current[i];

      connRef.current.send({
        type: 'header',
        file: fileInfo,
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const chunkSize = 128 * 1024; // 128KB chunks for better throughput
      let offset = 0;
      const previousTotal = totalBytesTransferredRef.current;

      while (offset < file.size) {
        if (!connRef.current || !connRef.current.open) {
          throw new Error('Data channel closed during transfer');
        }

        // Implement backpressure to prevent sender from overwhelming the buffer
        // and to show accurate progress.
        const dataChannel = (connRef.current as any).dataChannel;
        if (dataChannel && dataChannel.bufferedAmount > 1024 * 1024 * 2) { // 2MB buffer limit
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }

        const chunk = file.slice(offset, offset + chunkSize);
        const buffer = await chunk.arrayBuffer();
        connRef.current.send(buffer);

        offset += buffer.byteLength;

        const now = Date.now();
        if (now - lastProgressUpdateRef.current > 100 || offset >= file.size) {
          setProgress(prev => ({
            ...prev,
            [fileInfo.id]: {
              ...prev[fileInfo.id],
              bytesTransferred: offset,
            }
          }));
          lastProgressUpdateRef.current = now;
        }

        totalBytesTransferredRef.current = previousTotal + offset;
        updateSpeed(totalBytesTransferredRef.current);
      }

      // Wait for the buffer to drain completely before sending EOF
      // This ensures the receiver has actually received all the bytes before we mark it complete
      const dataChannel = (connRef.current as any).dataChannel;
      // We don't need to wait for bufferedAmount to be 0 here because the EOF message 
      // is sent on the same ordered data channel and will arrive after the data chunks.
      // We rely on the receiver's 'file-saved' ack instead.

      connRef.current.send({ type: 'eof', fileId: fileInfo.id });
      
      setProgress(prev => ({
        ...prev,
        [fileInfo.id]: {
          ...prev[fileInfo.id],
          completed: true,
        }
      }));

      // Wait for receiver to acknowledge the file is saved
      while (fileAckRef.current !== fileInfo.id) {
        if (!connRef.current || !connRef.current.open) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    setState('completed');
  };

  const finishFileReceive = async () => {
    if (!currentReceivingFileRef.current) return;
    const fileInfo = currentReceivingFileRef.current;

    setProgress(prev => {
      return {
        ...prev,
        [fileInfo.id]: {
          ...prev[fileInfo.id],
          bytesTransferred: fileInfo.size,
          completed: true,
        }
      };
    });

    if (connRef.current && connRef.current.open) {
      connRef.current.send({ type: 'file-saved', fileId: fileInfo.id });
    }

    currentReceivingFileRef.current = null;
    receiveBufferRef.current = [];
    receivedSizeRef.current = 0;
  };

  const saveReceivedFileMemory = async () => {
    if (!currentReceivingFileRef.current) return;
    const fileInfo = currentReceivingFileRef.current;

    try {
      const blob = new Blob(receiveBufferRef.current, { type: fileInfo.type });
      receiveBufferRef.current = []; // Clear buffer immediately to free memory
      setReceivedFiles(prev => [...prev, { info: fileInfo, blob }]);
      // Intentionally not auto-downloading here to prevent temporary files.
      // The user will explicitly save it from the UI after transfer completes.
    } catch (e) {
      console.error('Error creating blob or downloading:', e);
    }

    await finishFileReceive();
  };

  const updateSpeed = (currentBytes: number) => {
    const now = Date.now();
    const { time: lastTime, bytes: lastBytes } = lastSpeedCalcRef.current;
    
    if (now - lastTime > 500) {
      const speedBps = ((currentBytes - lastBytes) / (now - lastTime)) * 1000;
      setSpeed(speedBps);
      lastSpeedCalcRef.current = { time: now, bytes: currentBytes };
    }
  };

  const cancelTransfer = useCallback((keepFiles = false) => {
    if (connRef.current && connRef.current.open) {
      if (stateRef.current === 'completed') {
        connRef.current.send({ type: 'graceful-close' });
      } else {
        connRef.current.send({ type: 'cancel' });
      }
    }
    cleanupConnection();
    setState('idle');
    setCode(null);
    if (!keepFiles) {
      setFiles([]);
      setFilesInfo([]);
      setReceivedFiles([]);
      clearOPFS();
    }
    setProgress({});
    setError(null);
    setSpeed(0);
    totalBytesTransferredRef.current = 0;
    lastSpeedCalcRef.current = { time: Date.now(), bytes: 0 };
    fileAckRef.current = null;
  }, [cleanupConnection]);

  return {
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
  };
}
