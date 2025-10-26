// import React, { useState, useRef, useEffect } from 'react';
// import './App.css';

// function App() {
//   const [isRecording, setIsRecording] = useState(false);
//   const [sessionId, setSessionId] = useState<string | null>(null);
//   const [status, setStatus] = useState('Ready to record classroom lecture');
//   const [notes, setNotes] = useState('');
//   const [isGenerating, setIsGenerating] = useState(false);
//   const [downloadUrl, setDownloadUrl] = useState('');
  
//   const videoRef = useRef<HTMLVideoElement>(null);
//   const streamRef = useRef<MediaStream | null>(null);
//   const captureIntervalRef = useRef<any>(null);
//   const recognitionRef = useRef<any>(null);
//   const currentTranscriptRef = useRef<string>('');

//   useEffect(() => {
//     if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
//       const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
//       recognitionRef.current = new SpeechRecognition();
//       recognitionRef.current.continuous = true;
//       recognitionRef.current.interimResults = true;
//       recognitionRef.current.lang = 'en-US';
      
//       recognitionRef.current.onresult = (event: any) => {
//         currentTranscriptRef.current = Array.from(event.results)
//           .map((result: any) => result[0].transcript)
//           .join(' ');
//       };
      
//       recognitionRef.current.onerror = (event: any) => {
//         console.log('Speech recognition error:', event.error);
//       };
//     }
    
//     return () => {
//       if (streamRef.current) {
//         streamRef.current.getTracks().forEach(track => track.stop());
//       }
//     };
//   }, []);

//   const startRecording = async () => {
//     try {
//       console.log('🎥 Requesting camera access...');
//       setStatus('📹 Requesting camera access...');
      
//       const stream = await navigator.mediaDevices.getUserMedia({
//         video: {
//           width: { ideal: 1920 },
//           height: { ideal: 1080 },
//           facingMode: 'user'
//         },
//         audio: true
//       });
      
//       console.log('✅ Camera access granted!');
//       streamRef.current = stream;
      
//       if (videoRef.current) {
//         videoRef.current.srcObject = stream;
//         videoRef.current.play().catch(e => console.error('Play error:', e));
//       }
      
//       console.log('📝 Creating recording session...');
//       const response = await fetch('http://localhost:3001/api/start-recording', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' }
//       });
      
//       if (!response.ok) {
//         throw new Error('Failed to create session on backend');
//       }
      
//       const data = await response.json();
//       const newSessionId = data.sessionId;
//       console.log('✅ Session created:', newSessionId);
      
//       // These must be set together
//       setSessionId(newSessionId);
//       setIsRecording(true);
//       setStatus('🎥 RECORDING NOW - Capturing frames every 5 seconds...');
      
//       if (recognitionRef.current) {
//         try {
//           recognitionRef.current.start();
//           console.log('🎤 Speech recognition started');
//         } catch (e) {
//           console.log('Speech recognition error:', e);
//         }
//       }
      
//       // Capture frames every 5 seconds
//       captureIntervalRef.current = setInterval(async () => {
//         await captureFrame(newSessionId);
//       }, 5000);
      
//     } catch (error: any) {
//       console.error('❌ Error:', error);
//       setIsRecording(false);
      
//       if (error.name === 'NotAllowedError') {
//         setStatus('❌ PERMISSION DENIED - Please allow camera & microphone');
//       } else if (error.name === 'NotFoundError') {
//         setStatus('❌ No camera found - check if it is connected');
//       } else if (error.name === 'NotReadableError') {
//         setStatus('❌ Camera is in use - close other apps');
//       } else {
//         setStatus(`❌ Error: ${error.message}`);
//       }
//     }
//   };

//   const captureFrame = async (currentSessionId: string) => {
//     if (!videoRef.current || videoRef.current.videoWidth === 0) {
//       return;
//     }
    
//     try {
//       const canvas = document.createElement('canvas');
//       canvas.width = videoRef.current.videoWidth;
//       canvas.height = videoRef.current.videoHeight;
//       const ctx = canvas.getContext('2d');
      
//       if (!ctx) return;
      
//       ctx.drawImage(videoRef.current, 0, 0);
      
//       canvas.toBlob(async (blob) => {
//         if (!blob) return;
        
//         const formData = new FormData();
//         formData.append('frame', blob, 'frame.jpg');
//         formData.append('sessionId', currentSessionId);
//         formData.append('timestamp', Date.now().toString());
//         formData.append('transcript', currentTranscriptRef.current);
        
//         try {
//           await fetch('http://localhost:3001/api/upload-frame', {
//             method: 'POST',
//             body: formData
//           });
          
//           const elapsed = Math.floor((Date.now() - parseInt(currentSessionId)) / 1000);
//           const transcriptPreview = currentTranscriptRef.current.slice(-40) || '(listening...)';
//           setStatus(`🎥 Recording... ${elapsed}s | Speech: "${transcriptPreview}"`);
//         } catch (error) {
//           console.error('Error uploading frame:', error);
//         }
//       }, 'image/jpeg', 0.85);
//     } catch (error) {
//       console.error('Error capturing frame:', error);
//     }
//   };

//   const stopRecording = async () => {
//     console.log('⏹️ Stopping recording...');
    
//     if (streamRef.current) {
//       streamRef.current.getTracks().forEach(track => track.stop());
//     }
    
//     if (captureIntervalRef.current) {
//       clearInterval(captureIntervalRef.current);
//     }
    
//     if (recognitionRef.current) {
//       try {
//         recognitionRef.current.stop();
//       } catch (e) {
//         console.log('Error stopping recognition:', e);
//       }
//     }
    
//     if (sessionId) {
//       await fetch('http://localhost:3001/api/end-recording', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ sessionId })
//       });
//     }
    
//     setIsRecording(false);
//     setStatus('✅ Recording stopped! Click "Generate Lecture Notes" to analyze.');
//   };

//   const generateNotes = async () => {
//     if (!sessionId) return;
    
//     setIsGenerating(true);
//     setStatus('🤖 Analyzing with Gemini AI... Extracting text from images & processing speech...');
    
//     try {
//       const response = await fetch('http://localhost:3001/api/generate-notes', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ sessionId })
//       });
      
//       if (!response.ok) {
//         throw new Error('Failed to generate notes');
//       }
      
//       const data = await response.json();
      
//       if (data.notes) {
//         setNotes(data.notes);
//         setStatus('✅ Lecture notes generated! Download as PDF.');
//       } else {
//         setStatus('❌ No notes received from Gemini');
//       }
//     } catch (error) {
//       console.error('Error generating notes:', error);
//       setStatus('❌ Error: Backend not responding. Is server running on port 3001?');
//     } finally {
//       setIsGenerating(false);
//     }
//   };

//   const downloadPDF = async () => {
//     if (!notes || !sessionId) return;
    
//     setStatus('📄 Creating PDF...');
    
//     try {
//       const response = await fetch('http://localhost:3001/api/download-pdf', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({ notes, sessionId })
//       });
      
//       if (!response.ok) {
//         throw new Error('Failed to create PDF');
//       }
      
//       const data = await response.json();
//       setDownloadUrl(`http://localhost:3001${data.downloadUrl}`);
//       setStatus('✅ PDF ready! Opening in new tab...');
      
//       window.open(`http://localhost:3001${data.downloadUrl}`, '_blank');
//     } catch (error) {
//       console.error('Error creating PDF:', error);
//       setStatus('❌ Error creating PDF');
//     }
//   };

//   return (
//     <div className="App">
//       <header className="App-header">
//         <h1>🎓 Lectra Capture</h1>
//         <p className="subtitle">AI-Powered Classroom Lecture Note Generator</p>
//         <div className="badge">Powered by Google Gemini AI</div>
//         <p className="instruction">📹 Point your camera at the board/projector to capture the lecture</p>
//       </header>
      
//       <main className="container">
//         <div className="video-section">
//           <div className="video-label">📹 Camera Preview (Classroom View)</div>
//           <video 
//             ref={videoRef} 
//             autoPlay 
//             muted 
//             playsInline
//             className="video-preview"
//           />
          
//           <div className="controls">
//             {!isRecording ? (
//               <button onClick={startRecording} className="btn btn-primary">
//                 🎥 Start Recording Lecture
//               </button>
//             ) : (
//               <button onClick={stopRecording} className="btn btn-danger">
//                 ⏹️ Stop Recording
//               </button>
//             )}
            
//             {sessionId && !isRecording && !notes && (
//               <button 
//                 onClick={generateNotes} 
//                 disabled={isGenerating}
//                 className="btn btn-success"
//               >
//                 {isGenerating ? '⏳ Analyzing...' : '✨ Generate Lecture Notes'}
//               </button>
//             )}
            
//             {notes && (
//               <button onClick={downloadPDF} className="btn btn-info">
//                 📄 Download as PDF
//               </button>
//             )}
//           </div>
          
//           <div className="status">
//             <strong>Status:</strong> {status}
//           </div>
          
//           <div className="info-box">
//             <h3>💡 How to Use:</h3>
//             <ol>
//               <li><strong>Position Camera:</strong> Point at whiteboard/projector</li>
//               <li><strong>Click Start:</strong> Camera turns on, frames captured every 5 seconds</li>
//               <li><strong>Microphone Records:</strong> Professor's speech captured automatically</li>
//               <li><strong>Click Stop:</strong> When lecture ends</li>
//               <li><strong>Generate Notes:</strong> Gemini extracts text from images + combines with speech</li>
//               <li><strong>Download PDF:</strong> Get your complete lecture notes</li>
//             </ol>
//           </div>
//         </div>
        
//         {notes && (
//           <div className="notes-section">
//             <h2>📝 Generated Lecture Notes</h2>
//             <p className="notes-subtitle">Extracted from classroom board/slides + professor's speech</p>
//             <div className="notes-content">
//               <pre>{notes}</pre>
//             </div>
//           </div>
//         )}
//       </main>
      
//       <footer>
//         <p>🏆 Hackathon Project - Google Gemini API Prize Category</p>
//         <p className="small">Uses Gemini 1.5 Pro for multimodal analysis (vision + speech)</p>
//       </footer>
//     </div>
//   );
// }

// export default App;

import React, { useState, useRef, useEffect } from 'react';
import './App.css';
import Login from './Login';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState('Ready to record classroom lecture');
  const [notes, setNotes] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureIntervalRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);
  const currentTranscriptRef = useRef<string>('');

  useEffect(() => {
    const savedUser = localStorage.getItem('lectra_user');
    if (savedUser) {
      const user = JSON.parse(savedUser);
      setCurrentUser(user.email);
      setIsLoggedIn(true);
    }
  }, []);

  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition =
        (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = 'en-US';

      recognitionRef.current.onresult = (event: any) => {
        currentTranscriptRef.current = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join(' ');
      };

      recognitionRef.current.onerror = (event: any) => {
        console.log('Speech recognition error:', event.error);
      };
    }

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const handleLoginSuccess = (userEmail: string) => {
    setCurrentUser(userEmail);
    setIsLoggedIn(true);
  };

  const handleLogout = () => {
    localStorage.removeItem('lectra_user');
    setIsLoggedIn(false);
    setCurrentUser('');
    setIsRecording(false);
    setSessionId(null);
    setNotes('');
    setStatus('Ready to record classroom lecture');
  };

  const startRecording = async () => {
    try {
      setStatus('📹 Requesting camera access...');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'user',
        },
        audio: true,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch((e) => console.error('Play error:', e));
      }

      const response = await fetch('http://localhost:3001/api/start-recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error('Failed to create session on backend');
      }

      const data = await response.json();
      const newSessionId = data.sessionId;
      setSessionId(newSessionId);
      setIsRecording(true);
      setStatus('🎥 RECORDING NOW - Capturing frames every 5 seconds...');

      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch (e) {
          console.log('Speech recognition error:', e);
        }
      }

      captureIntervalRef.current = setInterval(async () => {
        await captureFrame(newSessionId);
      }, 5000);

      stream.getTracks()[0].addEventListener('ended', () => {
        stopRecording();
      });
    } catch (error: any) {
      setIsRecording(false);
      if (error.name === 'NotAllowedError') {
        setStatus('❌ PERMISSION DENIED - Please allow camera & microphone');
      } else if (error.name === 'NotFoundError') {
        setStatus('❌ No camera found - check if it is connected');
      } else if (error.name === 'NotReadableError') {
        setStatus('❌ Camera is in use - close other apps');
      } else {
        setStatus(`❌ Error: ${error.message}`);
      }
    }
  };

  const captureFrame = async (currentSessionId: string) => {
    if (!videoRef.current || videoRef.current.videoWidth === 0) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) return;

      ctx.drawImage(videoRef.current, 0, 0);

      canvas.toBlob(
        async (blob) => {
          if (!blob) return;

          const formData = new FormData();
          formData.append('frame', blob, 'frame.jpg');
          formData.append('sessionId', currentSessionId);
          formData.append('timestamp', Date.now().toString());
          formData.append('transcript', currentTranscriptRef.current);

          try {
            await fetch('http://localhost:3001/api/upload-frame', {
              method: 'POST',
              body: formData,
            });
            const elapsed = Math.floor(
              (Date.now() - parseInt(currentSessionId)) / 1000
            );
            const transcriptPreview =
              currentTranscriptRef.current.slice(-40) || '(listening...)';
            setStatus(
              `🎥 Recording... ${elapsed}s | Speech: "${transcriptPreview}"`
            );
          } catch (error) {
            console.error('Error uploading frame:', error);
          }
        },
        'image/jpeg',
        0.85
      );
    } catch (error) {
      console.error('Error capturing frame:', error);
    }
  };

  const stopRecording = async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        console.log('Error stopping recognition:', e);
      }
    }
    if (sessionId) {
      await fetch('http://localhost:3001/api/end-recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    }
    setIsRecording(false);
    setStatus('✅ Recording stopped! Click "Generate Lecture Notes" to analyze.');
  };

  const generateNotes = async () => {
    if (!sessionId) return;
    setIsGenerating(true);
    setStatus('🤖 Analyzing with Gemini AI... Extracting text from images & processing speech...');
    try {
      const response = await fetch('http://localhost:3001/api/generate-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      if (!response.ok) {
        throw new Error('Failed to generate notes');
      }
      const data = await response.json();

      if (data.notes) {
        setNotes(data.notes);
        setStatus('✅ Lecture notes generated! Download as PDF.');
      } else {
        setStatus('❌ No notes received from Gemini');
      }
    } catch (error) {
      setStatus('❌ Error: Backend not responding. Is server running on port 3001?');
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadPDF = async () => {
    if (!notes || !sessionId) return;
    setStatus('📄 Creating PDF...');
    try {
      const response = await fetch('http://localhost:3001/api/download-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, sessionId }),
      });

      if (!response.ok) throw new Error('Failed to create PDF');
      const data = await response.json();
      setStatus('✅ PDF ready! Opening in new tab...');
      window.open(`http://localhost:3001${data.downloadUrl}`, '_blank');
    } catch (error) {
      setStatus('❌ Error creating PDF');
    }
  };

  if (!isLoggedIn) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="App">
      <header className="App-header">
        <div className="header-top">
          <div>
            <h1>🎓 Lectra Capture</h1>
            <p className="subtitle">AI-Powered Classroom Lecture Note Generator</p>
          </div>
          <div className="header-user">
            <span className="user-badge">👤 {currentUser}</span>
            <button onClick={handleLogout} className="btn-logout">
              Logout
            </button>
          </div>
        </div>
        <div className="header-badges">
          <div className="badge">Powered by Google Gemini AI</div>
          
          <p className="instruction">
            📹 Point your camera at the board/projector to capture the lecture
          </p>
        </div>
      </header>

      <main className="container">
        <div className="video-section">
          <div className="video-label">📹 Camera Preview (Classroom View)</div>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="video-preview"
          />

          <div className="controls">
            {!isRecording ? (
              <button onClick={startRecording} className="btn btn-primary">
                🎥 Start Recording Lecture
              </button>
            ) : (
              <button onClick={stopRecording} className="btn btn-danger">
                ⏹️ Stop Recording
              </button>
            )}

            {sessionId && !isRecording && !notes && (
              <button
                onClick={generateNotes}
                disabled={isGenerating}
                className="btn btn-success"
              >
                {isGenerating ? '⏳ Analyzing...' : '✨ Generate Lecture Notes'}
              </button>
            )}

            {notes && (
              <button onClick={downloadPDF} className="btn btn-info">
                📄 Download as PDF
              </button>
            )}
          </div>

          <div className="status">
            <strong>Status:</strong> {status}
          </div>

          <div className="info-box">
            <h3>💡 How to Use:</h3>
            <ol>
              <li>
                <strong>Position Camera:</strong> Point at whiteboard/projector
              </li>
              <li>
                <strong>Click Start:</strong> Camera turns on, frames captured every 5 seconds
              </li>
              <li>
                <strong>Microphone Records:</strong> Professor's speech captured automatically
              </li>
              <li>
                <strong>Click Stop:</strong> When lecture ends
              </li>
              <li>
                <strong>Generate Notes:</strong> Gemini extracts text from images + combines with speech
              </li>
              <li>
                <strong>Download PDF:</strong> Get your complete lecture notes
              </li>
            </ol>
          </div>
        </div>

        {notes && (
          <div className="notes-section">
            <h2>📝 Generated Lecture Notes</h2>
            <p className="notes-subtitle">
              Extracted from classroom board/slides + professor's speech
            </p>
            <div className="notes-content">
              <pre>{notes}</pre>
            </div>
          </div>
        )}
      </main>

      <footer>
        <p>🏆 Hackathon Project - Google Gemini API + Auth0 Prize Categories</p>
        <p className="small">
          Uses Gemini 2.0 Flash for multimodal analysis + Auth0 for secure authentication
        </p>
      </footer>
      <div className="auth0-floating-badge">
        <span className="badge auth0-badge">🔒 Secured with Auth0</span>
    </div>
    </div>
  );
}

export default App;
