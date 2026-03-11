import React, { useEffect, useRef, useState } from 'react';
import { Html5QrcodeScanner, Html5Qrcode } from 'html5-qrcode';
import { X } from 'lucide-react';

interface QRScannerProps {
  onScan: (code: string) => void;
  onClose: () => void;
}

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    const html5QrCode = new Html5Qrcode("qr-reader");
    scannerRef.current = html5QrCode;

    html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
      },
      (decodedText) => {
        // Stop scanning once we get a result
        html5QrCode.stop().then(() => {
          // Extract code from URL if it's a URL, otherwise use the text
          try {
            const url = new URL(decodedText);
            const code = url.searchParams.get('code');
            if (code && code.length === 6) {
              onScan(code);
            } else {
              onScan(decodedText.replace(/\D/g, '').substring(0, 6));
            }
          } catch {
            onScan(decodedText.replace(/\D/g, '').substring(0, 6));
          }
        }).catch(err => console.error("Failed to stop scanner", err));
      },
      (errorMessage) => {
        // Ignore normal scan errors (when no QR is found in frame)
      }
    ).catch((err) => {
      setError("Failed to access camera. Please ensure you have granted camera permissions.");
      console.error(err);
    });

    return () => {
      if (scannerRef.current && scannerRef.current.isScanning) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="font-medium text-lg">Scan QR Code</h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-6">
          {error ? (
            <div className="text-red-400 text-center p-4 bg-red-500/10 rounded-xl">
              {error}
            </div>
          ) : (
            <div className="relative rounded-2xl overflow-hidden bg-black aspect-square">
              <div id="qr-reader" className="w-full h-full"></div>
            </div>
          )}
          <p className="text-center text-slate-400 text-sm mt-6">
            Point your camera at the sender's QR code
          </p>
        </div>
      </div>
    </div>
  );
}
