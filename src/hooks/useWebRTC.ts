import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

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

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef<number>(0);
  const currentReceivingFileRef = useRef<FileInfo | null>(null);
  const lastSpeedCalcRef = useRef<{ time: number; bytes: number }>({ time: 0, bytes: 0 });

  const directoryHandleRef = useRef<any>(null);
  const useShareRef = useRef<boolean>(false);
  const readyToSendRef = useRef<boolean>(false);

  useEffect(() => {
    // Use VITE_WS_URL if provided (e.g., for Vercel deployment), else fallback to origin
    const socketUrl = import.meta.env.VITE_WS_URL || window.location.origin;
    socketRef.current = io(socketUrl);

    socketRef.current.on('connect', () => {
      console.log('Connected to signaling server');
    });

    socketRef.current.on('receiver-joined', async ({ receiverId }) => {
      console.log('Receiver joined, initiating WebRTC connection');
      setState('connecting');
      await initiateConnection(receiverId);
    });

    socketRef.current.on('webrtc-offer', async ({ sender, offer }) => {
      console.log('Received WebRTC offer');
      await handleOffer(sender, offer);
    });

    socketRef.current.on('webrtc-answer', async ({ sender, answer }) => {
      console.log('Received WebRTC answer');
      await handleAnswer(answer);
    });

    socketRef.current.on('webrtc-ice-candidate', async ({ sender, candidate }) => {
      console.log('Received ICE candidate');
      await handleIceCandidate(candidate);
    });

    socketRef.current.on('session-closed', () => {
      if (state !== 'completed' && state !== 'idle') {
        setError('Session closed by the other party');
        setState('error');
      }
    });

    return () => {
      socketRef.current?.disconnect();
      cleanupConnection();
    };
  }, []);

  const cleanupConnection = useCallback(() => {
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    readyToSendRef.current = false;
  }, []);

  const createPeerConnection = (targetId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('webrtc-ice-candidate', {
          target: targetId,
          candidate: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        console.log('WebRTC connection failed, falling back to socket relay');
        setError('Connection lost. Please try again.');
        setState('error');
      }
    };

    return pc;
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.log('Data channel open');
      if (!isSender && readyToSendRef.current) {
        channel.send(JSON.stringify({ type: 'receiver-ready' }));
        setState('transferring');
      }
    };

    channel.onclose = () => {
      console.log('Data channel closed');
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'receiver-ready' && isSender) {
            setState('transferring');
            startSendingFiles();
          } else if (message.type === 'header') {
            currentReceivingFileRef.current = message.file;
            receiveBufferRef.current = [];
            receivedSizeRef.current = 0;
          } else if (message.type === 'eof') {
            saveReceivedFile();
          }
        } catch (e) {
          console.error('Error parsing message:', e);
        }
      } else {
        // Binary chunk
        handleReceiveMessage(event.data);
      }
    };

    dataChannelRef.current = channel;
  };

  const initiateConnection = async (targetId: string) => {
    try {
      const pc = createPeerConnection(targetId);
      peerConnectionRef.current = pc;

      const channel = pc.createDataChannel('file-transfer', {
        ordered: true,
      });
      setupDataChannel(channel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current?.emit('webrtc-offer', {
        target: targetId,
        offer,
      });
    } catch (err) {
      console.error('Error initiating connection:', err);
      setError('Failed to initiate connection');
      setState('error');
    }
  };

  const handleOffer = async (senderId: string, offer: any) => {
    try {
      const pc = createPeerConnection(senderId);
      peerConnectionRef.current = pc;

      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current?.emit('webrtc-answer', {
        target: senderId,
        answer,
      });
    } catch (err) {
      console.error('Error handling offer:', err);
      setError('Failed to establish connection');
      setState('error');
    }
  };

  const handleAnswer = async (answer: any) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch (err) {
      console.error('Error handling answer:', err);
    }
  };

  const handleIceCandidate = async (candidate: any) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  };

  const startSession = (selectedFiles: File[]) => {
    setIsSender(true);
    setFiles(selectedFiles);
    setState('creating');

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

    socketRef.current?.emit('create-session', { filesInfo: info }, (response: any) => {
      if (response.code) {
        setCode(response.code);
        setState('waiting');
      } else {
        setError('Failed to create session');
        setState('error');
      }
    });
  };

  const joinSession = (sessionCode: string) => {
    setIsSender(false);
    setCode(sessionCode);
    setState('confirming');

    socketRef.current?.emit('join-session', sessionCode, (response: any) => {
      if (response.success) {
        setFilesInfo(response.filesInfo);
        const initialProgress: Record<string, FileProgress> = {};
        response.filesInfo.forEach((f: FileInfo) => {
          initialProgress[f.id] = { id: f.id, bytesTransferred: 0, totalBytes: f.size, completed: false };
        });
        setProgress(initialProgress);
      } else {
        setError(response.error || 'Failed to join session');
        setState('error');
      }
    });
  };

  const acceptTransfer = async (handle?: any, useShare?: boolean) => {
    directoryHandleRef.current = handle || null;
    useShareRef.current = useShare || false;
    readyToSendRef.current = true;
    
    if (dataChannelRef.current?.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify({ type: 'receiver-ready' }));
      setState('transferring');
    } else {
      setState('connecting');
    }
  };

  const startSendingFiles = async () => {
    if (!dataChannelRef.current) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileInfo = filesInfo[i];

      dataChannelRef.current.send(JSON.stringify({
        type: 'header',
        file: fileInfo,
      }));

      await new Promise(resolve => setTimeout(resolve, 50));

      const chunkSize = 64 * 1024;
      let offset = 0;

      while (offset < file.size) {
        if (dataChannelRef.current.readyState !== 'open') {
          throw new Error('Data channel closed during transfer');
        }

        if (dataChannelRef.current.bufferedAmount > 1024 * 1024 * 10) {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        const chunk = file.slice(offset, offset + chunkSize);
        const buffer = await chunk.arrayBuffer();
        dataChannelRef.current.send(buffer);

        offset += buffer.byteLength;

        setProgress(prev => ({
          ...prev,
          [fileInfo.id]: {
            ...prev[fileInfo.id],
            bytesTransferred: offset,
          }
        }));

        updateSpeed(offset);
      }

      dataChannelRef.current.send(JSON.stringify({ type: 'eof', fileId: fileInfo.id }));
      
      setProgress(prev => ({
        ...prev,
        [fileInfo.id]: {
          ...prev[fileInfo.id],
          completed: true,
        }
      }));
    }

    setState('completed');
  };

  const handleReceiveMessage = (data: ArrayBuffer) => {
    if (currentReceivingFileRef.current) {
      receiveBufferRef.current.push(data);
      receivedSizeRef.current += data.byteLength;

      const fileId = currentReceivingFileRef.current.id;
      setProgress(prev => ({
        ...prev,
        [fileId]: {
          ...prev[fileId],
          bytesTransferred: receivedSizeRef.current,
        }
      }));

      updateSpeed(receivedSizeRef.current);
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

  const saveReceivedFile = async () => {
    if (!currentReceivingFileRef.current) return;

    const fileInfo = currentReceivingFileRef.current;
    const blob = new Blob(receiveBufferRef.current, { type: fileInfo.type });
    
    if (directoryHandleRef.current) {
      try {
        const fileHandle = await directoryHandleRef.current.getFileHandle(fileInfo.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (e) {
        console.error('Error saving to directory:', e);
        fallbackDownload(blob, fileInfo.name);
      }
    } else if (useShareRef.current && navigator.share) {
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

    currentReceivingFileRef.current = null;
    receiveBufferRef.current = [];
    receivedSizeRef.current = 0;
  };

  const updateSpeed = (currentBytes: number) => {
    const now = Date.now();
    const { time: lastTime, bytes: lastBytes } = lastSpeedCalcRef.current;
    
    if (now - lastTime > 1000) {
      const speedBps = ((currentBytes - lastBytes) / (now - lastTime)) * 1000;
      setSpeed(speedBps);
      lastSpeedCalcRef.current = { time: now, bytes: currentBytes };
    }
  };

  const cancelTransfer = useCallback((keepFiles = false) => {
    cleanupConnection();
    if (code) {
      socketRef.current?.emit('cancel-session', code);
    }
    setState('idle');
    setCode(null);
    if (!keepFiles) {
      setFiles([]);
      setFilesInfo([]);
    }
    setProgress({});
    setError(null);
    setSpeed(0);
  }, [code, cleanupConnection]);

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
