import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import FormData from 'form-data';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(__dirname, '..', '..', 'data', 'temp_audio');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Extracts a short audio clip from a video file using ffmpeg.
 * Takes up to 90 seconds from the first part of the video (enough for Whisper to detect language & content).
 * Returns the path to the extracted .mp3 file.
 */
function extractAudio(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .setStartTime(0)
      .duration(300) // up to 5 min — Shorts (10-20s) get fully transcribed, longer videos capped at 5 min
      .output(outputPath)
      .outputFormat('mp3')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`ffmpeg error: ${err.message}`)))
      .run();
  });
}

/**
 * Transcribes an audio file using OpenAI-compatible Whisper API.
 * Works with both OpenAI and Groq endpoints.
 */
async function transcribeWithWhisper(audioPath, apiKey, endpoint = 'https://api.openai.com/v1/audio/transcriptions', model = 'whisper-1') {
  const form = new FormData();
  // Read file into buffer to avoid multipart stream issues with Groq
  const fileBuffer = fs.readFileSync(audioPath);
  form.append('file', fileBuffer, {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg',
    knownLength: fileBuffer.length,
  });
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    body: form.getBuffer(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return {
    text: data.text || '',
    language: data.language || 'unknown',
  };
}

/**
 * Main entry point: extracts audio from videoPath and transcribes it.
 * Returns { transcript, language } or null if transcription fails.
 */
export async function transcribeVideo(videoPath, openaiApiKey, endpoint = 'https://api.openai.com/v1/audio/transcriptions', model = 'whisper-1') {
  const tempAudioPath = path.join(TEMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

  try {
    console.log(`[Transcribe] Extracting audio from: ${path.basename(videoPath)}`);
    await extractAudio(videoPath, tempAudioPath);

    const stats = fs.statSync(tempAudioPath);
    if (stats.size < 1000) {
      throw new Error('Extracted audio file is too small — video may have no audio track.');
    }

    console.log(`[Transcribe] Sending ${(stats.size / 1024).toFixed(1)}KB audio to Whisper (${endpoint.includes('groq') ? 'Groq' : 'OpenAI'})...`);
    const result = await transcribeWithWhisper(tempAudioPath, openaiApiKey, endpoint, model);

    console.log(`[Transcribe] Done. Language: ${result.language}, Length: ${result.text.length} chars`);
    return result;
  } catch (err) {
    console.warn(`[Transcribe] Transcription failed: ${err.message}`);
    return null;
  } finally {
    try {
      if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
    } catch (_) {}
  }
}
