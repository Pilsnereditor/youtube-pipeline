import { GoogleGenerativeAI } from '@google/generative-ai';
import { queryOne } from '../db/database.js';

/**
 * Helper to retrieve user settings or global settings.
 */
function getSetting(userId, key, defaultValue = '') {
  let row = null;
  if (userId) {
    row = queryOne("SELECT value FROM user_settings WHERE user_id = @userId AND key = @key", { userId, key });
  }
  if (!row || !row.value) {
    row = queryOne("SELECT value FROM settings WHERE key = @key", { key });
  }
  return row ? row.value : defaultValue;
}

/**
 * Language selection helper.
 * If set to 'auto', checks if string contains Turkish characters or common Turkish words.
 */
function getLanguageInstruction(languageSetting, textToAnalyze = '') {
  let lang = 'english';
  
  if (languageSetting === 'tr') {
    lang = 'turkish';
  } else if (languageSetting === 'en') {
    lang = 'english';
  } else {
    // 'auto' detection: check for Turkish letters or common Turkish words
    const turkishPattern = /[ğışçöüĞİŞÇÖÜ]/;
    const commonTurkishWords = /\b(ve|bir|bu|ne|da|de|icin|için|gibi|daha|olarak|ile|en|sonra|kadar|yer|her|o|onlar|ben|sen|biz|siz|yok|var|mi|mı|mu|mü|ogrenci|öğrenci|suclu|suçlu|hangi|nasil|nasıl|nedir|neden|niye|ne zaman|kim|nerede|nereye)\b/i;
    
    if (turkishPattern.test(textToAnalyze) || commonTurkishWords.test(textToAnalyze)) {
      lang = 'turkish';
    }
  }
  
  if (lang === 'turkish') {
    return 'CRITICAL: You MUST write the titles, description, tags, summary, and all output text strictly in TURKISH language. Do not output English.';
  } else {
    return 'CRITICAL: You MUST write the titles, description, tags, summary, and all output text strictly in ENGLISH language.';
  }
}

/**
 * Extract key subject nouns/words from text, ignoring common stopwords.
 */
function extractKeywords(text, lang) {
  // Remove hashtags and punctuation
  const clean = text.replace(/#\S+/g, '').replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?\"']/g, ' ').toLowerCase();
  const words = clean.split(/\s+/).filter(w => w.length > 2);
  
  const trStopwords = new Set(['ve', 'bir', 'bu', 'ne', 'da', 'de', 'icin', 'için', 'gibi', 'daha', 'olarak', 'ile', 'en', 'sonra', 'kadar', 'yer', 'her', 'o', 'onlar', 'ben', 'sen', 'biz', 'siz', 'yok', 'var', 'mi', 'mı', 'mu', 'mü', 'hangi', 'nasil', 'nasıl', 'nedir', 'neden', 'niye', 'kim', 'nerede', 'nereye']);
  const enStopwords = new Set(['the', 'and', 'a', 'to', 'of', 'in', 'is', 'it', 'you', 'that', 'he', 'was', 'for', 'on', 'are', 'as', 'with', 'his', 'they', 'i', 'at', 'be', 'this', 'have', 'from', 'or', 'one', 'had', 'by', 'word', 'but', 'not', 'what', 'all', 'were', 'we', 'when', 'your', 'can', 'said', 'there', 'use', 'an', 'each', 'which', 'she', 'do', 'how', 'their', 'if']);

  const stopwords = lang === 'turkish' ? trStopwords : enStopwords;
  return words.filter(w => !stopwords.has(w));
}

function cleanSlice(str, maxLength) {
  if (str.length <= maxLength) return str;
  let sliced = str.slice(0, maxLength);
  const charCode = sliced.charCodeAt(sliced.length - 1);
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    sliced = sliced.slice(0, -1);
  }
  const lastSpace = sliced.lastIndexOf(' ');
  if (lastSpace > 0) {
    sliced = sliced.slice(0, lastSpace);
  }
  return sliced.trim();
}

export function optimizeTitle(title, niche = 'Slot') {
  let t = title.trim().replace(/\s+/g, ' ');

  const emojis = t.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu) || [];
  const defaultEmojis = ['🎰', '🔥', '👑', '💣', '🚀'];
  let targetEmojis = [...new Set(emojis)];
  if (targetEmojis.length < 2) {
    targetEmojis = [...new Set([...targetEmojis, '🎰', '🔥', '👑'])].slice(0, 3);
  } else if (targetEmojis.length > 3) {
    targetEmojis = targetEmojis.slice(0, 3);
  }

  t = t.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, '').trim();

  let hashtags = t.match(/#\w+/gi) || [];
  t = t.replace(/#\w+/gi, '').trim();
  t = t.replace(/[!\s]+$/, '').trim();

  t = t.toUpperCase();

  let targetHashtags = [...new Set(hashtags.map(h => h.toLowerCase()))];
  if (targetHashtags.length === 0) {
    if (niche.toLowerCase().includes('egt')) {
      targetHashtags = ['#slot', '#EGT'];
    } else {
      targetHashtags = ['#slot', '#casino'];
    }
  }
  targetHashtags = targetHashtags.map(h => h.startsWith('#') ? h : '#' + h).slice(0, 2);

  const emojisLength = targetEmojis.join('').length;
  const hashtagsLength = targetHashtags.join(' ').length;
  const maxMainTextLength = 100 - emojisLength - hashtagsLength - 3;
  
  if (t.length > maxMainTextLength) {
    t = cleanSlice(t, maxMainTextLength);
  }

  const modifiers = [
    "REKOR KAZANÇ!",
    "KASAYI KATLADIK!",
    "EFSANE BONUS!",
    "BÜYÜK VURGUN!",
    "ORTALIĞI YIKTI!",
    "REKOR REKOR!",
    "MUTLAKA İZLE!"
  ];

  const build = (mainText, emojiList, modCount, hashList) => {
    const emojiStr = emojiList.join('');
    const hashStr = hashList.join(' ');
    
    let currentTitle = `${mainText} ${emojiStr}`;
    let tempMods = [];
    for (let i = 0; i < modCount; i++) {
      tempMods.push(modifiers[i % modifiers.length]);
    }
    
    let finalModsStr = tempMods.join(' ');
    let result = mainText;
    if (emojiStr) result += ' ' + emojiStr;
    if (finalModsStr) result += ' ' + finalModsStr;
    if (hashStr) result += ' ' + hashStr;
    return result.replace(/\s+/g, ' ').trim();
  };

  let bestTitle = build(t, targetEmojis, 0, targetHashtags);
  let bestLengthDiff = 999;
  
  for (let modCount = 0; modCount <= 10; modCount++) {
    const candidate = build(t, targetEmojis, modCount, targetHashtags);
    const len = candidate.length;
    if (len >= 90 && len <= 100) {
      bestTitle = candidate;
      break;
    }
    
    if (len < 90) {
      const diff = 90 - len;
      if (diff < bestLengthDiff) {
        bestLengthDiff = diff;
        bestTitle = candidate;
      }
    } else if (len > 100) {
      break;
    }
  }

  if (bestTitle.length < 90) {
    let len = bestTitle.length;
    while (len < 90) {
      const extraEmoji = targetEmojis[0] || '🎰';
      bestTitle = bestTitle.replace(targetHashtags.join(' '), '').trim() + ' ' + extraEmoji + ' ' + targetHashtags.join(' ');
      len = bestTitle.length;
      if (bestTitle.length >= 100) break;
    }
  }

  if (bestTitle.length > 100) {
    const hashStr = targetHashtags.join(' ');
    const maxTextLength = 100 - hashStr.length - 1;
    bestTitle = cleanSlice(bestTitle.replace(hashStr, '').trim(), maxTextLength) + ' ' + hashStr;
  }

  return bestTitle;
}

/**
 * Heuristic Offline Generator for Titles
 * Uses actual subject content (video filename or niche) to produce varied titles.
 */
function generateOfflineTitles(niche, count, lang, subject = '') {
  const titles = [];
  const subjectText = subject || niche;
  const capitalizedSubject = subjectText.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const hookTr = [
    `${capitalizedSubject} Hakkında Bilmeniz Gerekenler`,
    `${capitalizedSubject} Nasıl Yapılır? (Adım Adım Rehber)`,
    `${capitalizedSubject}: Kimsenin Söylemediği Gerçekler`,
    `${capitalizedSubject} ile İlgili Her Şey`,
    `${capitalizedSubject} - Mutlaka İzleyin!`,
    `En İyi ${capitalizedSubject} Rehberi`,
    `${capitalizedSubject}: Uzman İpuçları ve Püf Noktaları`
  ];
  const hookEn = [
    `${capitalizedSubject}: Complete Beginner's Guide`,
    `${capitalizedSubject} - Everything You Should Know`,
    `How to Master ${capitalizedSubject} (Step by Step)`,
    `${capitalizedSubject} Tips & Tricks You Need to Try`,
    `The Ultimate ${capitalizedSubject} Guide`,
    `${capitalizedSubject} Secrets Revealed`,
    `${capitalizedSubject}: What Nobody Tells You`
  ];

  const hooks = lang === 'turkish' ? hookTr : hookEn;

  for (let i = 0; i < count; i++) {
    titles.push(hooks[i % hooks.length]);
  }
  return titles;
}

/**
 * Heuristic Offline Generator for Descriptions (Content & Language Aware)
 */
function generateOfflineDescription(title, niche, lang, keywords = []) {
  const capitalizedKeywords = keywords.map(k => k.charAt(0).toUpperCase() + k.slice(1));
  const keywordsStr = capitalizedKeywords.slice(0, 3).join(', ');

  if (lang === 'turkish') {
    const hookSentence = keywordsStr ? `Bu videoda özellikle ${capitalizedKeywords.join(' ve ')} konularına değinerek detaylı bir inceleme yapıyoruz.` : '';
    return `Harika bir video ile karşınızdayız! Bu videoda "${title}" konusunu ele alıyoruz. ${hookSentence}

Eğer bu tarz içeriklerin devamını istiyorsanız:
✅ Kanalımıza abone olmayı,
🔔 Bildirim zilini açmayı,
👍 Videoyu beğenmeyi ve yorum yapmayı unutmayın!

İzlediğiniz için teşekkürler!

#${niche.toLowerCase().replace(/\s+/g, '')} #bulmaca #bilmece #eğlence ${keywords.slice(0, 4).map(k => '#' + k).join(' ')}`;
  } else {
    const hookSentence = keywordsStr ? `In this video, we dive deep into ${keywordsStr} and analyze the best methods.` : '';
    return `Welcome to our latest video! Today, we are exploring "${title}" in the ${niche} niche. ${hookSentence}

Make sure to support us by:
✅ Subscribing to our channel,
🔔 Turning on notifications,
👍 Liking and sharing this video!

Thanks for watching!

#${niche.toLowerCase().replace(/\s+/g, '')} #video #youtube #content ${keywords.slice(0, 4).map(k => '#' + k).join(' ')}`;
  }
}

/**
 * Heuristic Offline Generator for Tags (50% video specific / 50% trending tags)
 * Produces 15-20 tags matching the YouTube maximum.
 */
function generateOfflineTags(title, niche, lang, keywords = []) {
  // Build specific tags from title words, niche, and extracted keywords
  const titleWords = title.toLowerCase().replace(/[^a-z0-9ğışçöüĞİŞÇÖÜ ]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
  const nicheWords = niche.toLowerCase().replace(/[^a-z0-9ğışçöüĞİŞÇÖÜ ]/gi, ' ').split(/\s+/).filter(w => w.length > 3);

  // Specific tags pool
  const specificPool = [...new Set([
    niche.toLowerCase(),
    title.toLowerCase(),
    ...keywords,
    ...titleWords,
    ...nicheWords
  ])].map(t => t.trim()).filter(t => t.length > 2);

  // Popular/trending tags based on language (aim for ~10 trending to fill 50%)
  const trTrending = [
    'türkiye', 'youtube türkiye', 'viral', 'trend', 'keşfet', 'gündem',
    'popüler video', 'eğlence', 'bilgi', 'nasıl yapılır', 'rehber', 'ipuçları',
    'izle', 'güncel', 'komik', 'ilginç', 'sosyal medya', 'türkçe video'
  ];
  const enTrending = [
    'trending', 'viral video', 'youtube', 'how to', 'tutorial', 'tips and tricks',
    'beginner guide', 'entertainment', 'popular', 'must watch', 'highlights',
    'educational', 'top 10', 'explained', 'review', 'best of', 'daily vlog', '2024'
  ];

  const trendingPool = lang === 'turkish' ? trTrending : enTrending;

  // Build combined: up to 10 specific + up to 10 trending = ~20 total
  const specificTags = specificPool.slice(0, 10);
  const combined = [...specificTags];
  for (const tag of trendingPool) {
    if (!combined.some(t => t === tag) && combined.length < 20) {
      combined.push(tag);
    }
  }

  return [...new Set(combined)].slice(0, 20);
}

/**
 * Heuristic Offline Generator for Video Metadata
 * Produces language-aware, content-derived metadata from the filename.
 */
function generateOfflineMetadata(originalFilename, niche, languageSetting) {
  // Clean up filename (remove extension, replace dashes/underscores with spaces)
  let cleanName = originalFilename
    .replace(/\.[^/.]+$/, "")
    .replace(/[_\-\.]+/g, " ")
    .replace(/#\S+/g, '')   // strip hashtags
    .replace(/\d{10,}/g, '') // strip timestamps/large numbers
    .trim();

  // Title-case the cleaned name
  let title = cleanName.split(' ')
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // If title is too short/uninformative, use niche as base
  if (title.length < 3) {
    title = niche.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  // Trim to YouTube's 100 char title limit
  if (title.length > 99) title = title.slice(0, 96) + '...';

  // Language detection: explicit setting overrides auto-detect
  let lang = 'english';
  if (languageSetting === 'tr') {
    lang = 'turkish';
  } else if (languageSetting === 'en') {
    lang = 'english';
  } else {
    // Auto-detect from filename or niche
    const turkishPattern = /[ğışçöüĞİŞÇÖÜ]/;
    const commonTurkishWords = /\b(ve|bir|bu|ne|da|de|icin|için|gibi|daha|olarak|ile|en|sonra|kadar|yer|her|onlar|ben|sen|biz|siz|yok|var|hangi|nasil|nasıl|nedir|neden|niye|izle|nedir|türk|türkiye|oyun|film|dizi|müzik|haber|spor|tarih|bilim|eğitim)\b/i;
    const checkStr = originalFilename + ' ' + niche;
    if (turkishPattern.test(checkStr) || commonTurkishWords.test(checkStr)) {
      lang = 'turkish';
    }
  }

  const keywords = extractKeywords(cleanName + ' ' + niche, lang);
  const description = generateOfflineDescription(title, niche, lang, keywords);
  const tagsList = generateOfflineTags(title, niche, lang, keywords);
  const tags = tagsList.filter(t => t.length > 0).join(', ');

  return { title: optimizeTitle(title, niche), description, tags };
}

/**
 * Direct HTTP API call helper for OpenAI completions.
 */
async function callOpenAI(apiKey, prompt, jsonMode = false) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: prompt }
      ],
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Direct HTTP API call helper for Groq completions (OpenAI-compatible API).
 * Uses llama-3.3-70b-versatile — free tier.
 */
async function callGroq(apiKey, prompt, jsonMode = false) {
  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Unified callAI helper.
 */
async function callAI(userId, prompt, jsonMode = false) {
  const provider = getSetting(userId, 'ai_provider', 'gemini');
  if (provider === 'openai') {
    const apiKey = getSetting(userId, 'openai_api_key') || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured in Settings.');
    return await callOpenAI(apiKey, prompt, jsonMode);
  } else if (provider === 'groq') {
    const apiKey = getSetting(userId, 'groq_api_key') || process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not configured in Settings.');
    return await callGroq(apiKey, prompt, jsonMode);
  } else {
    const model = getModel(userId);
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  }
}

/**
 * Return a configured GenerativeModel, reading the API key from user settings, global settings, or env.
 */
function getModel(userId) {
  const apiKey = getSetting(userId, 'gemini_api_key') || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your Settings.');
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

/**
 * Generate YouTube video titles for a given niche.
 */
export async function generateTitles(niche, count = 10, customPrompt = '', userId = null, videoContext = '') {
  const provider = getSetting(userId, 'ai_provider', 'gemini');
  const languageSetting = getSetting(userId, 'ai_language', 'auto');
  const langInstruction = getLanguageInstruction(languageSetting, (videoContext || niche) + ' ' + customPrompt);

  let baseInstructions = `You are a YouTube content strategist. Generate exactly ${count} highly clickable, SEO-optimized YouTube video titles for the niche: "${niche}".`;
  if (videoContext) {
    baseInstructions = `You are a YouTube content creator. Generate exactly ${count} optimized, attention-grabbing titles specifically for a video with filename/subject: "${videoContext}". Niche context: "${niche}".`;
  }

  const prompt = `${baseInstructions}

Rules:
- Each title length MUST be strictly between 90 and 100 characters (do not make it shorter than 90 characters under any circumstances. If it is too short, append more high-energy phrases!).
- MUST include 2-3 relevant high-energy gaming emojis (e.g., 🎰, 💣, 🔥, 🚀, 👑) inside each title.
- MUST include 1-2 trending/popular gaming hashtags at the end of each title (e.g., #slot, #casino, #EGT, #sweetbonanza).
- Creative Padding: Pad the titles with exciting slot modifiers, game features, and clickbait phrases (e.g., "REKOR KAZANÇ!", "KASAYI KATLADIK!", "EFSANE BONUS!", "BÜYÜK VURGUN!") so that the total string length is extremely close to 100 characters.
- Style: Use UPPERCASE words and exclamation marks to maximize click-through rate (CTR).
- ${langInstruction}
- Return ONLY a JSON array of strings, no explanation, no markdown fencing.
${customPrompt ? `\nAdditional instructions: ${customPrompt}` : ''}

Example output format:
["Title One Here", "Title Two Here"]`;

  try {
    const text = await callAI(userId, prompt, true);

    let titles;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      titles = JSON.parse(cleaned);
    } catch {
      titles = text
        .split('\n')
        .map((l) => l.replace(/^\d+[\.\)\-]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter((l) => l.length > 0 && l.length < 100);
    }

    return titles
      .filter((t) => typeof t === 'string' && t.length > 0)
      .map(t => optimizeTitle(t, niche))
      .slice(0, count);
  } catch (err) {
    console.warn('[AI] generateTitles failed, using offline fallback:', err.message);
    if (videoContext) {
      const clean = videoContext.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").replace(/#\S+/g, '').trim();
      const capitalized = clean.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return [optimizeTitle(capitalized, niche)];
    }
    return generateOfflineTitles(niche, count, languageSetting === 'tr' ? 'turkish' : 'english').map(t => optimizeTitle(t, niche));
  }
}

/**
 * Generate a YouTube video description given the title and niche.
 */
export async function generateDescription(title, niche, userId = null) {
  const provider = getSetting(userId, 'ai_provider', 'gemini');
  const languageSetting = getSetting(userId, 'ai_language', 'auto');
  const langInstruction = getLanguageInstruction(languageSetting, title + ' ' + niche);

  const prompt = `Write a compelling YouTube video description for a video titled "${title}" in the "${niche}" niche.

Requirements:
- 150-300 words
- Include a hook in the first two lines (these show before "Show more")
- Include relevant keywords naturally
- Add a call-to-action (subscribe, like, comment)
- Include 3-5 relevant hashtags at the end
- Do NOT include placeholder links — just use descriptive text where links would go
- ${langInstruction}

Return ONLY the description text, no extra commentary.`;

  try {
    return await callAI(userId, prompt, false);
  } catch (err) {
    console.warn('[AI] generateDescription failed, using offline fallback:', err.message);
    const lang = languageSetting === 'tr' ? 'turkish' : (languageSetting === 'en' ? 'english' : (/[ğışçöüĞİŞÇÖÜ]/.test(title) ? 'turkish' : 'english'));
    const keywords = extractKeywords(title, lang);
    return generateOfflineDescription(title, niche, lang, keywords);
  }
}

/**
 * Generate relevant tags / keywords for a YouTube video.
 */
export async function generateTags(title, niche, userId = null) {
  const provider = getSetting(userId, 'ai_provider', 'gemini');
  const languageSetting = getSetting(userId, 'ai_language', 'auto');
  const langInstruction = getLanguageInstruction(languageSetting, title + ' ' + niche);

  const prompt = `Generate exactly 15-20 YouTube tags/keywords for a video titled "${title}" in the "${niche}" niche.

Rules:
- 50% of the tags MUST be highly specific to the video content and title.
- The other 50% MUST be the MOST POPULAR and MOST VIRAL YouTube tags in TURKEY right now — these do NOT need to be related to the video at all. Use tags that get the most views on YouTube Turkey: viral trending hashtags, popular Turkish YouTube categories (eğlence, komedi, viral, keşfet, shorts, trending, vlog, gündem, etc.).
- ${langInstruction}
- Return ONLY a JSON array of strings, no explanation, no markdown fencing.

Example: ["tag one", "tag two"]`;

  try {
    const text = await callAI(userId, prompt, true);

    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return text
        .split('\n')
        .map((l) => l.replace(/^\d+[\.\)\-]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter((l) => l.length > 0);
    }
  } catch (err) {
    console.warn('[AI] generateTags failed, using offline fallback:', err.message);
    const lang = languageSetting === 'tr' ? 'turkish' : (languageSetting === 'en' ? 'english' : (/[ğışçöüĞİŞÇÖÜ]/.test(title) ? 'turkish' : 'english'));
    const keywords = extractKeywords(title, lang);
    return generateOfflineTags(title, niche, lang, keywords);
  }
}

/**
 * Analyse a competitor YouTube channel / video URL and generate content strategy suggestions.
 */
export async function cloneChannelStrategy(youtubeUrl, titleCount = 10, promptCount = 5, userId = null) {
  const provider = getSetting(userId, 'ai_provider', 'gemini');
  const languageSetting = getSetting(userId, 'ai_language', 'auto');
  const langInstruction = getLanguageInstruction(languageSetting, youtubeUrl);

  const prompt = `You are a YouTube growth strategist. Analyze the following YouTube URL and reverse-engineer the content strategy:

URL: ${youtubeUrl}

Based on what you can infer from this URL (channel name, niche keywords, video topic), provide:
1. A brief summary of the likely niche and content style (2-3 sentences).
2. ${titleCount} video title ideas inspired by their strategy (each under 100 characters).
3. ${promptCount} content angle / prompt ideas for creating similar but original videos.
- ${langInstruction}

Return your response as a JSON object with this exact structure (no markdown fencing):
{
  "summary": "...",
  "niche": "...",
  "titles": ["...", "..."],
  "contentPrompts": ["...", "..."]
}`;

  try {
    const text = await callAI(userId, prompt, true);

    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return {
        summary: text,
        niche: '',
        titles: [],
        contentPrompts: [],
      };
    }
  } catch (err) {
    console.warn('[AI] cloneChannelStrategy failed:', err.message);
    return {
      summary: 'Channel strategy analysis fallback',
      niche: 'General',
      titles: generateOfflineTitles('niche', titleCount, languageSetting === 'tr' ? 'turkish' : 'english'),
      contentPrompts: ['Create interesting video content based on this niche.']
    };
  }
}

/**
 * Generate YouTube Title, Description, and Tags using actual video transcription.
 * @param {string} originalFilename - The original filename of the video.
 * @param {string} niche - The channel niche.
 * @param {number|null} userId - The user ID for settings lookup.
 * @param {string|null} videoFilePath - Absolute path to the video file (for transcription).
 */
export async function generateVideoMetadata(originalFilename, niche, userId = null, videoFilePath = null) {
  const provider = getSetting(userId, 'ai_provider', 'gemini');
  const languageSetting = getSetting(userId, 'ai_language', 'auto');

  const cleanName = originalFilename
    .replace(/\.[^/.]+$/, '')
    .replace(/[_\-\.]+/g, ' ')
    .replace(/#\S+/g, '')
    .replace(/\d{10,}/g, '')
    .trim();

  // =========================================================================
  // STEP 1: Skipped per user request (Gemini video upload & watch is bypassed)

  // =========================================================================
  // STEP 2: Audio transcription fallback (Groq Whisper or OpenAI Whisper)
  // Extracts audio and transcribes it to understand spoken content.
  // =========================================================================
  let transcript = '';
  let detectedLanguage = null;

  if (videoFilePath && (provider === 'openai' || provider === 'groq')) {
    try {
      const apiKey = provider === 'groq'
        ? (getSetting(userId, 'groq_api_key') || process.env.GROQ_API_KEY)
        : (getSetting(userId, 'openai_api_key') || process.env.OPENAI_API_KEY);
      const whisperEndpoint = provider === 'groq'
        ? 'https://api.groq.com/openai/v1/audio/transcriptions'
        : 'https://api.openai.com/v1/audio/transcriptions';
      const whisperModel = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
      if (apiKey) {
        const { transcribeVideo } = await import('./transcribe.js');
        const result = await transcribeVideo(videoFilePath, apiKey, whisperEndpoint, whisperModel);
        if (result && result.text && result.text.length > 10) {
          transcript = result.text.slice(0, 3000);
          detectedLanguage = result.language;
          console.log(`[Metadata Gen] Transcript obtained (${transcript.length} chars, lang: ${detectedLanguage})`);
        }
      }
    } catch (err) {
      console.warn('[Metadata Gen] Transcription failed:', err.message);
    }
  }

  // =========================================================================
  // STEP 3: Build prompt with whatever context we have and call AI
  // =========================================================================
  let langInstruction;
  if (languageSetting === 'tr') {
    langInstruction = 'CRITICAL: You MUST write ALL output strictly in TURKISH. Do not use English.';
  } else if (languageSetting === 'en') {
    langInstruction = 'CRITICAL: You MUST write ALL output strictly in ENGLISH.';
  } else if (detectedLanguage) {
    const lang = detectedLanguage.toLowerCase();
    if (lang === 'turkish' || lang === 'tr') {
      langInstruction = 'CRITICAL: The video audio is in TURKISH. Write ALL output in TURKISH.';
    } else {
      langInstruction = `CRITICAL: The video audio is in ${detectedLanguage.toUpperCase()}. Write ALL output in ${detectedLanguage.toUpperCase()}.`;
    }
  } else {
    langInstruction = 'IMPORTANT: Detect the language from the filename and niche. If Turkish content (Turkish words/characters ğ,ş,ı,ç,ö,ü), write in Turkish. Otherwise English. Do NOT mix languages.';
  }

  const transcriptSection = transcript
    ? `\nVIDEO TRANSCRIPT:\n"""\n${transcript}\n"""\nBase your metadata primarily on this transcript.`
    : `\n(No transcript — base metadata on filename and niche.)`;

  const prompt = `You are an expert YouTube content strategist and SEO specialist.

VIDEO FILENAME: "${cleanName}"
CHANNEL NICHE: "${niche}"
${transcriptSection}

${langInstruction}

Generate the following metadata:

1. TITLE: A highly clickable, sensational, and SEO-optimized YouTube title.
   - The title length MUST be strictly between 90 and 100 characters (do not make it shorter than 90 characters under any circumstances. If it is too short, append more high-energy phrases!).
   - MUST base the title strictly on the filename context. DO NOT invent or add specific game names (e.g. Sweet Bonanza, Gates of Olympus), specific multipliers (e.g. 110x, 500x), or specific win amounts from the transcript unless they are explicitly written in the filename itself.
   - MUST include 2-3 relevant high-energy gaming emojis (e.g., 🎰, 💣, 🔥, 🚀, 👑) placed inside the title.
   - MUST include 1-2 popular gaming hashtags at the end of the title (e.g., #slot, #casino, #EGT).
   - Creative Padding: Pad the title by adding multiple excited Turkish slot phrases (e.g., "REKOR KAZANÇ!", "KASAYI KATLADIK!", "EFSANE BONUS!", "BÜYÜK VURGUN!") so that the total string length is extremely close to 100 characters.
   - Style: Use UPPERCASE words and exclamation marks to maximize click-through rate (CTR).

2. DESCRIPTION: A very detailed, long description (400-600 words) that:
   - Starts with a powerful hook (2-3 lines visible before "Show more")
   - Describes what the video is about in detail with specific context
   - Includes genuine commentary on why the content is interesting/entertaining
   - Naturally integrates SEO keywords throughout
   - Ends with a strong call-to-action (like, subscribe, comment, share)
   - Includes 5-8 relevant hashtags at the very end
   - Do NOT include placeholder links

3. TAGS: Exactly 15-20 tags where:
   - 50% are HIGHLY SPECIFIC to this video's content
   - 50% are the MOST POPULAR and MOST VIRAL YouTube tags in TURKEY right now — these do NOT need to be related to the video at all. Use the tags that get the most views on YouTube Turkey: viral trending hashtags, popular Turkish YouTube categories (eğlence, komedi, viral, keşfet, shorts, trending, etc.)

Return ONLY valid JSON, no markdown, no extra text:
{"title":"...","description":"...","tags":["tag1","tag2",...]}`;

  try {
    const text = await callAI(userId, prompt, true);
    console.log("[AI] Raw Response text:", text);
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const tagsStr = Array.isArray(parsed.tags) ? parsed.tags.join(', ') : (parsed.tags || '');
    return {
      title: optimizeTitle(parsed.title || cleanName, niche),
      description: parsed.description || '',
      tags: tagsStr,
    };
  } catch (err) {
    console.warn('[AI] generateVideoMetadata failed, using offline fallback:', err.message);
    return generateOfflineMetadata(originalFilename, niche, languageSetting);
  }
}

