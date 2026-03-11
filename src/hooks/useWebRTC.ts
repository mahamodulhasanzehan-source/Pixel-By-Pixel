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

export function useWebRTC() {
  const [state, setState] = useState<TransferState>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [filesInfo, setFilesInfo] = useState<FileInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, FileProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(0);
  const [isSender, setIsSender] = useState<boolean>(false);

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

  const directoryHandleRef = useRef<any>(null);
  const useShareRef = useRef<boolean>(false);

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
      if (typeof data === 'object' && data.type) {
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
          currentReceivingFileRef.current = data.file;
          receiveBufferRef.current = [];
          receivedSizeRef.current = 0;
          
          if (directoryHandleRef.current) {
            writeQueueRef.current = writeQueueRef.current.then(async () => {
              try {
                const fileHandle = await directoryHandleRef.current.getFileHandle(data.file.name, { create: true });
                fileWritableRef.current = await fileHandle.createWritable();
              } catch (e) {
                console.error('Failed to create writable:', e);
                fileWritableRef.current = null;
              }
            });
          }
        } else if (data.type === 'eof') {
          if (directoryHandleRef.current) {
            writeQueueRef.current = writeQueueRef.current.then(async () => {
              if (fileWritableRef.current) {
                try {
                  await fileWritableRef.current.close();
                } catch (e) {
                  console.error('Error closing writable:', e);
                }
                fileWritableRef.current = null;
                await finishFileReceive();
              } else {
                await saveReceivedFileMemory();
              }
            });
          } else {
            saveReceivedFileMemory();
          }
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
      } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        // Binary chunk
        handleReceiveMessage(data as ArrayBuffer);
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

  const acceptTransfer = async (handle?: any, useShare?: boolean) => {
    directoryHandleRef.current = handle || null;
    useShareRef.current = useShare || false;
    
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
        if (dataChannel && dataChannel.bufferedAmount > 1024 * 1024 * 8) { // 8MB buffer limit
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }

        const chunk = file.slice(offset, offset + chunkSize);
        const buffer = await chunk.arrayBuffer();
        connRef.current.send(buffer);

        offset += buffer.byteLength;

        setProgress(prev => ({
          ...prev,
          [fileInfo.id]: {
            ...prev[fileInfo.id],
            bytesTransferred: offset,
          }
        }));

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

  const handleReceiveMessage = (data: ArrayBuffer) => {
    if (currentReceivingFileRef.current) {
      if (directoryHandleRef.current) {
        writeQueueRef.current = writeQueueRef.current.then(async () => {
          if (fileWritableRef.current) {
            try {
              await fileWritableRef.current.write(data);
            } catch (e) {
              console.error('Write error:', e);
            }
          } else {
            receiveBufferRef.current.push(data);
          }
        });
      } else {
        receiveBufferRef.current.push(data);
      }
      
      receivedSizeRef.current += data.byteLength;
      totalBytesTransferredRef.current += data.byteLength;

      const fileId = currentReceivingFileRef.current.id;
      setProgress(prev => ({
        ...prev,
        [fileId]: {
          ...prev[fileId],
          bytesTransferred: receivedSizeRef.current,
        }
      }));

      updateSpeed(totalBytesTransferredRef.current);
    }
  };

  const fallbackDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const finishFileReceive = async () => {
    if (!currentReceivingFileRef.current) return;
    const fileInfo = currentReceivingFileRef.current;

    setProgress(prev => ({
      ...prev,
      [fileInfo.id]: {
        ...prev[fileInfo.id],
        completed: true,
      }
    }));

    setProgress(prev => {
      const allCompleted = (Object.values(prev) as FileProgress[]).every(p => p.completed);
      if (allCompleted) {
        setState('completed');
      }
      return prev;
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
      
      if (useShareRef.current && navigator.share) {
        try {
          const file = new File([blob], fileInfo.name, { type: fileInfo.type });
          await navigator.share({
            files: [file],
            title: fileInfo.name,
          });
        } catch (e) {
          console.error('Error sharing:', e);
          fallbackDownload(blob, fileInfo.name);
        }
      } else {
        fallbackDownload(blob, fileInfo.name);
      }
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
  };
}
