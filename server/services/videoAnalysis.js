/**
 * videoAnalysis.js
 * Uses Google Gemini's multimodal video understanding to "watch" a video
 * and generate detailed, context-aware YouTube metadata.
 *
 * Flow:
 *   1. Upload video to Gemini File API
 *   2. Wait for Gemini to process/index the video
 *   3. Ask Gemini to watch it and generate title + long description + tags as JSON
 *   4. Delete the uploaded file from Gemini (clean up)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';
import path from 'path';

/**
 * Polls until the uploaded file is ACTIVE (processed by Gemini).
 */
async function waitForFileActive(fileManager, fileName, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const file = await fileManager.getFile(fileName);
    if (file.state === 'ACTIVE') return file;
    if (file.state === 'FAILED') throw new Error('Gemini file processing failed.');
    console.log(`[VideoAnalysis] File still processing (state: ${file.state}), waiting...`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Gemini file processing timed out after 2 minutes.');
}

/**
 * Gets MIME type from file extension.
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
  };
  return map[ext] || 'video/mp4';
}

/**
 * Analyzes a video file using Gemini's multimodal understanding.
 * Returns { title, description, tags } with a very detailed, long description.
 *
 * @param {string} videoFilePath - Absolute path to the video file
 * @param {string} originalFilename - Original filename (for context)
 * @param {string} niche - Channel niche
 * @param {string} apiKey - Gemini API key
 * @param {string} languageSetting - 'auto', 'tr', or 'en'
 */
export async function analyzeVideoWithGemini(videoFilePath, originalFilename, niche, apiKey, languageSetting = 'auto') {
  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const cleanName = originalFilename
    .replace(/\.[^/.]+$/, '')
    .replace(/[_\-\.]+/g, ' ')
    .replace(/#\S+/g, '')
    .trim();

  // Language instruction
  let langInstruction;
  if (languageSetting === 'tr') {
    langInstruction = 'CRITICAL: You MUST write ALL output strictly in TURKISH. Do not use English at all.';
  } else if (languageSetting === 'en') {
    langInstruction = 'CRITICAL: You MUST write ALL output strictly in ENGLISH.';
  } else {
    langInstruction = 'IMPORTANT: Watch the video and detect the language being spoken or shown. If Turkish, write ALL output in Turkish. If English, write in English. Match the language of the video content exactly.';
  }

  const prompt = `You are an expert YouTube content strategist. Watch this entire video carefully.

VIDEO FILENAME: "${cleanName}"
CHANNEL NICHE: "${niche}"

${langInstruction}

After watching the video, generate the following:

1. TITLE: A highly clickable, SEO-optimized YouTube title that accurately describes what actually happens in this video. Under 100 characters. No generic templates.

2. DESCRIPTION: A very detailed, long YouTube description (400-600 words) that:
   - Starts with a powerful hook (2-3 lines shown before "Show more")
   - Describes exactly what happens in the video, step by step, with specific details about the content
   - Includes your genuine commentary/opinion about the video's content, what makes it interesting or entertaining
   - Naturally integrates relevant SEO keywords throughout
   - Ends with a call-to-action (like, subscribe, comment, share)
   - Includes 5-8 relevant hashtags at the very end
   - Do NOT include placeholder links

3. TAGS: Exactly 15-20 YouTube tags where:
   - 50% (8-10 tags) are HIGHLY SPECIFIC to this exact video's content (what you actually saw in the video).
   - 50% (8-10 tags) are the MOST POPULAR and MOST VIRAL YouTube tags in TURKEY right now — these do NOT need to be related to the video at all. Think: the tags that get the most views on YouTube Turkey, used on viral Turkish videos, trending hashtags, popular categories in Turkey (entertainment, comedy, viral, shorts, etc.).

Return ONLY valid JSON, no markdown fences, no extra text:
{"title":"...","description":"...","tags":["tag1","tag2",...]}`;

  let uploadedFileName = null;
  try {
    // Step 1: Upload video to Gemini File API
    const fileSize = fs.statSync(videoFilePath).size;
    const mimeType = getMimeType(videoFilePath);
    console.log(`[VideoAnalysis] Uploading ${(fileSize / 1024 / 1024).toFixed(1)}MB video to Gemini...`);

    const uploadResult = await fileManager.uploadFile(videoFilePath, {
      mimeType,
      displayName: originalFilename,
    });
    uploadedFileName = uploadResult.file.name;
    console.log(`[VideoAnalysis] Uploaded as: ${uploadedFileName}`);

    // Step 2: Wait for Gemini to process the video
    const activeFile = await waitForFileActive(fileManager, uploadedFileName);
    console.log(`[VideoAnalysis] File is ACTIVE. Asking Gemini to watch it...`);

    // Step 3: Ask Gemini to watch and analyze
    const result = await model.generateContent([
      {
        fileData: {
          mimeType: activeFile.mimeType,
          fileUri: activeFile.uri,
        },
      },
      { text: prompt },
    ]);

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const tagsStr = Array.isArray(parsed.tags) ? parsed.tags.join(', ') : (parsed.tags || '');

    console.log(`[VideoAnalysis] Done! Title: "${parsed.title}"`);
    return {
      title: (parsed.title || cleanName).slice(0, 99),
      description: parsed.description || '',
      tags: tagsStr,
    };
  } finally {
    // Step 4: Always clean up the uploaded file from Gemini
    if (uploadedFileName) {
      try {
        await fileManager.deleteFile(uploadedFileName);
        console.log(`[VideoAnalysis] Cleaned up Gemini file: ${uploadedFileName}`);
      } catch (_) {}
    }
  }
}
