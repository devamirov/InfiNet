const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const Replicate = require('replicate');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const whatsappBot = require('./whatsapp-bot');

// Configure multer for audio file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const app = express();
const PORT = process.env.PORT || 3002;

// Trust proxy to get real client IP from X-Forwarded-For header (Apache2 reverse proxy)
app.set('trust proxy', true);

// Initialize AI services
// Main Gemini API (for chat and prompt) - with fallback keys
// Array of API keys for chat endpoint (will try in sequence if quota exceeded)
const chatApiKeys = [
  process.env.GEMINI_API_KEY || null,           // Main key
  process.env.GEMINI_API_KEY_CHAT_FALLBACK || null     // Fallback key
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for chat
const genAIChatInstances = chatApiKeys.map(key => new GoogleGenerativeAI(key));

// Groq API keys for Chat (Fallback2 and Fallback3)
const chatGroqApiKeys = [
  process.env.GROQ_API_KEY_CHAT_FALLBACK2 || null,     // Fallback2 Groq
  process.env.GROQ_API_KEY_CHAT_FALLBACK3 || null      // Fallback3 Groq
].filter(key => key !== null);

// Create array of Groq instances for chat
const groqChatInstances = chatGroqApiKeys.map(key => new Groq({ apiKey: key }));

// Main Gemini API instance (for backward compatibility and prompt endpoint)
const genAI = chatApiKeys.length > 0 
  ? new GoogleGenerativeAI(chatApiKeys[0]) 
  : null;

// Blog API keys array (with fallback keys)
const blogApiKeys = [
  process.env.GEMINI_API_KEY_BLOG || null,           // Main blog key
  process.env.GEMINI_API_KEY_BLOG_FALLBACK || null   // Fallback key
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for blog
const genAIBlogInstances = blogApiKeys.map(key => new GoogleGenerativeAI(key));

// Groq API keys for Blog/Social (Fallback2 and Fallback3)
const blogGroqApiKeys = [
  process.env.GROQ_API_KEY_BLOG_FALLBACK2 || null,     // Fallback2 Groq
  process.env.GROQ_API_KEY_BLOG_FALLBACK3 || null      // Fallback3 Groq
].filter(key => key !== null);

// Create array of Groq instances for blog/social
const groqBlogInstances = blogGroqApiKeys.map(key => new Groq({ apiKey: key }));
const groqSocialInstances = blogGroqApiKeys.map(key => new Groq({ apiKey: key })); // Shared with blog

// Social API keys array (with fallback keys)
// Uses same keys as Blog section
const socialApiKeys = [
  process.env.GEMINI_API_KEY_BLOG || null,           // Main social key (shared with Blog)
  process.env.GEMINI_API_KEY_BLOG_FALLBACK || null   // Fallback key (shared with Blog)
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for social
const genAISocialInstances = socialApiKeys.map(key => new GoogleGenerativeAI(key));

// Prompt API keys array (with fallback keys)
const promptApiKeys = [
  process.env.GEMINI_API_KEY_PROMPT || null,           // Main prompt key
  process.env.GEMINI_API_KEY_PROMPT_FALLBACK || null   // Fallback key
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for prompt
const genAIPromptInstances = promptApiKeys.map(key => new GoogleGenerativeAI(key));

// Groq API keys for Prompt (Fallback2 and Fallback3)
const promptGroqApiKeys = [
  process.env.GROQ_API_KEY_PROMPT_FALLBACK2 || null,     // Fallback2 Groq
  process.env.GROQ_API_KEY_PROMPT_FALLBACK3 || null      // Fallback3 Groq
].filter(key => key !== null);

// Create array of Groq instances for prompt
const groqPromptInstances = promptGroqApiKeys.map(key => new Groq({ apiKey: key }));

// Voice API keys array (with fallback keys)
const voiceApiKeys = [
  process.env.GEMINI_API_KEY_VOICE || null,           // Main voice key
  process.env.GEMINI_API_KEY_VOICE_FALLBACK || null   // Fallback key
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for voice
const genAIVoiceInstances = voiceApiKeys.map(key => new GoogleGenerativeAI(key));

// Groq API keys for Voice (Fallback2 and Fallback3)
const voiceGroqApiKeys = [
  process.env.GROQ_API_KEY_VOICE_FALLBACK2 || null,     // Fallback2 Groq
  process.env.GROQ_API_KEY_VOICE_FALLBACK3 || null      // Fallback3 Groq
].filter(key => key !== null);

// Create array of Groq instances for voice
const groqVoiceInstances = voiceGroqApiKeys.map(key => new Groq({ apiKey: key }));

// Automation Ideas API keys array (with fallback keys)
// Uses same keys as Automation Insight Center
const automationApiKeys = [
  process.env.GEMINI_API_KEY_AUTOMATION_INSIGHT || null,           // Main automation key (shared with Insight)
  process.env.GEMINI_API_KEY_AUTOMATION_INSIGHT_FALLBACK || null  // Fallback key (shared with Insight)
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for automation ideas
const genAIAutomationInstances = automationApiKeys.map(key => new GoogleGenerativeAI(key));

// Groq API keys for Automation (Fallback2 and Fallback3)
const automationGroqApiKeys = [
  process.env.GROQ_API_KEY_AUTOMATION_FALLBACK2 || null,     // Fallback2 Groq
  process.env.GROQ_API_KEY_AUTOMATION_FALLBACK3 || null      // Fallback3 Groq
].filter(key => key !== null);

// Create array of Groq instances for automation (shared between ideas and insight)
const groqAutomationInstances = automationGroqApiKeys.map(key => new Groq({ apiKey: key }));
const groqAutomationInsightInstances = automationGroqApiKeys.map(key => new Groq({ apiKey: key })); // Shared

// Automation Insight Center API keys array (with fallback keys) - separate from Automation Ideas
const automationInsightApiKeys = [
  process.env.GEMINI_API_KEY_AUTOMATION_INSIGHT || null,           // Main insight key
  process.env.GEMINI_API_KEY_AUTOMATION_INSIGHT_FALLBACK || null   // Fallback key
].filter(key => key !== null); // Remove null values

// Create array of GoogleGenerativeAI instances for automation insight center
const genAIAutomationInsightInstances = automationInsightApiKeys.map(key => new GoogleGenerativeAI(key));

const openai = process.env.OPENAI_API_KEY 
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) 
  : null;

// Initialize Replicate for image-to-image
const replicate = process.env.REPLICATE_API_TOKEN
  ? new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
  : null;

// Middleware
const corsOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:8081', 'exp://localhost:8081'];

// More permissive CORS for mobile app
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    // Allow all origins for now (can be restricted later)
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Static files (WhatsApp QR page)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/whatsapp', (req, res) => res.redirect('/whatsapp-qr.html'));

// ============================================
// HELPER FUNCTIONS
// ============================================

// Comprehensive image generation request detection
// Detects any message that indicates the user wants to generate/create an image
function isImageGenerationRequest(text) {
  if (!text || text.trim().length === 0) return false;
  
  const lowerText = text.toLowerCase().trim();
  
  // Expanded English keywords - any phrase that could indicate image generation
  const englishKeywords = [
    // Direct commands
    'generate image', 'create image', 'make image', 'draw image', 'design image',
    'generate an image', 'create an image', 'make an image', 'draw an image', 'design an image',
    'generate a image', 'create a image', 'make a image', 'draw a image', 'design a image',
    'generate picture', 'create picture', 'make picture', 'draw picture', 'design picture',
    'generate a picture', 'create a picture', 'make a picture', 'draw a picture', 'design a picture',
    'generate an picture', 'create an picture', 'make an picture', 'draw an picture', 'design an picture',
    // With "for me" / "me"
    'generate image for me', 'create image for me', 'make image for me', 'draw image for me',
    'make me an image', 'create me an image', 'draw me an image', 'generate me an image',
    'make me a image', 'create me a image', 'draw me a image', 'generate me a image',
    'make me a picture', 'create me a picture', 'draw me a picture', 'generate me a picture',
    'make me an picture', 'create me an picture', 'draw me an picture', 'generate me an picture',
    // Indirect requests
    'I want an image', 'I want a image', 'I want image', 'I need an image', 'I need a image', 'I need image',
    'I want a picture', 'I want an picture', 'I want picture', 'I need a picture', 'I need an picture', 'I need picture',
    'can you generate image', 'can you create image', 'can you make image', 'can you draw image',
    'can you create', 'can you make', 'can you generate', 'can you draw',
    'could you generate image', 'could you create image', 'could you make image', 'could you draw image',
    'could you create', 'could you make', 'could you generate', 'could you draw',
    'create for me', 'make for me', 'generate for me', 'draw for me',
    'will you generate image', 'will you create image', 'will you make image', 'will you draw image',
    'please generate image', 'please create image', 'please make image', 'please draw image',
    // Image types
    'image of', 'picture of', 'photo of', 'drawing of', 'artwork of', 'illustration of',
    'an image of', 'a image of', 'a picture of', 'a photo of', 'a drawing of', 'an artwork of', 'an illustration of',
    // Action words
    'draw', 'paint', 'sketch', 'illustrate', 'design', 'produce', 'craft', 'build', 'render', 'visualize',
    'draw me', 'paint me', 'sketch me', 'illustrate me', 'design me',
    // Combined patterns
    'show me an image', 'show me a image', 'show me image',
    'show me a picture', 'show me an picture', 'show me picture',
    'give me an image', 'give me a image', 'give me image',
    'give me a picture', 'give me an picture', 'give me picture',
  ];
  
  // Arabic keywords (transliterated and Arabic script)
  const arabicKeywords = [
    'ارسم', 'صورة', 'أنشئ صورة', 'اصنع صورة', 'رسم', 'صورة ل', 'ارسم صورة', 
    'أنشئ', 'اصنع', 'صورة من', 'ارسم لي', 'أنشئ لي صورة', 'اصنع لي صورة',
    'أريد صورة', 'أحتاج صورة', 'أعطني صورة', 'أظهر لي صورة',
    // More flexible patterns (without requiring "صورة")
    'أنشئ لي', 'اصنع لي', 'ارسم لي', 'أنشئ ل', 'اصنع ل', 'ارسم ل',
    'أنشئ لي', 'اصنع لي', 'ارسم لي', 'أنشئ لنا', 'اصنع لنا', 'ارسم لنا',
    'هل يمكنك أنشئ', 'هل يمكنك اصنع', 'هل يمكنك ارسم',
    'من فضلك أنشئ', 'من فضلك اصنع', 'من فضلك ارسم',
    'أريد أنشئ', 'أريد اصنع', 'أريد ارسم',
    'أحتاج أنشئ', 'أحتاج اصنع', 'أحتاج ارسم'
  ];
  
  // Expanded multilingual patterns - using any similar action word with any image-related word
  const multilingualPatterns = [
    // Action verbs + image words
    /(generate|create|make|draw|paint|design|produce|craft|build|render|visualize|sketch|illustrate|construct|develop|form|fabricate).*(image|picture|photo|drawing|art|artwork|illustration|sketch|painting|graphic|visual)/i,
    // Image words + action verbs (reversed order)
    /(image|picture|photo|drawing|art|artwork|illustration|sketch|painting|graphic|visual).*(generate|create|make|draw|paint|design|produce|craft|build|render|visualize|sketch|illustrate)/i,
    // With "for me" / "me" / indirect requests (more flexible - doesn't require "image" word)
    /(want|need|like|wish|desire|request|ask for|would like).*(an? )?(image|picture|photo|drawing|art|artwork|illustration|sketch|painting|flag|logo|icon|graphic|visual)/i,
    /(can|could|will|would|please|show|give|get).*(you|u).*(generate|create|make|draw|paint|design|produce|craft|build|render|visualize|sketch|illustrate).*(an? )?(image|picture|photo|drawing|art|artwork|illustration|flag|logo|icon|graphic|visual)/i,
    /(make|create|generate|draw|paint|design).*(me|for me).*(an? )?(image|picture|photo|drawing|art|artwork|illustration|flag|logo|icon|graphic|visual)/i,
    // "create for me" pattern (catches "create for me the flag of..." without requiring "image")
    /(create|make|generate|draw|design).*(for me|me).*(the|a|an)/i,
    // Arabic patterns - more comprehensive
    /(صورة|رسم|أنشئ|اصنع|ارسم)/,
    // Arabic "create for me" patterns (catches "أنشئ لي العلم" without requiring "صورة")
    /(أنشئ|اصنع|ارسم|صمم|رسم).*(لي|لنا|ل|من فضلك)/,
    // Arabic "can you create" patterns
    /(هل يمكنك|هل تقدر|من الممكن).*(أنشئ|اصنع|ارسم|صمم|رسم)/,
    // Arabic "I want/need" patterns
    /(أريد|أحتاج|أطلب).*(أنشئ|اصنع|ارسم|صمم|رسم|صورة)/, 
    // Spanish
    /(imagen|crear|generar|dibujar|diseñar|hacer|pintar)/i, 
    // French
    /(image|créer|générer|dessiner|faire|peindre|concevoir)/i, 
    // German
    /(bild|erstellen|generieren|zeichnen|malen|entwerfen|herstellen)/i, 
    // Italian
    /(immagine|creare|generare|disegnare|fare|dipingere|progettare)/i, 
    // Russian
    /(изображение|создать|нарисовать|сгенерировать|сделать|нарисовать)/i, 
    // Japanese
    /(画像|作成|生成|描画|作成する|生成する|描く)/, 
    // Chinese
    /(图像|图片|创建|生成|绘制|制作|设计)/,
  ];
  
  // Check English keywords
  const isEnglishRequest = englishKeywords.some(keyword => lowerText.includes(keyword));
  
  // Check Arabic keywords (preserve original case for Arabic)
  const isArabicRequest = arabicKeywords.some(keyword => text.includes(keyword));
  
  // Check multilingual patterns
  const isMultilingualRequest = multilingualPatterns.some(pattern => pattern.test(text));
  
  const isImageRequest = isEnglishRequest || isArabicRequest || isMultilingualRequest;
  
  // Enhanced logging for debugging
  if (isImageRequest) {
    console.log('🎨 Image generation request detected:', {
      isEnglishRequest,
      isArabicRequest,
      isMultilingualRequest,
      text: text.substring(0, 100),
      matchedKeywords: isEnglishRequest ? englishKeywords.filter(k => lowerText.includes(k)).slice(0, 3) : [],
      matchedPatterns: isMultilingualRequest ? multilingualPatterns.filter(p => p.test(text)).length : 0
    });
  }
  
  return isImageRequest;
}

// Replicate SDK 1.4+ returns FileOutput (ReadableStream with .url()) for model files
function extractUrlFromReplicateOutput(item) {
  if (!item) return null;
  if (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) {
    return item;
  }
  if (typeof item.url === 'function') {
    try {
      const u = item.url();
      if (u && typeof u.href === 'string') return u.href;
      return u ? String(u) : null;
    } catch (e) {
      console.warn('⚠️ Replicate FileOutput.url() failed:', e.message);
    }
  }
  if (typeof item === 'object') {
    const possibleUrl = item.url || item.image || item.image_url || item.imageUrl || item.output;
    if (typeof possibleUrl === 'string' && (possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://'))) {
      return possibleUrl;
    }
  }
  return null;
}

// Helper function to check if error is quota-related
// Helper function to detect Groq quota errors
function isGroqQuotaError(error) {
  if (!error) return false;
  
  const errorMessage = error.message || error.toString() || '';
  const errorCode = error.status || error.code || '';
  const errorResponse = error.response || {};
  const errorData = errorResponse.data || {};
  
  // Check error code
  if (errorCode === 429 || errorCode === 'rate_limit_exceeded' || errorCode === 'quota_exceeded') {
    return true;
  }
  
  // Check error message
  if (errorMessage.includes('429') || 
      errorMessage.includes('rate limit') || 
      errorMessage.includes('quota') ||
      errorMessage.includes('Too Many Requests') ||
      errorMessage.includes('rate_limit_exceeded')) {
    return true;
  }
  
  // Check nested error object (common in Groq API responses)
  if (errorData.error) {
    const nestedError = errorData.error;
    if (nestedError.code === 429 || 
        nestedError.code === 'rate_limit_exceeded' ||
        nestedError.message?.includes('429') ||
        nestedError.message?.includes('rate limit') ||
        nestedError.message?.includes('quota')) {
      return true;
    }
  }
  
  return false;
}

function isQuotaError(error) {
  if (!error) return false;
  
  const errorMessage = (error.message || '').toLowerCase();
  const errorString = JSON.stringify(error).toLowerCase();
  const errorName = (error.name || '').toLowerCase();
  
  const quotaKeywords = [
    'quota',
    'quota exceeded',
    'rate limit',
    'rate limit exceeded',
    'token limit',
    'token limit exceeded',
    'resource exhausted',
    '429',
    'too many requests',
    'billing',
    'quotaexceeded',
    'ratelimitexceeded',
    'permission denied',
    'api key not valid',
    'invalid api key'
  ];
  
  // Check error message, name, and stringified error
  for (const keyword of quotaKeywords) {
    if (errorMessage.includes(keyword) || errorString.includes(keyword) || errorName.includes(keyword)) {
      console.log(`🔍 Quota keyword detected: "${keyword}"`);
      return true;
    }
  }
  
  // Check for HTTP status codes
  if (error.status === 429 || error.statusCode === 429) {
    return true;
  }
  
  // Check error response structure (Gemini API might nest errors)
  if (error.response) {
    if (error.response.status === 429 || error.response.statusCode === 429) {
      return true;
    }
    // Check nested error message
    const responseMessage = JSON.stringify(error.response).toLowerCase();
    for (const keyword of quotaKeywords) {
      if (responseMessage.includes(keyword)) {
        return true;
      }
    }
  }
  
  // Check for Gemini API specific error structure
  if (error.cause) {
    const causeString = JSON.stringify(error.cause).toLowerCase();
    for (const keyword of quotaKeywords) {
      if (causeString.includes(keyword)) {
        return true;
      }
    }
  }
  
  return false;
}

// Helper function to generate content with multiple API keys (fallback on quota errors)
// Tries keys in sequence if quota exceeded
async function generateWithMultipleKeys(genAIInstances, conversationContext, timeoutMs, maxRetries = 2) {
  let lastError;
  
  // Try each API key in sequence
  for (let keyIndex = 0; keyIndex < genAIInstances.length; keyIndex++) {
    const genAIInstance = genAIInstances[keyIndex];
    // Note: googleSearchRetrieval requires paid tier - will fail silently on free tier
    // Remove tools parameter if it causes errors on free tier
    const model = genAIInstance.getGenerativeModel({ 
      model: 'gemini-2.5-flash'
      // tools: [{ googleSearchRetrieval: {} }] - Disabled: requires paid tier
    });
    
    console.log(`🔑 Trying API key ${keyIndex + 1}/${genAIInstances.length}...`);
    
    try {
      const result = await generateWithTimeout(model, conversationContext, timeoutMs, maxRetries);
      if (keyIndex > 0) {
        console.log(`✅ Successfully used fallback key ${keyIndex + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      
      // If quota error and we have more keys to try, continue to next key
      if (isQuotaError(error) && keyIndex < genAIInstances.length - 1) {
        console.log(`⚠️ Quota exceeded on key ${keyIndex + 1}, trying fallback key ${keyIndex + 2}...`);
        continue; // Try next key
      }
      
      // If not quota error or last key, throw the error
      throw error;
    }
  }
  
  // All keys exhausted
  throw lastError || new Error('All API keys exhausted');
}

// Helper function to detect Groq quota errors
function isGroqQuotaError(error) {
  if (!error) return false;
  
  const errorMessage = error.message || error.toString() || '';
  const errorCode = error.status || error.code || '';
  const errorResponse = error.response || {};
  const errorData = errorResponse.data || {};
  
  // Check error code
  if (errorCode === 429 || errorCode === 'rate_limit_exceeded' || errorCode === 'quota_exceeded') {
    return true;
  }
  
  // Check error message
  if (errorMessage.includes('429') || 
      errorMessage.includes('rate limit') || 
      errorMessage.includes('quota') ||
      errorMessage.includes('Too Many Requests') ||
      errorMessage.includes('rate_limit_exceeded')) {
    return true;
  }
  
  // Check nested error object (common in Groq API responses)
  if (errorData.error) {
    const nestedError = errorData.error;
    if (nestedError.code === 429 || 
        nestedError.code === 'rate_limit_exceeded' ||
        nestedError.message?.includes('429') ||
        nestedError.message?.includes('rate limit') ||
        nestedError.message?.includes('quota')) {
      return true;
    }
  }
  
  return false;
}

// Helper function for voice messages: Try Gemini native audio first, fallback to Whisper + Groq
async function generateVoiceWithGeminiNativeAudio(
  genAIInstances,
  groqInstances,
  audioBuffer,
  audioMimeType,
  conversationHistory = [],
  systemPrompt = '',
  timeoutMs = 300000,
  maxRetries = 2
) {
  // Try Gemini native audio first (Tier 1 & 2)
  for (let keyIndex = 0; keyIndex < genAIInstances.length; keyIndex++) {
    const genAIInstance = genAIInstances[keyIndex];
    const model = genAIInstance.getGenerativeModel({ 
      model: 'gemini-2.5-flash'
    });
    
    console.log(`🎤 Trying Gemini native audio API key ${keyIndex + 1}/${genAIInstances.length}...`);
    
    try {
      // Convert audio buffer to base64
      const audioBase64 = audioBuffer.toString('base64');
      
      // Normalize MIME type for Gemini (accepts: audio/mp3, audio/wav, audio/webm, etc.)
      let geminiMimeType = audioMimeType;
      if (audioMimeType.includes('ogg') || audioMimeType.includes('opus')) {
        // Convert OGG to a format Gemini accepts - try webm or mp3
        // Note: Gemini may not support OGG directly, but we'll try
        geminiMimeType = 'audio/webm';
      }
      
      // Build conversation context with history
      let conversationContext = systemPrompt || 'You are a helpful AI assistant. Be friendly, professional, and helpful. Answer questions on any topic the user asks about.\n\n';
      
      if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
        conversationHistory.forEach((msg) => {
          conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
        });
      }
      
      // Create parts array with text prompt and audio
      const parts = [
        { text: conversationContext },
        {
          inlineData: {
            mimeType: geminiMimeType,
            data: audioBase64
          }
        }
      ];
      
      // Try to generate with native audio
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Gemini native audio API request timeout')), timeoutMs)
      );
      
      const generatePromise = model.generateContent({ contents: [{ parts }] });
      const result = await Promise.race([generatePromise, timeoutPromise]);
      const response = await result.response;
      
      // Extract transcribed text and response from Gemini
      // Gemini with audio returns both transcription and response
      const fullText = response.text();
      
      // Try to extract just the response (Gemini might include transcription)
      // For now, return the full text - Gemini handles this intelligently
      if (keyIndex > 0) {
        console.log(`✅ Successfully used Gemini fallback key ${keyIndex + 1} with native audio`);
      } else {
        console.log(`✅ Successfully used Gemini native audio (key ${keyIndex + 1})`);
      }
      
      return {
        response: {
          text: () => fullText
        },
        transcribedText: '', // Gemini handles transcription internally, we'll extract if needed
        usedNativeAudio: true
      };
      
    } catch (error) {
      console.log(`⚠️ Gemini native audio failed on key ${keyIndex + 1}:`, error.message);
      
      // If quota error and we have more Gemini keys, continue
      if (isQuotaError(error) && keyIndex < genAIInstances.length - 1) {
        console.log(`⚠️ Gemini quota exceeded, trying next key...`);
        continue;
      }
      
      // If quota error and no more Gemini keys, break to try Whisper + Groq
      if (isQuotaError(error)) {
        console.log(`⚠️ All Gemini keys exhausted, falling back to Whisper + Groq...`);
        break;
      }
      
      // For non-quota errors, try next key first before falling back
      if (keyIndex < genAIInstances.length - 1) {
        continue;
      }
      
      // If last key failed with non-quota error, fall back to Whisper + Groq
      console.log(`⚠️ Gemini native audio failed, falling back to Whisper + Groq...`);
      break;
    }
  }
  
  // Fallback: Use Whisper to transcribe, then Groq for response
  console.log('🔄 Falling back to Whisper transcription + Groq...');
  throw new Error('FALLBACK_TO_WHISPER_GROQ'); // Special error to trigger fallback
}

// Unified helper function for 4-tier fallback: Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3
async function generateWithUnifiedFallback(
  genAIInstances, 
  groqInstances, 
  conversationContext, 
  conversationHistory = [],
  timeoutMs = 60000, 
  maxRetries = 2
) {
  let lastError;
  
  // Tier 1 & 2: Try Gemini keys first
  for (let keyIndex = 0; keyIndex < genAIInstances.length; keyIndex++) {
    const genAIInstance = genAIInstances[keyIndex];
    const model = genAIInstance.getGenerativeModel({ 
      model: 'gemini-2.5-flash'
    });
    
    console.log(`🔑 Trying Gemini API key ${keyIndex + 1}/${genAIInstances.length}...`);
    
    try {
      const result = await generateWithTimeout(model, conversationContext, timeoutMs, maxRetries);
      if (keyIndex > 0) {
        console.log(`✅ Successfully used Gemini fallback key ${keyIndex + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      
      // If quota error and we have more Gemini keys to try, continue
      if (isQuotaError(error) && keyIndex < genAIInstances.length - 1) {
        console.log(`⚠️ Gemini quota exceeded on key ${keyIndex + 1}, trying Gemini fallback key ${keyIndex + 2}...`);
        continue;
      }
      
      // If quota error and no more Gemini keys, break to try Groq
      if (isQuotaError(error)) {
        console.log(`⚠️ All Gemini keys exhausted, trying Groq fallback keys...`);
        break;
      }
      
      // If not quota error but we have more Gemini keys, try next key
      if (keyIndex < genAIInstances.length - 1) {
        console.log(`⚠️ Gemini error on key ${keyIndex + 1} (${error.message}), trying Gemini fallback key ${keyIndex + 2}...`);
        continue;
      }
      
      // If last Gemini key failed with non-quota error, try Groq fallback
      console.log(`⚠️ All Gemini keys failed, trying Groq fallback keys...`);
      break;
    }
  }
  
  // Tier 3 & 4: Try Groq keys if Gemini keys exhausted
  if (groqInstances.length > 0) {
    // Convert conversation context to Groq messages format
    const messages = [];
    
    // Extract system prompt (usually at the start of conversationContext)
    const systemPromptMatch = conversationContext.match(/^(.*?)(?:Conversation history:|User:|Current)/s);
    if (systemPromptMatch) {
      messages.push({
        role: 'system',
        content: systemPromptMatch[1].trim()
      });
    } else {
      // Fallback: use first part as system prompt
      const firstPart = conversationContext.split('\n\n')[0];
      if (firstPart) {
        messages.push({
          role: 'system',
          content: firstPart.trim()
        });
      }
    }
    
    // Add conversation history if available
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      conversationHistory.forEach(msg => {
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          });
        }
      });
    } else {
      // Parse from conversationContext string - extract User/Assistant pairs
      const lines = conversationContext.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('User:')) {
          const content = line.replace(/^User:\s*/, '').trim();
          if (content) {
            messages.push({ role: 'user', content });
          }
        } else if (line.trim().startsWith('Assistant:')) {
          const content = line.replace(/^Assistant:\s*/, '').trim();
          if (content) {
            messages.push({ role: 'assistant', content });
          }
        }
      }
    }
    
    // Extract current user message (usually last "User:" in conversationContext)
    const userMessageMatch = conversationContext.match(/User:\s*([^\n]+)(?:\s*Assistant:|$)/s);
    if (userMessageMatch && !messages.find(m => m.role === 'user' && m.content === userMessageMatch[1].trim())) {
      messages.push({
        role: 'user',
        content: userMessageMatch[1].trim()
      });
    }
    
    // If no messages added yet, add the whole context as user message
    if (messages.length === 1 || (messages.length === 1 && messages[0].role === 'system')) {
      const lastUserMatch = conversationContext.split('User:').pop();
      if (lastUserMatch) {
        const userContent = lastUserMatch.split('Assistant:')[0].trim();
        if (userContent) {
          messages.push({
            role: 'user',
            content: userContent
          });
        }
      }
    }
    
    // Try each Groq key
    for (let keyIndex = 0; keyIndex < groqInstances.length; keyIndex++) {
      const groqInstance = groqInstances[keyIndex];
      
      console.log(`🔑 Trying Groq API key ${keyIndex + 1}/${groqInstances.length} (Fallback${keyIndex + 2})...`);
      
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Groq API request timeout')), timeoutMs)
        );
        
        const apiPromise = groqInstance.chat.completions.create({
          messages: messages,
          model: 'llama-3.3-70b-versatile',
          temperature: 0.7,
          max_tokens: 2048,
        });
        
        const completion = await Promise.race([apiPromise, timeoutPromise]);
        
        console.log(`✅ Successfully used Groq fallback key ${keyIndex + 1} (Fallback${keyIndex + 2})`);
        
        // Convert Groq response to Gemini-like format for compatibility
        return {
          response: {
            text: () => completion.choices[0]?.message?.content || ''
          }
        };
      } catch (error) {
        lastError = error;
        
        // If quota error and we have more Groq keys to try, continue
        if (isGroqQuotaError(error) && keyIndex < groqInstances.length - 1) {
          console.log(`⚠️ Groq quota exceeded on key ${keyIndex + 1}, trying Groq fallback key ${keyIndex + 2}...`);
          continue;
        }
        
        // If not quota error but we have more Groq keys, try next key
        if (keyIndex < groqInstances.length - 1) {
          console.log(`⚠️ Groq error on key ${keyIndex + 1} (${error.message}), trying Groq fallback key ${keyIndex + 2}...`);
          continue;
        }
        
        // If last Groq key failed, throw the error
        throw error;
      }
    }
  }
  
  // All keys exhausted
  throw lastError || new Error('All API keys exhausted (Gemini and Groq)');
}

// Helper function to generate content with proper timeout handling and retry logic
// FIXED: Properly handles memory leaks by tracking and ignoring results after timeout
async function generateWithTimeout(model, conversationContext, timeoutMs, maxRetries = 2) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timeoutId;
    let isTimedOut = false;
    let pendingPromise = null;
    
    try {
      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          isTimedOut = true;
          console.log(`⏱️ API request timeout after ${timeoutMs / 1000} seconds (attempt ${attempt + 1}/${maxRetries + 1})`);
          reject(new Error(`API request timeout after ${timeoutMs / 1000} seconds`));
        }, timeoutMs);
      });

      // Start the API call
      pendingPromise = model.generateContent(conversationContext);
      
      // Race between API call and timeout
      const result = await Promise.race([pendingPromise, timeoutPromise]);
      
      // Clear timeout if API call completed first
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // If we timed out, ignore the result (even if it arrives later)
      if (isTimedOut) {
        // Result arrived after timeout - ignore it to prevent memory leak
        pendingPromise.catch(() => {}); // Silently ignore any errors from abandoned promise
        throw new Error(`API request timeout after ${timeoutMs / 1000} seconds`);
      }
      
      // Success - return result
      if (attempt > 0) {
        console.log(`✅ Request succeeded on attempt ${attempt + 1}`);
      }
      return result;
      
    } catch (error) {
      // Ensure timeout is cleared on error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // If timeout occurred, ensure we ignore any pending promise results
      if (isTimedOut && pendingPromise) {
        // Mark promise as ignored to prevent memory leak
        pendingPromise.catch(() => {}); // Silently ignore errors from abandoned promise
      }
      
      lastError = error;
      
      // Don't retry on quota errors
      if (isQuotaError(error)) {
        throw error;
      }
      
      // Don't retry on last attempt
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.log(`⚠️ Request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
    }
  }
  
  // All retries exhausted
  throw lastError || new Error('Unknown error occurred');
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'AI Studio Backend is running',
    services: {
      gemini: genAI ? 'Configured ✓' : 'Not configured ✗',
      geminiBlog: genAIBlogInstances.length > 0 ? `Configured ✓ (${genAIBlogInstances.length} key(s))` : 'Not configured ✗',
      geminiSocial: genAISocialInstances.length > 0 ? `Configured ✓ (${genAISocialInstances.length} key(s))` : 'Not configured ✗',
      geminiPrompt: genAIPromptInstances.length > 0 ? `Configured ✓ (${genAIPromptInstances.length} key(s))` : 'Not configured ✗',
      geminiVoice: genAIVoiceInstances.length > 0 ? `Configured ✓ (${genAIVoiceInstances.length} key(s))` : 'Not configured ✗',
      geminiAutomation: genAIAutomationInstances.length > 0 ? `Configured ✓ (${genAIAutomationInstances.length} key(s))` : 'Not configured ✗',
      geminiAutomationInsight: genAIAutomationInsightInstances.length > 0 ? `Configured ✓ (${genAIAutomationInsightInstances.length} key(s))` : 'Not configured ✗',
      openai: openai ? 'Configured ✓' : 'Not configured ✗'
    }
  });
});

// ============================================
// AI CHAT ENDPOINT (Gemini)
// ============================================
app.post('/api/ai/chat', async (req, res) => {
  console.log('📨 Received chat request:', { message: req.body.message?.substring(0, 50), hasHistory: req.body.conversationHistory?.length > 0 });
  const { message, conversationHistory = [] } = req.body;

  if (!message) {
    console.log('❌ Missing message in request');
    return res.status(400).json({ error: 'Message is required' });
  }

  // Validate conversationHistory is an array
  if (!Array.isArray(conversationHistory)) {
    console.log('❌ Invalid conversationHistory format');
    return res.status(400).json({ error: 'conversationHistory must be an array' });
  }

  if (genAIChatInstances.length === 0) {
    console.log('❌ Gemini API not configured');
    return res.status(500).json({ error: 'Gemini API not configured. Please set GEMINI_API_KEY in .env file' });
  }

  try {
    console.log('🤖 Calling Gemini API...');

    // Build conversation context
    // CRITICAL: Detect language of current user message and instruct AI to respond in same language
    const detectMessageLanguage = (text) => {
      if (!text || text.trim().length === 0) return 'English';
      const arabicPattern = /[\u0600-\u06FF\u0750-\u077F]/;
      // Check if message contains Arabic characters
      const hasArabic = arabicPattern.test(text);
      console.log('🌐 Language detection:', { hasArabic, messagePreview: text.substring(0, 50) });
      return hasArabic ? 'Arabic' : 'English';
    };
    const currentMessageLanguage = detectMessageLanguage(message);
    const isArabic = currentMessageLanguage === 'Arabic';
    
    // CRITICAL: Limit conversation history to only recent messages to prevent language confusion
    // Only include last 2-3 exchanges to keep context fresh
    // FILTER OUT ARABIC MESSAGES if current message is in English to prevent language confusion
    let recentHistory = conversationHistory.slice(-6); // Last 6 messages (3 exchanges)
    
    // If current message is English, filter out Arabic messages from history
    if (!isArabic) {
      const arabicPattern = /[\u0600-\u06FF\u0750-\u077F]/;
      recentHistory = recentHistory.filter(msg => {
        const hasArabic = arabicPattern.test(msg.content || '');
        return !hasArabic; // Only keep non-Arabic messages
      });
    }
    
    // Build conversation context - Keep it completely general, no InfiNet-specific instructions
    let conversationContext = `You are a helpful AI assistant. Be friendly, professional, and helpful. Answer questions on any topic the user asks about. Do not limit yourself to any specific services or products unless the user specifically asks about them.\n\n`;
    
    // CRITICAL: Add language instruction at the START to set the tone
    if (isArabic) {
      conversationContext += `LANGUAGE RULE: The user's current message is in Arabic. You MUST respond in Arabic (العربية) only. Even if previous messages were in English, respond in Arabic.\n\nFORMATTING RULE: When responding in Arabic, do NOT use markdown formatting (no asterisks *, no bold **, no italic _). Write plain Arabic text only. Arabic text should be clean and readable without any formatting symbols.\n\n`;
    } else {
      conversationContext += `LANGUAGE RULE: The user's current message is in English. You MUST respond in English ONLY. Do NOT use Arabic (العربية) at all. The current message language is English, so you MUST respond in English.\n\n`;
    }
    
    // Add only recent conversation history (filtered to prevent language confusion)
    if (recentHistory.length > 0) {
      recentHistory.forEach((msg) => {
        conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
      });
    }
    
    // CRITICAL: Add strong language instruction RIGHT BEFORE the current message
    // This gives it maximum weight and ensures AI follows it
    if (isArabic) {
      conversationContext += `CRITICAL REMINDER: The user's message below is in Arabic. You MUST respond ONLY in Arabic (العربية). Do not use English. Ignore any English in the conversation history above.\n\n`;
    } else {
      conversationContext += `CRITICAL REMINDER: The user's message below is in English. You MUST respond ONLY in English. Do NOT use Arabic (العربية) at all. Even if you see Arabic anywhere, respond in English because the current message is in English. RESPOND IN ENGLISH ONLY.\n\n`;
    }
    
    conversationContext += `User: ${message}\n\nAssistant:`;

    // Use 4-tier unified fallback (Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3)
    const result = await generateWithUnifiedFallback(genAIChatInstances, groqChatInstances, conversationContext, conversationHistory, 60000);
    const response = await result.response;
    const aiResponse = response.text();
    console.log('✅ AI response received:', aiResponse.substring(0, 50));

    res.json({
      response: aiResponse,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('AI Chat Error:', error);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      status: error.status,
      statusCode: error.statusCode,
      code: error.code,
      response: error.response,
      stack: error.stack?.substring(0, 200)
    });
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // Check for timeout errors
    if (error.message && (error.message.includes('timeout') || error.message.includes('Timeout'))) {
      console.log('⏱️ Timeout error detected');
      return res.status(408).json({ 
        error: 'Request timeout', 
        message: 'Request timed out. Please try again.'
      });
    }
    
    // Check for network errors
    if (error.message && (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND'))) {
      console.log('🌐 Network error detected');
      return res.status(503).json({ 
        error: 'Service unavailable', 
        message: 'Unable to connect to AI service. Please try again later.'
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to generate response', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// ============================================
// AI CHAT HISTORY ENDPOINTS
// ============================================
// GET /api/ai/chat/history - Fetch AI chat history
app.get('/api/ai/chat/history', async (req, res) => {
  try {
    const { limit = 50, reset } = req.query;

    // For ai-studio-backend, we return empty array since chat history is managed client-side
    // The mobile app stores chat history locally and sends conversationHistory in requests
    if (reset === 'true') {
      // Return welcome message after reset
      return res.json({
        messages: [{
          id: `msg-${Date.now()}-welcome`,
          sender: 'assistant',
          content: "Hi! I'm your InfiNet AI Assistant — ask me anything.",
          timestamp: new Date().toISOString()
        }],
        timestamp: new Date().toISOString()
      });
    }

    // Return empty array - mobile app manages history locally
    // This endpoint exists for compatibility but doesn't store server-side history
    res.json({
      messages: [],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI chat history fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch AI chat history' });
  }
});

// POST /api/ai/chat/message - Save AI chat message (for compatibility, but not stored server-side)
app.post('/api/ai/chat/message', async (req, res) => {
  try {
    // This endpoint exists for compatibility with the mobile app
    // ai-studio-backend doesn't store chat history server-side
    // The mobile app stores messages locally in AsyncStorage
    res.json({ 
      success: true,
      message: 'Message received (stored client-side)'
    });
  } catch (error) {
    console.error('AI chat message save error:', error);
    res.status(500).json({ error: 'Failed to save chat message' });
  }
});

// ============================================
// CONTENT GENERATION RATE LIMITING
// ============================================
// Rate limiting storage: Map<userId, { dalleCount: number, replicateCount: number, blogCount: number, socialCount: number, promptCount: number, date: string }>
const contentRateLimits = new Map();

// Daily limits
const DAILY_DALLE_LIMIT = 5;
const DAILY_REPLICATE_LIMIT = 5;
const DAILY_BLOG_LIMIT = 5;
const DAILY_SOCIAL_LIMIT = 5;
const DAILY_PROMPT_LIMIT = 5;
const DAILY_AUTOMATION_SUGGESTIONS_LIMIT = 5;
const DAILY_AUTOMATION_PLAYBOOK_LIMIT = 5;

// Get user identifier (from Authorization header or IP address)
// Decode JWT token payload (without verification - for rate limiting purposes)
function decodeJWT(token) {
  try {
    // JWT format: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null; // Not a valid JWT format
    }
    
    // Decode payload (second part) - JWT uses base64url encoding
    let payload = parts[1];
    // Convert base64url to base64 (replace - with +, _ with /, add padding)
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padLength = (4 - payload.length % 4) % 4;
    payload = payload + '='.repeat(padLength);
    
    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (error) {
    return null; // Failed to decode
  }
}

// Cache for token to user ID mapping (to avoid repeated API calls)
const tokenToUserIdCache = new Map();
const TOKEN_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getUserIdentifier(req) {
  // Try to get user ID from Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    // Extract token (remove "Bearer " prefix if present)
    const token = authHeader.replace(/^Bearer\s+/i, '');
    
    // Check cache first
    const cached = tokenToUserIdCache.get(token);
    if (cached && (Date.now() - cached.timestamp) < TOKEN_CACHE_TTL) {
      console.log(`🔑 User identified by cached token: user_${cached.userId}`);
      return `user_${cached.userId}`;
    }
    
    // Try to decode JWT to get user ID or email
    const decoded = decodeJWT(token);
    if (decoded) {
      // Prefer user ID, then email, then fallback to token
      const userId = decoded.id || decoded.userId || decoded.sub || decoded.email || null;
      if (userId) {
        // Cache the result
        tokenToUserIdCache.set(token, { userId, timestamp: Date.now() });
        // Clean up old cache entries (keep only last 1000 entries)
        if (tokenToUserIdCache.size > 1000) {
          const oldestToken = tokenToUserIdCache.keys().next().value;
          tokenToUserIdCache.delete(oldestToken);
        }
        console.log(`🔑 User identified by JWT: user_${userId}`);
        return `user_${userId}`;
      }
    }
    
    // If JWT decode failed, use token as identifier (will be consistent for same token)
    // Note: This means if token changes, it will be treated as different user
    // But if token is stable (same session), it will work correctly
    console.log(`🔑 User identified by token: user_${token.substring(0, 20)}...`);
    return `user_${token}`;
  }
  // Fallback to IP address
  const ip = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const userId = `ip_${ip}`;
  console.log(`🌐 User identified by IP: ${userId}`);
  return userId;
}

// Get today's date string (YYYY-MM-DD) for daily reset
function getTodayDateString() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

// Get IP address from request
function getIPAddress(req) {
  return req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

// Check rate limit (without incrementing) - checks both user ID and IP address
// type: 'dalle' | 'replicate' | 'blog' | 'social' | 'prompt' | 'automation-suggestions' | 'automation-playbook'
function checkRateLimit(userId, type, ipAddress = null) {
  const today = getTodayDateString();
  
  // Check user ID limit (authenticated users use 'user_' prefix; WhatsApp uses 'whatsapp_' prefix)
  if (userId && (userId.startsWith('user_') || userId.startsWith('whatsapp_'))) {
    const userLimit = contentRateLimits.get(userId);
    
    // Initialize or reset if it's a new day
    if (!userLimit || userLimit.date !== today) {
      contentRateLimits.set(userId, {
        dalleCount: 0,
        replicateCount: 0,
        blogCount: 0,
        socialCount: 0,
        promptCount: 0,
        automationSuggestionsCount: 0,
        automationPlaybookCount: 0,
        date: today
      });
    }
    
    const currentLimit = contentRateLimits.get(userId);
    
    // Check user limit based on type
    if (type === 'replicate' && currentLimit.replicateCount >= DAILY_REPLICATE_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 image-to-image generations. You can generate more images tomorrow!"
      };
    } else if (type === 'dalle' && currentLimit.dalleCount >= DAILY_DALLE_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 DALL-E images. You can generate more images tomorrow!"
      };
    } else if (type === 'blog' && currentLimit.blogCount >= DAILY_BLOG_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 blog posts. You can generate more tomorrow!"
      };
    } else if (type === 'social' && currentLimit.socialCount >= DAILY_SOCIAL_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 social media posts. You can generate more tomorrow!"
      };
    } else if (type === 'prompt' && currentLimit.promptCount >= DAILY_PROMPT_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 prompts. You can generate more tomorrow!"
      };
    } else if (type === 'automation-suggestions' && currentLimit.automationSuggestionsCount >= DAILY_AUTOMATION_SUGGESTIONS_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 automation suggestions. You can generate more tomorrow!"
      };
    } else if (type === 'automation-playbook' && currentLimit.automationPlaybookCount >= DAILY_AUTOMATION_PLAYBOOK_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 automation playbooks. You can generate more tomorrow!"
      };
    }
  }
  
  // Check IP address limit (always check, prevents bypassing via new accounts on same IP)
  if (ipAddress && ipAddress !== 'unknown') {
    const ipId = `ip_${ipAddress}`;
    const ipLimit = contentRateLimits.get(ipId);
    
    // Initialize or reset if it's a new day
    if (!ipLimit || ipLimit.date !== today) {
      contentRateLimits.set(ipId, {
        dalleCount: 0,
        replicateCount: 0,
        blogCount: 0,
        socialCount: 0,
        promptCount: 0,
        automationSuggestionsCount: 0,
        automationPlaybookCount: 0,
        date: today
      });
    }
    
    const currentIPLimit = contentRateLimits.get(ipId);
    
    // Check IP limit based on type
    if (type === 'replicate' && currentIPLimit.replicateCount >= DAILY_REPLICATE_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 image-to-image generations. You can generate more images tomorrow!"
      };
    } else if (type === 'dalle' && currentIPLimit.dalleCount >= DAILY_DALLE_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 DALL-E images. You can generate more images tomorrow!"
      };
    } else if (type === 'blog' && currentIPLimit.blogCount >= DAILY_BLOG_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 blog posts. You can generate more tomorrow!"
      };
    } else if (type === 'social' && currentIPLimit.socialCount >= DAILY_SOCIAL_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 social media posts. You can generate more tomorrow!"
      };
    } else if (type === 'prompt' && currentIPLimit.promptCount >= DAILY_PROMPT_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 prompts. You can generate more tomorrow!"
      };
    } else if (type === 'automation-suggestions' && currentIPLimit.automationSuggestionsCount >= DAILY_AUTOMATION_SUGGESTIONS_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 automation suggestions. You can generate more tomorrow!"
      };
    } else if (type === 'automation-playbook' && currentIPLimit.automationPlaybookCount >= DAILY_AUTOMATION_PLAYBOOK_LIMIT) {
      return {
        allowed: false,
        message: "You've reached your daily limit of 5 automation playbooks. You can generate more tomorrow!"
      };
    }
  }
  
  return { allowed: true };
}

// Increment rate limit count after successful generation - increments both user ID and IP
// type: 'dalle' | 'replicate' | 'blog' | 'social' | 'prompt' | 'automation-suggestions' | 'automation-playbook'
function incrementRateLimit(userId, type, ipAddress = null) {
  const today = getTodayDateString();
  
  // Increment user ID limit (authenticated users use 'user_' prefix; WhatsApp uses 'whatsapp_' prefix)
  if (userId && (userId.startsWith('user_') || userId.startsWith('whatsapp_'))) {
    const userLimit = contentRateLimits.get(userId);
    
    // Initialize if doesn't exist (shouldn't happen, but safety check)
    if (!userLimit || userLimit.date !== today) {
      contentRateLimits.set(userId, {
        dalleCount: 0,
        replicateCount: 0,
        blogCount: 0,
        socialCount: 0,
        promptCount: 0,
        automationSuggestionsCount: 0,
        automationPlaybookCount: 0,
        date: today
      });
    }
    
    const currentLimit = contentRateLimits.get(userId);
    
    if (type === 'replicate') {
      currentLimit.replicateCount++;
    } else if (type === 'dalle') {
      currentLimit.dalleCount++;
    } else if (type === 'blog') {
      currentLimit.blogCount++;
    } else if (type === 'social') {
      currentLimit.socialCount++;
    } else if (type === 'prompt') {
      currentLimit.promptCount++;
    } else if (type === 'automation-suggestions') {
      currentLimit.automationSuggestionsCount++;
    } else if (type === 'automation-playbook') {
      currentLimit.automationPlaybookCount++;
    }
  }
  
  // Increment IP address limit (always increment to prevent bypassing via new accounts)
  if (ipAddress && ipAddress !== 'unknown') {
    const ipId = `ip_${ipAddress}`;
    const ipLimit = contentRateLimits.get(ipId);
    
    // Initialize if doesn't exist
    if (!ipLimit || ipLimit.date !== today) {
      contentRateLimits.set(ipId, {
        dalleCount: 0,
        replicateCount: 0,
        blogCount: 0,
        socialCount: 0,
        promptCount: 0,
        automationSuggestionsCount: 0,
        automationPlaybookCount: 0,
        date: today
      });
    }
    
    const currentIPLimit = contentRateLimits.get(ipId);
    
    if (type === 'replicate') {
      currentIPLimit.replicateCount++;
    } else if (type === 'dalle') {
      currentIPLimit.dalleCount++;
    } else if (type === 'blog') {
      currentIPLimit.blogCount++;
    } else if (type === 'social') {
      currentIPLimit.socialCount++;
    } else if (type === 'prompt') {
      currentIPLimit.promptCount++;
    } else if (type === 'automation-suggestions') {
      currentIPLimit.automationSuggestionsCount++;
    } else if (type === 'automation-playbook') {
      currentIPLimit.automationPlaybookCount++;
    }
  }
}

// Clean up old entries (older than 2 days) to prevent memory leaks
function cleanupOldRateLimits() {
  const today = getTodayDateString();
  const twoDaysAgo = new Date(today);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const twoDaysAgoString = twoDaysAgo.toISOString().split('T')[0];
  
  for (const [userId, limit] of contentRateLimits.entries()) {
    if (limit.date < twoDaysAgoString) {
      contentRateLimits.delete(userId);
    }
  }
}

// Clean up old entries every hour
setInterval(cleanupOldRateLimits, 60 * 60 * 1000);

// ============================================
// IMAGE GENERATION ENDPOINT (DALL-E)
// ============================================
app.post('/api/ai/image', async (req, res) => {
  const { prompt, style, size = '1024x1024', quality = 'standard', n = 1, image } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  if (!openai) {
    return res.status(500).json({ error: 'OpenAI API not configured. Please set OPENAI_API_KEY in .env file' });
  }

  // Check rate limit before processing (both user ID and IP address)
  const userId = getUserIdentifier(req);
  const ipAddress = getIPAddress(req);
  const isImageToImage = !!image;
  const imageType = isImageToImage ? 'replicate' : 'dalle';
  const rateLimitCheck = checkRateLimit(userId, imageType, ipAddress);
  
  if (!rateLimitCheck.allowed) {
    console.log(`🚫 Rate limit exceeded for user: ${userId}, type: ${imageType}`);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: rateLimitCheck.message
    });
  }
  
  console.log(`✅ Rate limit check passed for user: ${userId}, type: ${imageType}`);

  try {
    // Validate size
    const validSizes = ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'];
    if (!validSizes.includes(size)) {
      return res.status(400).json({ error: `Invalid size. Must be one of: ${validSizes.join(', ')}` });
    }

    // Validate quality (only for 1024x1024)
    const validQuality = ['standard', 'hd'];
    if (size === '1024x1024' && !validQuality.includes(quality)) {
      return res.status(400).json({ error: `Invalid quality. Must be one of: ${validQuality.join(', ')}` });
    }

    let imageUrl;

    // Image-to-image mode: Use Replicate for proper image-to-image transformation
    if (image) {
      try {
        // Security: Validate image upload for image-to-image
        const MAX_IMAGE_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
        const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
        
        // Decode base64 image if it's a data URL
        let imageBuffer;
        let imageBase64 = image;
        
        if (typeof image === 'string' && image.startsWith('data:image/')) {
          // Extract base64 part from data URL
          const base64Match = image.match(/^data:image\/\w+;base64,(.+)$/);
          if (base64Match && base64Match[1]) {
            imageBase64 = base64Match[1];
          }
        }
        
        // Decode base64 to buffer
        try {
          imageBuffer = Buffer.from(imageBase64, 'base64');
        } catch (decodeError) {
          return res.status(400).json({ error: 'Invalid image data. Must be valid base64 encoded image.' });
        }
        
        // Security: Validate image size
        if (imageBuffer.length > MAX_IMAGE_UPLOAD_SIZE) {
          const maxSizeMB = MAX_IMAGE_UPLOAD_SIZE / (1024 * 1024);
          return res.status(413).json({ error: `Image too large. Maximum size: ${maxSizeMB}MB for image-to-image uploads` });
        }
        
        // Security: Validate image content (check magic bytes)
        const isValidImage = (
          // JPEG signature
          (imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) ||
          // PNG signature
          (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) ||
          // WebP RIFF signature
          (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46)
        );
        
        if (!isValidImage) {
          return res.status(415).json({ error: 'Invalid image type. Only JPEG, PNG, and WebP images are allowed for image-to-image uploads.' });
        }
        
        if (!replicate) {
          throw new Error('Replicate API token not configured');
        }

        const sharp = require('sharp');
        
        // imageBuffer is already declared and validated above - use it here
        
        // Resize image to optimal size for nano-banana (1024x1024)
        const resizedImageBuffer = await sharp(imageBuffer)
          .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();
        
        // Replicate accepts both data URLs and Buffers - try Buffer first for better compatibility
        // Also create data URL as fallback
        const imageDataUrl = `data:image/png;base64,${resizedImageBuffer.toString('base64')}`;
        
        // For nano-banana image-to-image, the prompt should describe the transformation
        // Keep the original prompt but make it clear it's a transformation
        let cleanedPrompt = prompt.trim();
        
        // Ensure prompt explicitly references transforming the input image
        // nano-banana needs clear instructions about what to do with the uploaded image
        if (!cleanedPrompt.toLowerCase().includes('transform') && 
            !cleanedPrompt.toLowerCase().includes('convert') &&
            !cleanedPrompt.toLowerCase().includes('change') &&
            !cleanedPrompt.toLowerCase().includes('make')) {
          cleanedPrompt = `transform the image: ${cleanedPrompt}`;
        }
        
        // Build final prompt - be explicit about image-to-image transformation
        const finalPrompt = style && style.trim() 
          ? `${cleanedPrompt}, ${style} style` 
          : cleanedPrompt;
        
        console.log('🖼️ Image-to-image request (Replicate nano-banana):', { 
          hasImage: !!image, 
          originalPrompt: prompt.substring(0, 100), 
          cleanedPrompt: cleanedPrompt.substring(0, 100),
          style: style || 'none',
          finalPrompt: finalPrompt.substring(0, 150)
        });
        
        // Use Replicate google/nano-banana for image-to-image
        // nano-banana is specifically designed for image-to-image transformations
        console.log('🔄 Calling Replicate google/nano-banana for image-to-image...');
        
        try {
          // Use google/nano-banana for image-to-image transformations
          // According to Replicate docs: https://replicate.com/google/nano-banana/api
          // The parameter is 'image_input' (not 'image') and it expects an ARRAY of image URLs
          const rawOutput = await replicate.run(
            "google/nano-banana",
            {
              input: {
                prompt: finalPrompt,
                image_input: [imageDataUrl]  // Must be an array of image URLs/data URLs
              }
            }
          );
          
          console.log('📦 Replicate raw output:', rawOutput);
          console.log('📦 Raw output type:', typeof rawOutput, 'Is Array:', Array.isArray(rawOutput));

          let output = rawOutput;

          const fileOutputUrl =
            extractUrlFromReplicateOutput(rawOutput) ||
            (Array.isArray(rawOutput) && rawOutput.length > 0
              ? extractUrlFromReplicateOutput(rawOutput[0])
              : null);
          if (fileOutputUrl) {
            imageUrl = fileOutputUrl;
            console.log('✅ Replicate FileOutput URL:', imageUrl.substring(0, 100));
          }

          // Handle array containing ReadableStream (nano-banana returns [ReadableStream])
          if (Array.isArray(output) && output.length > 0) {
            const firstItem = output[0];
            if (firstItem && typeof firstItem.getReader === 'function') {
              console.log('📦 Replicate returned array with ReadableStream, reading...');
              output = firstItem; // Use the ReadableStream from array
            }
          }

          // Handle ReadableStream output (some Replicate runtimes stream the result)
          if (!imageUrl && output && typeof output.getReader === 'function') {
            console.log('📦 Replicate returned ReadableStream, reading...');
            const reader = output.getReader();
            const chunks = [];
            let done = false;

            while (!done) {
              const { value, done: streamDone } = await reader.read();
              done = streamDone;
              if (value) {
                chunks.push(value);
              }
            }

            // Combine all chunks into a single buffer
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const buffer = Buffer.concat(chunks, totalLength);
            
            console.log('📦 Stream data length:', buffer.length, 'bytes');
            console.log('📦 Stream data type: binary (image data)');

            // Check if it's binary image data (starts with image magic bytes)
            const isImageData = buffer[0] === 0xFF && buffer[1] === 0xD8 || // JPEG
                               buffer[0] === 0x89 && buffer[1] === 0x50 || // PNG
                               buffer[0] === 0x47 && buffer[1] === 0x49;    // GIF

            if (isImageData) {
              // Replicate returned the image directly as binary data
              // Upload it to a temporary URL or convert to data URL
              // For now, convert to base64 data URL
              const imageBase64 = buffer.toString('base64');
              const mimeType = buffer[0] === 0xFF && buffer[1] === 0xD8 ? 'image/jpeg' :
                              buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
              imageUrl = `data:${mimeType};base64,${imageBase64}`;
              console.log('✅ Converted binary image stream to base64 data URL');
            } else {
              // Try to parse as text/JSON
              const streamText = buffer.toString('utf8');
              try {
                const parsed = JSON.parse(streamText);
                output = parsed;
                console.log('📦 Parsed stream JSON output:', output);
              } catch (e) {
                // Not JSON - try URL extraction
                const urlMatch = streamText.match(/https?:\/\/[^\s"']+/);
                if (urlMatch) {
                  imageUrl = urlMatch[0];
                  console.log('✅ Extracted URL from stream text:', imageUrl.substring(0, 100));
                } else {
                  console.warn('⚠️ Stream is neither image data nor contains a URL');
                }
              }
            }
          }

          // Extract URL - Replicate returns array of URLs, a single URL string, or an object with output
          if (!imageUrl) {
            if (Array.isArray(output) && output.length > 0) {
              const firstItem = output[0];
              if (typeof firstItem === 'string' && (firstItem.startsWith('http://') || firstItem.startsWith('https://'))) {
                imageUrl = firstItem;
              } else {
                const fromFileOutput = extractUrlFromReplicateOutput(firstItem);
                if (fromFileOutput) {
                  imageUrl = fromFileOutput;
                } else if (firstItem && typeof firstItem === 'object') {
                  const possibleUrl = firstItem.url || firstItem.image || firstItem.image_url || firstItem.imageUrl || firstItem.output;
                  if (typeof possibleUrl === 'string' && (possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://'))) {
                    imageUrl = possibleUrl;
                  }
                }
              }
              if (!imageUrl) {
                console.log('⚠️ First array item is not a URL string:', typeof firstItem, firstItem);
              }
            } else if (typeof output === 'string' && (output.startsWith('http://') || output.startsWith('https://'))) {
              imageUrl = output;
            } else if (output && typeof output === 'object') {
              // Some models return { output: [url] } or { url: '...' }
              const possibleUrl =
                output.url ||
                output.image ||
                output.image_url ||
                output.imageUrl ||
                (Array.isArray(output.output) && output.output.length > 0 ? output.output[0] : output.output);

              if (typeof possibleUrl === 'string' && (possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://'))) {
                imageUrl = possibleUrl;
              }
            }
          }
          
          if (!imageUrl) {
            console.error('❌ Replicate returned invalid or unexpected format, no URL extracted:', output);
            throw new Error('Image-to-image generation failed. Please try again later.');
          }
          
          console.log('✅ Replicate success, image URL:', imageUrl.substring(0, 100));
        } catch (replicateError) {
          console.error('❌ Replicate error:', replicateError);
          console.error('❌ Replicate error details:', {
            message: replicateError?.message,
            name: replicateError?.name,
            status: replicateError?.status,
            statusCode: replicateError?.statusCode,
            code: replicateError?.code,
            response: replicateError?.response?.data,
            request: replicateError?.request?.data,
            stack: replicateError?.stack?.substring(0, 500)
          });
          
          // Preserve the original error message and status
          const errorMessage = replicateError?.message || 'Image-to-image generation failed. Please try again later.';
          const errorToThrow = new Error(errorMessage);
          if (replicateError?.status) errorToThrow.status = replicateError.status;
          if (replicateError?.statusCode) errorToThrow.statusCode = replicateError.statusCode;
          throw errorToThrow;
        }
        
      } catch (error) {
        console.error('❌ Replicate image-to-image error:', error);
        console.error('❌ Error details:', {
          message: error.message,
          name: error.name,
          status: error.status,
          statusCode: error.statusCode,
          code: error.code,
          statusText: error.statusText,
          response: error.response?.data,
          stack: error.stack?.substring(0, 500)
        });
        
        // Check for specific error types
        if (error.status === 402 || error.statusCode === 402 || error.message?.includes('402') || error.message?.includes('Payment Required')) {
          throw new Error('Replicate account payment issue. Please check your billing at replicate.com/account/billing');
        }
        
        if (error.message?.includes('ReadableStream') || error.message?.includes('stream')) {
          throw new Error('Replicate API returned unexpected format. Please try again or contact support.');
        }
        
        // Preserve the original error message for better debugging
        const errorMessage = error.message || 'Image-to-image generation failed. Please try again later.';
        const errorToThrow = new Error(errorMessage);
        if (error.status) errorToThrow.status = error.status;
        if (error.statusCode) errorToThrow.statusCode = error.statusCode;
        throw errorToThrow;
      }
    } else {
      // Text-to-image mode: GPT Image (DALL-E 3 deprecated on OpenAI API)
      const finalPrompt = style && style.trim() ? `${prompt}, style: ${style}` : prompt;
      const gptImageSizeMap = {
        '256x256': '1024x1024',
        '512x512': '1024x1024',
        '1024x1024': '1024x1024',
        '1792x1024': '1536x1024',
        '1024x1792': '1024x1536'
      };
      const gptSize = gptImageSizeMap[size] || '1024x1024';
      const gptQuality = quality === 'hd' ? 'high' : 'medium';

      const response = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: finalPrompt,
        n: 1,
        size: gptSize,
        quality: gptQuality
      });

      const item = response.data[0];
      if (item?.b64_json) {
        imageUrl = `data:image/png;base64,${item.b64_json}`;
      } else if (item?.url) {
        imageUrl = item.url;
      } else {
        throw new Error('OpenAI image API returned invalid response - no url or b64_json');
      }
    }

    // If imageUrl is still an HTTP URL (e.g. Replicate returned a URL), download and convert to data URL so it never expires
    if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
      try {
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const buffer = Buffer.from(imageResponse.data);
        const mimeType = buffer[0] === 0xFF && buffer[1] === 0xD8 ? 'image/jpeg' :
          buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : 'image/png';
        imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
        console.log('✅ Converted image URL to non-expiring data URL');
      } catch (downloadErr) {
        console.warn('⚠️ Could not convert image URL to data URL, returning original URL:', downloadErr.message);
      }
    }

    // Increment rate limit count after successful generation (both user ID and IP)
    incrementRateLimit(userId, imageType, ipAddress);

    res.json({
      imageUrl: imageUrl,
      prompt: prompt,
      style: style,
      size: size,
      quality: quality,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Image Generation Error:', error);
    console.error(`Error for user: ${userId}, type: ${imageType}`);
    
    // Check if this is a quota error (all API keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ API quota exceeded (all keys exhausted)');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // Check if this is an image-to-image specific error
    const isImageToImageError = error.message && error.message.includes('Image-to-image generation failed');
    
    // Handle OpenAI API errors with appropriate status codes
    if (error.status) {
      const statusCode = error.status === 400 ? 400 : error.status >= 500 ? 500 : 400;
      return res.status(statusCode).json({ 
        error: error.code === 'content_policy_violation' 
          ? 'Content policy violation' 
          : 'Failed to generate image',
        message: error.message || 'Image generation failed',
        code: error.code || 'image_generation_error'
      });
    }
    
    // For image-to-image errors, return specific message
    if (isImageToImageError) {
      return res.status(500).json({ 
        error: 'Image-to-image generation failed', 
        message: error.message || 'Image-to-image generation failed. Please try again later.'
      });
    }
    
    // Generic error
    res.status(500).json({ 
      error: 'Failed to generate image', 
      message: error.message || 'An unexpected error occurred'
    });
  }
});

// ============================================
// CREATOR - BLOG GENERATION (Gemini)
// ============================================
app.post('/api/ai/blog', async (req, res) => {
  const { topic, tone = 'professional', length = 'medium', style = 'article' } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  if (genAIBlogInstances.length === 0) {
    return res.status(500).json({ error: 'Gemini API for Blog not configured. Please set GEMINI_API_KEY_BLOG in .env file' });
  }

  // Check rate limit before processing (both user ID and IP address)
  const userId = getUserIdentifier(req);
  const ipAddress = getIPAddress(req);
  const rateLimitCheck = checkRateLimit(userId, 'blog', ipAddress);
  
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: rateLimitCheck.message
    });
  }

  try {
    const prompt = `Write a ${length} ${style} blog post about "${topic}" in a ${tone} tone. 
    Include an engaging title, introduction, main content with key points, and a conclusion. 
    Make it informative and well-structured.`;

    // Use 4-tier unified fallback (Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3)
    const result = await generateWithUnifiedFallback(genAIBlogInstances, groqBlogInstances, prompt, [], 60000);
    const response = await result.response;
    const content = response.text();

    // Increment rate limit count after successful generation (both user ID and IP)
    incrementRateLimit(userId, 'blog', ipAddress);

    res.json({
      content: content,
      topic: topic,
      tone: tone,
      length: length,
      style: style,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Blog Generation Error:', error);
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all Blog API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to generate blog content', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// ============================================
// CREATOR - SOCIAL MEDIA CONTENT (Gemini)
// ============================================
app.post('/api/ai/social', async (req, res) => {
  const { topic, platform = 'general', tone = 'engaging', hashtags = true } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  if (genAISocialInstances.length === 0) {
    return res.status(500).json({ error: 'Gemini API for Social not configured. Please set GEMINI_API_KEY_SOCIAL in .env file' });
  }

  // Check rate limit before processing (both user ID and IP address)
  const userId = getUserIdentifier(req);
  const ipAddress = getIPAddress(req);
  const rateLimitCheck = checkRateLimit(userId, 'social', ipAddress);
  
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: rateLimitCheck.message
    });
  }

  try {
    const platformGuidelines = {
      twitter: 'Keep it under 280 characters, use 1-2 hashtags',
      instagram: 'Write engaging caption with 5-10 relevant hashtags',
      linkedin: 'Professional tone, 1-3 hashtags, longer form content',
      facebook: 'Friendly and engaging, 2-5 hashtags',
      general: 'Engaging social media post with relevant hashtags'
    };

    const guidelines = platformGuidelines[platform] || platformGuidelines.general;

    const prompt = `Create a ${tone} social media post for ${platform} about "${topic}". 
    ${guidelines}. 
    ${hashtags ? 'Include relevant hashtags at the end.' : 'Do not include hashtags.'}
    Make it engaging and shareable.`;

    // Use 4-tier unified fallback (Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3)
    const result = await generateWithUnifiedFallback(genAISocialInstances, groqSocialInstances, prompt, [], 60000);
    const response = await result.response;
    const content = response.text();

    // Increment rate limit count after successful generation (both user ID and IP)
    incrementRateLimit(userId, 'social', ipAddress);

    res.json({
      content: content,
      topic: topic,
      platform: platform,
      tone: tone,
      hashtags: hashtags,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Social Content Generation Error:', error);
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all Social API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to generate social content', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// ============================================
// CREATOR - PROMPT GENERATION (Gemini)
// ============================================
app.post('/api/ai/prompt', async (req, res) => {
  const { purpose, context, style = 'detailed' } = req.body;

  if (!purpose) {
    return res.status(400).json({ error: 'Purpose is required' });
  }

  if (genAIPromptInstances.length === 0) {
    return res.status(500).json({ error: 'Gemini API for Prompt not configured. Please set GEMINI_API_KEY_PROMPT in .env file' });
  }

  // Check rate limit before processing (both user ID and IP address)
  const userId = getUserIdentifier(req);
  const ipAddress = getIPAddress(req);
  const rateLimitCheck = checkRateLimit(userId, 'prompt', ipAddress);
  
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: rateLimitCheck.message
    });
  }

  try {

    // Parse context to extract type, tone, and other details
    let promptType = 'practical';
    let promptTone = 'clear';
    let includeConstraints = false;
    let includePerspective = false;
    let includeStyle = false;

    if (context) {
      if (context.includes('Type:')) {
        const typeMatch = context.match(/Type:\s*(\w+)/i);
        if (typeMatch) promptType = typeMatch[1].toLowerCase();
      }
      if (context.includes('Tone:')) {
        const toneMatch = context.match(/Tone:\s*(\w+)/i);
        if (toneMatch) promptTone = toneMatch[1].toLowerCase();
      }
      includeConstraints = context.includes('constraints');
      includePerspective = context.includes('perspective');
      includeStyle = context.includes('style');
    }

    // Extract the actual subject from purpose (remove "Generate a X AI prompt for: ")
    const subjectMatch = purpose.match(/for:\s*(.+)$/i) || purpose.match(/about:\s*(.+)$/i) || [null, purpose];
    const subject = subjectMatch[1]?.trim() || purpose;

    // Build a direct, usable prompt based on type and tone
    let directPrompt = '';
    
    if (promptType === 'creative') {
      directPrompt = `Create a creative and imaginative ${subject}. Use a ${promptTone} tone. `;
      if (includeStyle) directPrompt += 'Include vivid descriptions and engaging storytelling. ';
      if (includePerspective) directPrompt += 'Write from a unique and inspiring perspective. ';
    } else if (promptType === 'practical') {
      directPrompt = `Create a practical, step-by-step guide for ${subject}. Use a ${promptTone} tone. `;
      if (includeStyle) directPrompt += 'Use clear, actionable language with numbered steps. ';
      if (includePerspective) directPrompt += 'Write from an expert, helpful perspective. ';
    } else if (promptType === 'strategic') {
      directPrompt = `Create a strategic analysis and plan for ${subject}. Use a ${promptTone} tone. `;
      if (includeStyle) directPrompt += 'Include strategic insights, recommendations, and actionable steps. ';
      if (includePerspective) directPrompt += 'Write from a strategic, forward-thinking perspective. ';
    } else if (promptType === 'fun') {
      directPrompt = `Create a fun and engaging ${subject}. Use a ${promptTone} tone. `;
      if (includeStyle) directPrompt += 'Make it entertaining and enjoyable to read. ';
      if (includePerspective) directPrompt += 'Write from a lighthearted, approachable perspective. ';
    } else {
      directPrompt = `Create content about ${subject}. Use a ${promptTone} tone. `;
    }

    if (includeConstraints) {
      directPrompt += 'Include specific constraints and requirements. ';
    }

    directPrompt += 'Provide a comprehensive, well-structured response that is ready to use.';

    // Generate the prompt using Gemini
    const generationPrompt = `You are a prompt engineering expert. Create a direct, clear, and effective AI prompt that a user can copy and paste into any AI model (like ChatGPT, Claude, Gemini, etc.) to get the desired output.

User's Request: ${directPrompt}

Generate ONLY the final prompt text that the user should use. Do NOT include any explanations, meta-commentary, or instructions about the prompt itself. Just output the clean, ready-to-use prompt that will work with any AI model.`;

    // Use 4-tier unified fallback (Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3)
    const result = await generateWithUnifiedFallback(genAIPromptInstances, groqPromptInstances, generationPrompt, [], 60000);
    const response = await result.response;
    const generatedPrompt = response.text();

    // Increment rate limit count after successful generation (both user ID and IP)
    incrementRateLimit(userId, 'prompt', ipAddress);

    res.json({
      prompt: generatedPrompt,
      purpose: purpose,
      context: context || null,
      style: style,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Prompt Generation Error:', error);
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all Prompt API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to generate prompt', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// ============================================
// VOICE MESSAGE ENDPOINT (Gemini)
// ============================================
app.post('/api/ai/voice', upload.single('audio'), async (req, res) => {
  console.log('🎤 Received voice message request');
  
  if (!req.file) {
    console.error('No file received in voice request');
    console.log('Request body keys:', Object.keys(req.body || {}));
    console.log('Request files:', req.files);
    return res.status(400).json({ error: 'Audio file is required' });
  }
  
  console.log('File received:', {
    size: req.file.size,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname,
    bufferLength: req.file.buffer?.length
  });

  if (genAIVoiceInstances.length === 0) {
    return res.status(500).json({ error: 'Gemini API for Voice not configured. Please set GEMINI_API_KEY_VOICE in .env file' });
  }

  try {
    const audioBuffer = req.file.buffer;
    const audioMimeType = req.file.mimetype || 'audio/webm';
    
    // Build conversation context
    const conversationHistory = req.body.conversationHistory ? JSON.parse(req.body.conversationHistory) : [];
    const recentHistory = conversationHistory.slice(-6); // Last 6 messages (3 exchanges)
    
    // PRE-CHECK: Check conversation history for image requests BEFORE processing
    // This works for Gemini native audio where we don't have transcription yet
    const checkHistoryForImageRequest = (history) => {
      if (!history || history.length === 0) return false;
      
      // Get the last user message from history
      const lastUserMessage = history[history.length - 1];
      if (!lastUserMessage || lastUserMessage.role !== 'user') return false;
      
      const userMessageText = (lastUserMessage.content || '').toLowerCase();
      if (!userMessageText.trim()) return false;
      
      const createActions = [
        'create', 'generate', 'make', 'draw', 'show', 'give', 'send', 'build', 
        'produce', 'design', 'render', 'paint', 'sketch', 'illustrate', 'craft',
        'can you', 'could you', 'please', 'i want', 'i need', 'i would like',
        'make me', 'create me', 'generate me', 'draw me', 'show me', 'give me'
      ];
      
      const imageTypes = [
        'image', 'picture', 'visual', 'photo', 'photograph', 'video', 'animation', 
        'gif', 'meme', 'illustration', 'artwork', 'graphic', 'drawing', 'sketch',
        'painting', 'portrait', 'poster', 'banner', 'thumbnail', 'avatar', 'icon',
        'logo', 'diagram', 'chart', 'infographic', 'collage', 'montage', 'comic',
        'cartoon', 'doodle', 'art', 'visualization', 'render', 'scene', 'snapshot',
        'screenshot', 'pic', 'img', 'pics', 'photos', 'images', 'pictures', 'visuals'
      ];
      
      const hasCreateAction = createActions.some(action => userMessageText.includes(action));
      const hasImageType = imageTypes.some(type => userMessageText.includes(type));
      
      return hasCreateAction && hasImageType;
    };
    
    // Check history BEFORE processing (for Gemini native audio early detection)
    const isImageRequestFromHistory = checkHistoryForImageRequest(recentHistory);
    
    let systemPrompt = `You are a helpful AI assistant. Be friendly, professional, and helpful. Answer questions on any topic the user asks about. Do not limit yourself to any specific services or products unless the user specifically asks about them.\n\nIMPORTANT: Do NOT say "Thanks for the voice message!" or similar acknowledgments about receiving voice messages. Just respond directly to the user's question or request without mentioning that it was a voice message.\n\nIMAGE GENERATION REFUSAL: If the user asks you to create, generate, draw, make, or produce any image, picture, photo, visual, video, or artwork, you MUST respond with this exact message:\n\n"I'd love to help, but I can't create images in chat! 😊\n\nHere's what you can do instead:\n\n• Go to the \\"Creator\\" section → \\"Image\\" tab\n\n• Type your image idea (e.g., \\"a laughing duck in water\\")\n\n• I'll generate it for you there!\n\nWant help crafting the perfect image prompt? I can help with that right here! 🎨"\n\nDo NOT attempt to create, generate, or acknowledge creating images in this chat. Always use the exact message above when users ask for image generation.\n\n`;
    
    let transcribedText = '';
    let aiResponseText = '';
    let usedNativeAudio = false;
    
    // Try Gemini native audio first
    try {
      const geminiResult = await generateVoiceWithGeminiNativeAudio(
        genAIVoiceInstances,
        groqVoiceInstances,
        audioBuffer,
        audioMimeType,
        recentHistory,
        systemPrompt,
        300000 // 5 minutes timeout for voice
      );
      
      aiResponseText = geminiResult.response.text();
      usedNativeAudio = true;
      
      // Try to extract transcription from Gemini response if available
      // Gemini might include both transcription and response, or just response
      // For now, we'll use empty transcribedText when using native audio
      transcribedText = '';
      
      console.log('✅ Gemini native audio response received:', aiResponseText.substring(0, 50));
      
    } catch (geminiError) {
      if (geminiError.message === 'FALLBACK_TO_WHISPER_GROQ') {
        // Fallback: Use Whisper to transcribe, then Groq
        console.log('🔄 Using Whisper transcription + Groq fallback...');
        
        // Use OpenAI Whisper for speech-to-text (with timeout)
        if (!openai) {
          return res.status(500).json({ error: 'OpenAI API not configured. Whisper is required for voice transcription fallback.' });
        }
        
        try {
          // Use OpenAI SDK's audio.transcriptions.create
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          
          // Determine file extension
          let fileExtension = 'm4a';
          if (req.file.originalname) {
            const ext = req.file.originalname.split('.').pop()?.toLowerCase();
            if (ext && ['m4a', 'mp3', 'wav', 'webm', 'mp4', 'mpeg', 'mpga', 'ogg'].includes(ext)) {
              fileExtension = ext;
            }
          } else if (req.file.mimetype) {
            const mimeToExt = {
              'audio/m4a': 'm4a',
              'audio/mp3': 'mp3',
              'audio/wav': 'wav',
              'audio/webm': 'webm',
              'audio/mpeg': 'mp3',
              'audio/mp4': 'm4a',
              'audio/ogg': 'ogg',
              'audio/opus': 'ogg'
            };
            fileExtension = mimeToExt[req.file.mimetype] || 'm4a';
          }
          
          // Write buffer to temp file (required for OpenAI SDK)
          const tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.${fileExtension}`);
          fs.writeFileSync(tempFilePath, audioBuffer);
          
          // Create a File-like object for OpenAI SDK
          const audioFileStream = fs.createReadStream(tempFilePath);
          const audioFile = Object.assign(audioFileStream, {
            name: `audio.${fileExtension}`,
            type: req.file.mimetype || `audio/${fileExtension}`,
            size: audioBuffer.length
          });
          
          // Use OpenAI SDK with timeout wrapper (5 minutes for very long audio clips)
          const transcriptionPromise = openai.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1'
          });
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Whisper API request timeout after 5 minutes')), 300000)
          );
          
          const whisperResult = await Promise.race([transcriptionPromise, timeoutPromise]);
          
          // Clean up temp file
          try {
            fs.unlinkSync(tempFilePath);
          } catch (unlinkError) {
            // Ignore cleanup errors
          }
          
          transcribedText = whisperResult.text;
          console.log('✅ Audio transcribed with Whisper:', transcribedText ? transcribedText.substring(0, 50) : '(empty)');
          console.log('📝 Full transcription length:', transcribedText ? transcribedText.length : 0);
          
          // Now send transcribed text to Groq (via unified fallback)
          // Build conversation context for Groq
          let conversationContext = systemPrompt;
          
          if (recentHistory.length > 0) {
            recentHistory.forEach((msg) => {
              conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
            });
          }
          
          // CRITICAL: Detect language of current transcribed message
          const detectMessageLanguage = (text) => {
            if (!text || text.trim().length === 0) return 'English';
            const arabicPattern = /[\u0600-\u06FF\u0750-\u077F]/;
            const hasArabic = arabicPattern.test(text);
            return hasArabic ? 'Arabic' : 'English';
          };
          const currentMessageLanguage = detectMessageLanguage(transcribedText);
          const isArabic = currentMessageLanguage === 'Arabic';
          
          // Add language instruction
          if (isArabic) {
            conversationContext += `LANGUAGE RULE: The user's current message is in Arabic. You MUST respond in Arabic (العربية) only.\n\nFORMATTING RULE: When responding in Arabic, do NOT use markdown formatting (no asterisks *, no bold **, no italic _). Write plain Arabic text only.\n\n`;
          } else {
            conversationContext += `LANGUAGE RULE: The user's current message is in English. You MUST respond in English only. Do NOT use Arabic.\n\n`;
          }
          
          // Add strong language instruction before current message
          if (isArabic) {
            conversationContext += `CRITICAL REMINDER: The user's message below is in Arabic. Respond ONLY in Arabic (العربية).\n\n`;
          } else {
            conversationContext += `CRITICAL REMINDER: The user's message below is in English. Respond ONLY in English. Do NOT use Arabic.\n\n`;
          }
          
          conversationContext += `User: ${transcribedText}\n\nAssistant:`;
          
          // Use Groq via unified fallback (only Groq will be tried since Gemini already failed)
          // We pass empty genAIInstances to skip Gemini
          const groqResult = await generateWithUnifiedFallback([], groqVoiceInstances, conversationContext, [], 300000);
          const groqResponse = await groqResult.response;
          aiResponseText = groqResponse.text();
          
          console.log('✅ Groq fallback response received (via Whisper):', aiResponseText.substring(0, 50));
          
        } catch (whisperError) {
          console.error('❌ Whisper transcription error:', whisperError);
          
          if (whisperError.message && whisperError.message.includes('timeout')) {
            return res.status(408).json({ 
              error: 'Request timeout', 
              message: 'Audio transcription took too long. Please try again.'
            });
          }
          
          const errorMessage = whisperError.message || 'Unknown error';
          return res.status(500).json({ 
            error: 'Failed to transcribe audio', 
            message: `Could not convert audio to text: ${errorMessage}. Please try again.`
          });
        }
      } else {
        // Unexpected error from Gemini native audio - rethrow it
        throw geminiError;
      }
    }

    // Check if user is asking to create images/videos/visuals
    // For Gemini native audio: Check AI response text + conversation history for image generation attempts
    // For Whisper fallback: Check transcribed text before processing
    const isImageRequest = (() => {
      // First, check if we already detected it from history (early detection for Gemini native audio)
      if (isImageRequestFromHistory) {
        return true;
      }
      
      let textToCheck = '';
      
      if (usedNativeAudio && aiResponseText) {
        // For Gemini native audio, check if the AI response suggests it's trying to generate an image
        // Check BOTH the AI response AND recent conversation history
        let responseText = aiResponseText.toLowerCase();
        let historyText = '';
        
        // Check recent conversation history for user's image request
        if (recentHistory.length > 0) {
          const lastUserMessage = recentHistory[recentHistory.length - 1];
          if (lastUserMessage && lastUserMessage.role === 'user') {
            historyText = ' ' + lastUserMessage.content.toLowerCase();
          }
        }
        
        textToCheck = responseText + historyText;
        
        // Also check if AI response indicates it's about to/currently generating an image
        // (even if the request keywords aren't in the response itself)
        const imageGenerationPhrases = [
          "i'll create", "i'll generate", "i'll make", "i'll draw", "creating", "generating", 
          "making an image", "drawing a picture", "generating an image", "creating a picture",
          "i'm creating", "i'm generating", "i'm making", "i'm drawing"
        ];
        
        const responseIndicatesGeneration = imageGenerationPhrases.some(phrase => responseText.includes(phrase));
        if (responseIndicatesGeneration) {
          // Even if keywords aren't found, if AI says it's generating, block it
          return true;
        }
      } else if (transcribedText) {
        // For Whisper fallback, check transcribed text
        textToCheck = transcribedText.toLowerCase().trim();
      } else {
        return false;
      }
      
      if (!textToCheck || !textToCheck.trim()) return false;
      
      // Comprehensive list of create/generate action keywords
      const createActions = [
        'create', 'generate', 'make', 'draw', 'show', 'give', 'send', 'build', 
        'produce', 'design', 'render', 'paint', 'sketch', 'illustrate', 'craft',
        'can you', 'could you', 'please', 'i want', 'i need', 'i would like',
        'make me', 'create me', 'generate me', 'draw me', 'show me', 'give me',
        'creating', 'generating', 'making', 'drawing' // Also check for -ing forms
      ];
      
      // Comprehensive list of image/visual type keywords
      const imageTypes = [
        'image', 'picture', 'visual', 'photo', 'photograph', 'video', 'animation', 
        'gif', 'meme', 'illustration', 'artwork', 'graphic', 'drawing', 'sketch',
        'painting', 'portrait', 'poster', 'banner', 'thumbnail', 'avatar', 'icon',
        'logo', 'diagram', 'chart', 'infographic', 'collage', 'montage', 'comic',
        'cartoon', 'doodle', 'art', 'visualization', 'render', 'scene', 'snapshot',
        'screenshot', 'pic', 'img', 'pics', 'photos', 'images', 'pictures', 'visuals'
      ];
      
      // Check if message contains both a create action AND an image type
      const hasCreateAction = createActions.some(action => textToCheck.includes(action));
      const hasImageType = imageTypes.some(type => textToCheck.includes(type));
      
      // If both are present, it's an image creation request
      return hasCreateAction && hasImageType;
    })();
    
    if (isImageRequest) {
      const requestText = usedNativeAudio ? (aiResponseText || 'voice request') : transcribedText;
      console.log('🖼️ Image creation request detected in voice message:', requestText.substring(0, 100));
      
      const redirectMessage = "I'd love to help, but I can't create images in chat! 😊\n\nHere's what you can do instead:\n\n• Go to the \"Creator\" section → \"Image\" tab\n\n• Type your image idea (e.g., \"a laughing duck in water\")\n\n• I'll generate it for you there!\n\nWant help crafting the perfect image prompt? I can help with that right here! 🎨";
      
      // Generate TTS for redirect message
      let redirectAudioBase64 = '';
      if (openai) {
        try {
          const requestedVoice = (req.body && req.body.voice) ? req.body.voice : 'alloy';
          const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
          const voice = validVoices.includes(String(requestedVoice).toLowerCase()) ? String(requestedVoice).toLowerCase() : 'alloy';
          
          const ttsResponse = await openai.audio.speech.create({
            model: 'tts-1',
            voice: voice,
            input: redirectMessage
          });
          
          const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
          redirectAudioBase64 = audioBuffer.toString('base64');
        } catch (ttsError) {
          console.error('Failed to generate redirect audio:', ttsError);
        }
      }
      
      // Return transcribed text if available (for Whisper fallback), otherwise use placeholder
      const transcribedTextForResponse = transcribedText || (usedNativeAudio ? "Image generation request" : "");
      
      return res.json({
        textResponse: redirectMessage,
        transcribedText: transcribedTextForResponse,
        audioResponse: redirectAudioBase64 ? `data:audio/mp3;base64,${redirectAudioBase64}` : null,
        timestamp: new Date().toISOString()
      });
    }
    
    // If we got a response from Gemini native audio, we're done - just convert to speech
    if (usedNativeAudio && aiResponseText) {
      // Skip transcription checks for native audio - Gemini handles it
      // Continue to TTS conversion below
    } else {
      // Handle empty transcription or common "no speech" phrases (for Whisper fallback)
      const noSpeechPhrases = [
        'thanks for watching',
        'thank you for watching',
        'thanks for watching!',
        'thank you for watching!',
        '[music]',
        '[silence]'
      ];
      
      const transcribedLower = transcribedText ? transcribedText.toLowerCase().trim() : '';
      const isEmptyOrNoSpeech = !transcribedText || 
                                transcribedText.trim().length === 0 || 
                                (transcribedText.trim().length <= 3 && noSpeechPhrases.some(phrase => transcribedLower === phrase)) ||
                                noSpeechPhrases.some(phrase => transcribedLower === phrase);
      
      if (isEmptyOrNoSpeech) {
      const noSpeechResponse = "Oh, I didn't hear you speaking. Please say something so I can help you!";
      
      // Generate TTS for no-speech response
      let noSpeechAudioBase64 = '';
      if (openai) {
        try {
          const requestedVoice = (req.body && req.body.voice) ? req.body.voice : 'alloy';
          const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
          const voice = validVoices.includes(String(requestedVoice).toLowerCase()) ? String(requestedVoice).toLowerCase() : 'alloy';
          
          const ttsResponse = await openai.audio.speech.create({
            model: 'tts-1',
            voice: voice,
            input: noSpeechResponse
          });
          
          const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
          noSpeechAudioBase64 = audioBuffer.toString('base64');
        } catch (ttsError) {
          console.error('Failed to generate no-speech audio:', ttsError);
        }
      }
      
      return res.json({
        textResponse: noSpeechResponse,
        transcribedText: '', // Keep empty so user message shows as voice icon
        audioResponse: noSpeechAudioBase64 ? `data:audio/mp3;base64,${noSpeechAudioBase64}` : null,
        timestamp: new Date().toISOString()
      });
      }
    }
    
    // If we reach here, we should have aiResponseText from either Gemini native audio or Groq fallback
    // If not, something went wrong
    if (!aiResponseText) {
      return res.status(500).json({ 
        error: 'Failed to generate response', 
        message: 'Unable to process voice message. Please try again.'
      });
    }

    // Detect language for TTS (use aiResponseText if transcribedText is empty for native audio)
    const textForLanguageDetection = transcribedText || aiResponseText || '';
    const detectResponseLanguage = (text) => {
      if (!text || text.trim().length === 0) return 'English';
      const arabicPattern = /[\u0600-\u06FF\u0750-\u077F]/;
      const hasArabic = arabicPattern.test(text);
      return hasArabic ? 'Arabic' : 'English';
    };
    const responseLanguage = detectResponseLanguage(textForLanguageDetection);
    const isResponseArabic = responseLanguage === 'Arabic';
    
    // Select voice based on detected language
    let selectedVoice = isResponseArabic ? 'nova' : 'alloy'; // 'nova' works better with Arabic
    console.log(`🌐 Voice: Detected ${responseLanguage} response, using voice: ${selectedVoice}`);
    
    // Convert text response to speech using OpenAI TTS (with timeout)
    let audioResponseBase64 = '';
    if (openai) {
      try {
        // selectedVoice is already set above based on language detection
        // Override with requested voice from client if provided and valid (for manual voice selection)
        const requestedVoice = (req.body && req.body.voice) ? req.body.voice : null;
        const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
        if (requestedVoice && validVoices.includes(String(requestedVoice).toLowerCase())) {
          selectedVoice = String(requestedVoice).toLowerCase();
          console.log('🎤 Using requested voice from client:', selectedVoice);
        }
        
        // Add timeout for TTS API (2 minutes for long responses)
        let ttsTimeoutId;
        const ttsResponse = await Promise.race([
          openai.audio.speech.create({
            model: 'tts-1',
            voice: selectedVoice, // Auto-selected based on language detection
            input: aiResponseText
          }),
          new Promise((_, reject) => {
            ttsTimeoutId = setTimeout(() => reject(new Error('TTS request timeout after 2 minutes')), 120000);
          })
        ]);
        
        if (ttsTimeoutId) {
          clearTimeout(ttsTimeoutId);
        }
        
        const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
        audioResponseBase64 = audioBuffer.toString('base64');
        console.log('✅ Text converted to speech');
      } catch (ttsError) {
        console.error('TTS error:', ttsError);
        if (ttsError.message && ttsError.message.includes('timeout')) {
          console.log('⚠️ TTS request timed out, continuing without audio response');
          // Continue without audio - don't fail the whole request
        } else {
          console.log('⚠️ TTS failed, continuing without audio response');
          // Continue without audio - don't fail the whole request
        }
      }
    }

    res.json({
      textResponse: aiResponseText,
      transcribedText: transcribedText,
      audioResponse: audioResponseBase64 ? `data:audio/mp3;base64,${audioResponseBase64}` : null,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Voice Message Error:', error);
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all Voice API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // Check for timeout errors
    if (error.message && (error.message.includes('timeout') || error.message.includes('Timeout'))) {
      console.log('⏱️ Timeout error detected in Voice endpoint');
      return res.status(408).json({ 
        error: 'Request timeout', 
        message: 'Request timed out. Please try again.'
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to process voice message', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// ============================================
// AUTOMATION IDEAS ENDPOINT (Gemini)
// ============================================
app.post('/api/ai/automation', async (req, res) => {
  const { businessArea } = req.body;

  if (!businessArea || typeof businessArea !== 'string' || businessArea.trim().length === 0) {
    return res.status(400).json({ error: 'Business area is required' });
  }

  if (genAIAutomationInstances.length === 0) {
    return res.status(500).json({ error: 'Gemini API for Automation not configured. Please set GEMINI_API_KEY_AUTOMATION in .env file' });
  }

  // Check rate limit before processing (both user ID and IP address)
  const userId = getUserIdentifier(req);
  const ipAddress = getIPAddress(req);
  const rateLimitCheck = checkRateLimit(userId, 'automation-suggestions', ipAddress);
  
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: rateLimitCheck.message
    });
  }

  try {
    const prompt = `You are an automation expert. Generate 3-5 detailed automation suggestions for the business area: "${businessArea.trim()}".

For each suggestion, provide:
1. A clear, descriptive title (e.g., "Automated ${businessArea} Workflow Management")
2. A detailed summary (2-3 sentences explaining what the automation does and its benefits)
3. Impact level: "Low", "Medium", or "High" (based on business value and ROI)
4. Effort level: "Low", "Medium", or "High" (based on implementation complexity and time)
5. Tools: A list of 2-4 relevant automation tools/platforms (e.g., Zapier, Make, HubSpot, Slack, Monday.com, Notion, etc.)

Format your response as a JSON array with this exact structure:
[
  {
    "title": "Automation Title",
    "summary": "Detailed description of what this automation does and its benefits...",
    "impact": "High",
    "effort": "Medium",
    "tools": ["Tool1", "Tool2", "Tool3"]
  }
]

Make the suggestions practical, actionable, and tailored to ${businessArea}. Focus on real-world automation scenarios that would save time and improve efficiency.`;

    // Use 4-tier unified fallback (Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3)
    const result = await generateWithUnifiedFallback(genAIAutomationInstances, groqAutomationInstances, prompt, [], 60000);
    const response = await result.response;
    const aiResponse = response.text();
    
    console.log('✅ Automation suggestions received from Gemini');

    // Parse the AI response to extract JSON
    let suggestions = [];
    try {
      // Try to extract JSON from the response (might be wrapped in markdown code blocks)
      let jsonText = aiResponse.trim();
      
      // Remove markdown code blocks if present
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```\n?/g, '').trim();
      }
      
      // Parse JSON
      const parsed = JSON.parse(jsonText);
      
      // Ensure it's an array
      if (Array.isArray(parsed)) {
        suggestions = parsed;
      } else if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
        suggestions = parsed.suggestions;
      } else if (parsed.automation && Array.isArray(parsed.automation)) {
        suggestions = parsed.automation;
      } else {
        // If it's a single object, wrap it in an array
        suggestions = [parsed];
      }
      
      // Validate and format each suggestion
      suggestions = suggestions.map((suggestion, index) => {
        // Generate ID if not present
        const id = suggestion.id || `automation-${Date.now()}-${index}`;
        
        // Validate and set defaults
        return {
          id: id,
          title: suggestion.title || `Automation Suggestion ${index + 1}`,
          summary: suggestion.summary || 'No description provided',
          impact: ['Low', 'Medium', 'High'].includes(suggestion.impact) ? suggestion.impact : 'Medium',
          effort: ['Low', 'Medium', 'High'].includes(suggestion.effort) ? suggestion.effort : 'Medium',
          tools: Array.isArray(suggestion.tools) ? suggestion.tools : (suggestion.tools ? [suggestion.tools] : ['Zapier'])
        };
      }).filter(s => s.title && s.summary); // Remove invalid suggestions
      
      // Limit to 5 suggestions max
      if (suggestions.length > 5) {
        suggestions = suggestions.slice(0, 5);
      }
      
      // If no valid suggestions, create a fallback
      if (suggestions.length === 0) {
        suggestions = [{
          id: `automation-${Date.now()}`,
          title: `${businessArea} Automation Workflow`,
          summary: `Automate ${businessArea} processes to improve efficiency and reduce manual work. This automation can help streamline operations and save time.`,
          impact: 'Medium',
          effort: 'Medium',
          tools: ['Zapier', 'HubSpot']
        }];
      }
      
    } catch (parseError) {
      console.error('Failed to parse automation suggestions:', parseError);
      console.error('Raw AI response:', aiResponse);
      
      // Fallback: create a basic suggestion from the raw response
      suggestions = [{
        id: `automation-${Date.now()}`,
        title: `${businessArea} Automation`,
        summary: aiResponse.substring(0, 200) || `Automate ${businessArea} processes to improve efficiency.`,
        impact: 'Medium',
        effort: 'Medium',
        tools: ['Zapier', 'HubSpot', 'Slack']
      }];
    }

    // Increment rate limit count after successful generation (both user ID and IP)
    incrementRateLimit(userId, 'automation-suggestions', ipAddress);
    
    res.json({
      suggestions: suggestions,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Automation Suggestions Error:', error);
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all Automation API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to generate automation suggestions', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// ============================================
// AUTOMATION INSIGHT CENTER ENDPOINT (Gemini)
// ============================================
app.post('/api/ai/automation/command-center', async (req, res) => {
  const { command } = req.body;

  if (!command || typeof command !== 'string' || command.trim().length === 0) {
    return res.status(400).json({ error: 'Command is required' });
  }

  if (genAIAutomationInsightInstances.length === 0) {
    return res.status(500).json({ error: 'Gemini API for Automation Insight Center not configured. Please set GEMINI_API_KEY_AUTOMATION_INSIGHT in .env file' });
  }

  // Check rate limit before processing (both user ID and IP address)
  const userId = getUserIdentifier(req);
  const ipAddress = getIPAddress(req);
  const rateLimitCheck = checkRateLimit(userId, 'automation-playbook', ipAddress);
  
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: rateLimitCheck.message
    });
  }

  try {
    // Map command keys to descriptive names for better AI context
    const commandDescriptions = {
      'onboarding': 'Onboard New Leads - Capture and qualify leads, schedule introductions, and alert sales teams',
      'support-escalation': 'Escalate Support Tickets - Auto-triage urgent tickets, open war-rooms, and keep clients updated',
      'revenue-ops': 'Recover At-Risk Revenue - Revive stalled deals and overdue invoices with smart automated nudges',
      'customer-retention': 'Retain Customers - Identify at-risk accounts and trigger retention campaigns with personalized outreach',
      'content-distribution': 'Distribute Content - Auto-publish blog posts and social updates across multiple channels',
      'data-sync': 'Sync Data - Keep your project\'s CRM, email, and tools in perfect synchronization'
    };

    const commandDescription = commandDescriptions[command] || `Automation playbook for ${command}`;

    const prompt = `You are an automation expert. Generate a detailed automation playbook for: ${commandDescription}.

Create a comprehensive automation playbook with the following structure:

1. **Title**: A clear, action-oriented title (e.g., "Automate [Process Name]")
2. **Summary**: A 1-2 sentence overview of what this automation does and its key benefits
3. **Scenario**: A detailed description of when and why to use this automation (2-3 sentences)
4. **Steps**: Provide 4 detailed steps, each with:
   - A clear action title (e.g., "Capture and score the lead")
   - Detailed implementation instructions (2-3 sentences explaining what to do, which tools to use, and how they connect)
5. **Tools**: A list of 4-7 relevant automation tools/platforms (e.g., Zapier, Make, HubSpot, Slack, Monday.com, Notion, Asana, Intercom, etc.)
6. **Metrics**: 3-4 key performance indicators to track (e.g., "Response time", "Conversion rate", "Time saved")
7. **Follow-ups**: 2-3 actionable next steps or improvements to consider after implementation

Format your response as JSON with this exact structure:
{
  "title": "Automation Title",
  "summary": "Brief summary of what this automation does...",
  "scenario": "Detailed scenario description...",
  "steps": [
    {
      "title": "Step 1 Title",
      "detail": "Detailed instructions for step 1..."
    },
    {
      "title": "Step 2 Title",
      "detail": "Detailed instructions for step 2..."
    },
    {
      "title": "Step 3 Title",
      "detail": "Detailed instructions for step 3..."
    },
    {
      "title": "Step 4 Title",
      "detail": "Detailed instructions for step 4..."
    }
  ],
  "tools": ["Tool1", "Tool2", "Tool3", "Tool4"],
  "metrics": ["Metric1", "Metric2", "Metric3"],
  "followUps": ["Follow-up 1", "Follow-up 2", "Follow-up 3"]
}

Make the playbook practical, actionable, and tailored specifically to ${commandDescription}. Focus on real-world automation scenarios that save time and improve efficiency.`;

    // Use 4-tier unified fallback (Gemini Main -> Gemini Fallback -> Groq Fallback2 -> Groq Fallback3)
    const result = await generateWithUnifiedFallback(genAIAutomationInsightInstances, groqAutomationInsightInstances, prompt, [], 60000);
    const response = await result.response;
    const aiResponse = response.text();
    
    console.log('✅ Automation playbook received from Gemini');

    // Parse the AI response to extract JSON
    let playbook = null;
    try {
      // Try to extract JSON from the response (might be wrapped in markdown code blocks)
      let jsonText = aiResponse.trim();
      
      // Remove markdown code blocks if present
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/```\n?/g, '').trim();
      }
      
      // Parse JSON
      const parsed = JSON.parse(jsonText);
      
      // Validate and format the playbook
      if (parsed.title && parsed.summary && parsed.steps && Array.isArray(parsed.steps)) {
        playbook = {
          id: parsed.id || `playbook-${Date.now()}`,
          title: parsed.title,
          summary: parsed.summary,
          scenario: parsed.scenario || 'Automation scenario for improved efficiency and workflow optimization.',
          steps: parsed.steps.map((step, index) => ({
            title: step.title || `Step ${index + 1}`,
            detail: step.detail || step.detail || 'Implementation details for this step.'
          })).filter((step) => step.title && step.detail),
          tools: Array.isArray(parsed.tools) ? parsed.tools : (parsed.tools ? [parsed.tools] : ['Zapier', 'HubSpot']),
          metrics: Array.isArray(parsed.metrics) ? parsed.metrics : (parsed.metrics ? [parsed.metrics] : ['Efficiency', 'Time saved']),
          followUps: Array.isArray(parsed.followUps) ? parsed.followUps : (parsed.followUps ? [parsed.followUps] : ['Review and optimize', 'Monitor performance']),
          timestamp: new Date().toISOString()
        };
        
        // Ensure we have at least 4 steps
        if (playbook.steps.length < 4) {
          // Add placeholder steps if needed
          while (playbook.steps.length < 4) {
            playbook.steps.push({
              title: `Step ${playbook.steps.length + 1}`,
              detail: 'Configure this step based on your specific requirements and tools.'
            });
          }
        }
      } else {
        throw new Error('Invalid playbook structure');
      }
      
    } catch (parseError) {
      console.error('Failed to parse automation playbook:', parseError);
      console.error('Raw AI response:', aiResponse);
      
      // Fallback: create a basic playbook from the raw response
      playbook = {
        id: `playbook-${Date.now()}`,
        title: commandDescription.split(' - ')[0] || `Automation Playbook for ${command}`,
        summary: aiResponse.substring(0, 200) || `Automation playbook for ${commandDescription}`,
        scenario: 'Automation scenario designed to improve efficiency and streamline workflows.',
        steps: [
          {
            title: 'Step 1: Setup',
            detail: aiResponse.substring(0, 150) || 'Configure the initial automation setup.'
          },
          {
            title: 'Step 2: Configure',
            detail: 'Set up the necessary integrations and connections.'
          },
          {
            title: 'Step 3: Test',
            detail: 'Test the automation to ensure it works correctly.'
          },
          {
            title: 'Step 4: Deploy',
            detail: 'Deploy the automation and monitor its performance.'
          }
        ],
        tools: ['Zapier', 'HubSpot', 'Slack', 'Notion'],
        metrics: ['Efficiency', 'Time saved', 'Error reduction'],
        followUps: ['Review and optimize', 'Monitor performance'],
        timestamp: new Date().toISOString()
      };
    }

    // Increment rate limit count after successful generation (both user ID and IP)
    incrementRateLimit(userId, 'automation-playbook', ipAddress);
    
    // Create tool history record
    const record = {
      id: `automation-insight-${Date.now()}`,
      tool: 'Automation Insight Center',
      input: { command },
      output: playbook,
      summary: `Automation Insight Center · Playbook for "${command}"`,
      timestamp: new Date().toISOString()
    };

    res.json({
      playbook: playbook,
      record: record,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Automation Playbook Error:', error);
    
    // Check if error is quota-related (all keys exhausted)
    if (isQuotaError(error)) {
      console.log('⚠️ Quota exceeded on all Automation Insight Center API keys');
      return res.status(429).json({ 
        error: 'Quota exceeded', 
        message: "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!"
      });
    }
    
    // All other errors (network, timeout, temporary issues, etc.)
    res.status(500).json({ 
      error: 'Failed to generate automation playbook', 
      message: "Hmm... I didn't catch that. Mind sending it one more time?"
    });
  }
});

// WhatsApp AI Bot (same process, same .env / API keys)
const whatsappServices = {
  genAIChatInstances,
  groqChatInstances,
  genAIVoiceInstances,
  groqVoiceInstances,
  openai,
  replicate,
  checkRateLimit,
  incrementRateLimit,
  generateWithUnifiedFallback,
  generateVoiceWithGeminiNativeAudio,
  isImageGenerationRequest,
  isQuotaError
};
const { registerRoutes } = whatsappBot.init(whatsappServices);
registerRoutes(app);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Studio Backend is running on port ${PORT}`);
  console.log(`🌐 Server accessible on all interfaces (0.0.0.0:${PORT})`);
  console.log(`🤖 Gemini AI: ${genAI ? 'Configured ✓' : 'Not configured ✗'}`);
  console.log(`🎨 OpenAI (DALL-E): ${openai ? 'Configured ✓' : 'Not configured ✗'}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  /api/health - Health check`);
  console.log(`   POST /api/ai/chat - AI chat messaging (Gemini)`);
  console.log(`   POST /api/ai/image - Image generation (DALL-E)`);
  console.log(`   POST /api/ai/blog - Blog content generation (Gemini)`);
  console.log(`   POST /api/ai/social - Social media content (Gemini)`);
  console.log(`   POST /api/ai/prompt - Prompt generation (Gemini)`);
  console.log(`   POST /api/ai/voice - Voice message (Gemini + OpenAI Whisper/TTS)`);
  console.log(`   POST /api/ai/automation - Automation suggestions (Gemini)`);
  console.log(`   POST /api/ai/automation/command-center - Automation Insight Center playbooks (Gemini)`);
  console.log(`   GET  /api/whatsapp/qr - WhatsApp QR code (scan with +17473508060)`);
  console.log(`   GET  /api/whatsapp/status - WhatsApp connection status`);
  console.log(`   POST /api/whatsapp/send - Send WhatsApp message (testing)`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down AI Studio Backend...');
  process.exit(0);
});
