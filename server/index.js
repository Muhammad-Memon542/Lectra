import express from 'express';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import { mdToPdf } from 'md-to-pdf';
import dotenv from 'dotenv';

dotenv.config(); // Load .env variables for Google API key

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configure multer to save files with .jpg extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    cb(null, `frame_${timestamp}_${random}.jpg`);
  }
});

const upload = multer({ storage });

// Initialize Gemini AI with API key from .env or fallback
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'AIzaSyB5o3tBs2c2VWMtXrcBuKGAyXtLEWBuZgc');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static(path.join(__dirname, '../public/downloads')));
app.use('/audio', express.static(path.join(__dirname, '../public/audio')));

// Store recording sessions
const sessions = new Map();

app.post('/api/start-recording', (req, res) => {
  const sessionId = Date.now().toString();
  sessions.set(sessionId, {
    frames: [],
    transcripts: [],
    startTime: new Date()
  });
  console.log('✅ Session started:', sessionId);
  res.json({ sessionId });
});

app.post('/api/upload-frame', upload.single('frame'), async (req, res) => {
  const { sessionId, timestamp, transcript } = req.body;
  
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const session = sessions.get(sessionId);
  
  if (req.file) {
    console.log(`✅ Frame uploaded: ${req.file.filename} (${req.file.size} bytes)`);
    session.frames.push({
      path: req.file.path,
      filename: req.file.filename,
      timestamp: parseInt(timestamp)
    });
  }
  
  if (transcript) {
    session.transcripts.push({
      text: transcript,
      timestamp: parseInt(timestamp)
    });
  }
  
  res.json({ success: true, filename: req.file?.filename });
});

app.post('/api/generate-notes', async (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const session = sessions.get(sessionId);
  
  console.log(`\n📝 Generating notes for session ${sessionId}`);
  console.log(`📸 Total frames: ${session.frames.length}`);
  console.log(`🎤 Total transcripts: ${session.transcripts.length}`);
  
  try {
    console.log('🤖 Initializing Gemini...');
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    
    const parts = [];
    
    parts.push({
      text: `You are an expert lecture note-taker. Analyze the following classroom lecture materials including screenshots and transcripts captured every 5 seconds during the lecture.

Your task is to:
1. Identify the main topics and subtopics covered
2. Extract key concepts, definitions, and formulas from the images
3. Organize the information chronologically and thematically
4. Create comprehensive, well-structured lecture notes in markdown format
5. Include any diagrams, equations, or important visual information described in text

Format your response as a complete markdown document with:
- A clear title
- Table of contents
- Main sections with headers (##)
- Subsections (###)
- Bullet points for key concepts
- Code blocks for any code or formulas
- Clear explanations

Here are the lecture materials:`
    });
    
    if (session.transcripts.length > 0) {
      const transcriptText = session.transcripts
        .map((t) => `[${Math.floor(t.timestamp / 1000)}s] ${t.text}`)
        .join('\n\n');
      console.log('📤 Adding transcripts to Gemini...');
      parts.push({ text: `\n\nTRANSCRIPTS:\n${transcriptText}` });
    }
    
    // Sample frames to avoid token limits
    const sampleFrames = session.frames
      .filter((_, i) => i % Math.ceil(session.frames.length / 10) === 0)
      .slice(0, 10);
    
    console.log(`📸 Sending ${sampleFrames.length} frames to Gemini (sampled from ${session.frames.length} total)...`);
    
    let framesAdded = 0;
    for (const frame of sampleFrames) {
      if (fs.existsSync(frame.path)) {
        try {
          const imageData = fs.readFileSync(frame.path);
          const base64Image = imageData.toString('base64');
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Image
            }
          });
          parts.push({ text: `[Image at ${Math.floor(frame.timestamp / 1000)}s - ${frame.filename}]` });
          framesAdded++;
          console.log(`  ✅ Added: ${frame.filename}`);
        } catch (error) {
          console.error(`  ❌ Error reading frame ${frame.path}:`, error.message);
        }
      } else {
        console.error(`  ⚠️ File not found: ${frame.path}`);
      }
    }
    
    console.log(`\n🚀 Sending ${framesAdded} frames + transcripts to Gemini API...`);
    const result = await model.generateContent(parts);
    const response = await result.response;
    const notes = response.text();
    
    console.log('✅ Notes generated successfully!');
    console.log(`📄 Notes length: ${notes.length} characters`);
    res.json({ notes, sessionId });
    
  } catch (error) {
    console.error('\n❌ Error generating notes:', error);
    res.status(500).json({ 
      error: 'Failed to generate notes', 
      details: error.message,
      type: error.name
    });
  }
});

app.post('/api/download-pdf', async (req, res) => {
  const { notes, sessionId } = req.body;

  try {
    const downloadsDir = path.join(__dirname, '../public/downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    const base = `notes_${sessionId}_${Date.now()}`;
    const mdFile = path.join(downloadsDir, `${base}.md`);

    // Save Markdown file
    fs.writeFileSync(mdFile, notes);

    // Response with file paths
    res.json({
      success: true,
      markdownUrl: `/downloads/${base}.md`,
      message: 'Markdown generated successfully.'
    });
  } catch (error) {
    console.error('❌ PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate PDF', details: error.message });
  }
});

app.post('/api/end-recording', (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  const session = sessions.get(sessionId);
  console.log(`\n📹 Recording ended. Frames: ${session.frames.length}, Transcripts: ${session.transcripts.length}`);
  
  res.json({ success: true });
});

app.get('/api/list-downloads', (req, res) => {
  try {
    const downloadsDir = path.join(__dirname, './public/downloads');
    
    if (!fs.existsSync(downloadsDir)) {
      return res.json({ files: [] });
    }
    
    const files = fs.readdirSync(downloadsDir).map(filename => ({
      name: filename,
      path: `/downloads/${filename}`,
      fullPath: path.join(downloadsDir, filename)
    }));
    
    res.json({ files });
  } catch (error) {
    console.error('❌ Error listing downloads:', error);
    res.status(500).json({ error: 'Failed to list downloads', details: error.message });
  }
});

// ElevenLabs TTS Endpoint with Hardcoded API Key
app.post('/api/text-to-speech', async (req, res) => {
  const { text } = req.body;

  if (!text) {
    console.error('❌ No text provided in request body');
    return res.status(400).json({ error: 'Text is required' });
  }

  const ELEVENLABS_API_KEY = 'e17110b6a55db64540ef4d445ed3d39bfdd5510a09ac6b2c805489397bd967ae';
  console.log('🔑 ElevenLabs API key (first 20 chars):', ELEVENLABS_API_KEY.substring(0, 20));
  console.log('🔍 Full request headers:', {
    'Accept': 'audio/mpeg',
    'Content-Type': 'application/json',
    'xi-api-key': ELEVENLABS_API_KEY.substring(0, 20) + '...' // Hide full key
  });
  console.log(`🎤 Generating TTS for text: "${text.substring(0, 50)}..." (length: ${text.length} chars)`);

  try {
    const requestBody = {
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5
      }
    };
    console.log('📤 Request body:', JSON.stringify(requestBody, null, 2));

    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    console.log(`📡 Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      let errorDetails = `HTTP ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json();
        errorDetails += `: ${JSON.stringify(errorBody)}`;
      } catch (parseErr) {
        const errorText = await response.text();
        errorDetails += `: ${errorText}`;
      }
      throw new Error(errorDetails);
    }

    const audioDir = path.join(__dirname, '../public/audio');
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    const audioFilename = `tts_${Date.now()}.mp3`;
    const audioPath = path.join(audioDir, audioFilename);
    
    const audioBuffer = await response.arrayBuffer();
    fs.writeFileSync(audioPath, Buffer.from(audioBuffer));

    console.log(`✅ TTS generated: ${audioFilename}`);

    const audioUrl = `/audio/${audioFilename}`;
    res.json({ success: true, audioUrl });

  } catch (error) {
    console.error('❌ ElevenLabs TTS error:', error.message);
    res.status(500).json({ error: 'Failed to generate speech', details: error.message });
  }
});

// === QUIZ & FLASHCARDS GENERATION ENDPOINTS ===
// Helper to call Gemini with a strict-JSON prompt
async function callGeminiJSON({ modelName = 'gemini-2.0-flash', prompt }) {
  const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: 'application/json' } });
  const result = await model.generateContent([{ text: prompt }]);
  const response = await result.response;
  const text = response.text();
  // Defensive parse
  try { return JSON.parse(text); } catch (e) { throw new Error("Gemini did not return valid JSON: " + text.slice(0, 400)); }
}

// POST /api/generate-quiz  body: { text, count, difficulty, qtype }
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const { text = '', count = 8, difficulty = 'Medium', qtype = 'Multiple Choice' } = req.body || {};
    const prompt = `
You are a tutor. Create a ${qtype} quiz from the given study material.
Difficulty: ${difficulty}. Number of questions: ${count}.

Return STRICT JSON matching exactly:
{
  "quiz": [
    {
      "question": "string",
      "choices": ["string", "string", "string", "string"],
      "correctIndex": 0,
      "explanation": "string"
    }
  ]
}

Rules:
- choices must be 3–5 items
- correctIndex must be an integer pointing at the right choice
- no markdown, no prose, JSON ONLY.

Study material:
"""${text.slice(0, 8000)}"""`;
    const json = await callGeminiJSON({ prompt });
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/generate-flashcards  body: { text, count }
app.post('/api/generate-flashcards', async (req, res) => {
  try {
    const { text = '', count = 20 } = req.body || {};
    const prompt = `
Create ${count} flashcards from the study material. Prefer definitions, key terms, formulas, and Q/A facts.

Return STRICT JSON matching exactly:
{
  "cards": [
    { "front": "string (question/term)", "back": "string (answer/definition)" }
  ]
}

Rules:
- JSON ONLY. No markdown.
- Keep "front" concise, "back" clear.
- Avoid duplicates.

Study material:
"""${text.slice(0, 8000)}"""`;
    const json = await callGeminiJSON({ prompt });
    res.json(json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📝 API available at http://localhost:${PORT}/api`);
  console.log('⏳ Waiting for requests...\n');
});