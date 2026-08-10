/**
 * WhatsApp AI Bot module for ai-studio-backend.
 * Uses whatsapp-web.js + same AI services as the mobile app backend.
 * Session: scan QR once with the target number (+17473508060); session stored in .wwebjs_auth.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let s = null; // services (injected by init)

let whatsappClient = null;
let whatsappQRCode = null;
let whatsappReady = false;
const whatsappSessions = new Map();

function initializeWhatsApp() {
  if (whatsappClient) return;

  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  whatsappClient.on('qr', (qr) => {
    console.log('📱 WhatsApp QR Code generated');
    whatsappQRCode = qr;
    qrcode.generate(qr, { small: true });
  });

  whatsappClient.on('ready', async () => {
    console.log('✅ WhatsApp Client is ready!');
    whatsappReady = true;
    whatsappQRCode = null;
    try {
      const clientPage = whatsappClient.pupPage;
      if (clientPage) {
        await clientPage.evaluate(() => {
          if (window.WWebJS && window.WWebJS.sendSeen) {
            const originalSendSeen = window.WWebJS.sendSeen;
            window.WWebJS.sendSeen = function () {
              try {
                return originalSendSeen.apply(this, arguments);
              } catch (error) {
                if (error.message && error.message.includes('markedUnread')) {
                  return Promise.resolve();
                }
                throw error;
              }
            };
          }
        });
      }
      await whatsappClient.setDisplayName('InfiNet AI');
    } catch (e) {
      console.warn('⚠️ WhatsApp patch/setDisplayName:', e.message);
    }
  });

  whatsappClient.on('authenticated', () => {
    console.log('✅ WhatsApp Client authenticated');
  });

  whatsappClient.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    whatsappReady = false;
  });

  whatsappClient.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp Client disconnected:', reason);
    whatsappReady = false;
    whatsappClient = null;
    setTimeout(() => initializeWhatsApp(), 5000);
  });

  whatsappClient.on('message', async (message) => {
    try {
      const from = message.from;
      const body = (message.body || '').trim();
      if (message.isGroupMsg || message.from === 'status@broadcast') return;
      console.log(`📨 WhatsApp message from ${from}: ${body.substring(0, 50)}`);

      const isFirstContact = !whatsappSessions.has(from);
      if (isFirstContact) {
        whatsappSessions.set(from, []);
        if (!body || body.length === 0) return;
      }

      const hasImage = message.hasMedia && (message.type === 'image' || message.type === 'sticker');
      const hasVoice = message.hasMedia && (message.type === 'ptt' || message.type === 'audio' || message.type === 'voice');
      const isImageRequest = s.isImageGenerationRequest(body);

      if (hasVoice) {
        await handleWhatsAppVoiceMessage(message, from);
      } else if (hasImage) {
        await handleWhatsAppImageToImage(message, body, from);
      } else if (isImageRequest) {
        await handleWhatsAppImageGeneration(message, body, from);
      } else {
        await handleWhatsAppChat(message, body, from);
      }
    } catch (error) {
      console.error('❌ Error handling WhatsApp message:', error);
      try {
        await safeReply(message, 'Sorry, I encountered an error. Please try again.');
      } catch (replyError) {
        console.error('❌ Error sending error message:', replyError);
      }
    }
  });

  whatsappClient.initialize().catch((err) => {
    console.error('❌ Failed to initialize WhatsApp:', err);
    whatsappClient = null;
    whatsappReady = false;
    setTimeout(() => {
      console.log('🔄 Retrying WhatsApp initialization...');
      initializeWhatsApp();
    }, 10000);
  });
}

async function safeReply(message, content, options = {}) {
  try {
    return await message.reply(content, undefined, { ...options, sendSeen: false });
  } catch (error) {
    if (error.message && (error.message.includes('markedUnread') || error.message.includes("reading 'markedUnread'"))) {
      try {
        const chat = await message.getChat();
        const sendOptions = { sendSeen: false };
        if (options.caption && content && content.mimetype) sendOptions.caption = options.caption;
        return await chat.sendMessage(content, sendOptions);
      } catch (fallbackError) {
        if (fallbackError.message && fallbackError.message.includes('markedUnread')) {
          return { id: { _serialized: 'fallback_' + Date.now() }, body: content };
        }
        throw fallbackError;
      }
    }
    throw error;
  }
}

async function handleWhatsAppVoiceMessage(message, from) {
  try {
    await safeReply(message, '🎤 Processing your voice message...');
    const media = await message.downloadMedia();
    if (!media) {
      await safeReply(message, "Sorry, I couldn't download the voice message. Please try again.");
      return;
    }
    if (!s.genAIVoiceInstances || s.genAIVoiceInstances.length === 0) {
      await safeReply(message, 'AI voice service is not configured.');
      return;
    }

    const audioBuffer = Buffer.from(media.data, 'base64');
    const audioMimeType = media.mimetype || 'audio/ogg; codecs=opus';
    const sessionHistory = whatsappSessions.get(from) || [];
    const recentHistory = sessionHistory.slice(-6).map(msg => ({ role: msg.role, content: msg.content }));

    let systemPrompt = `You are a helpful AI assistant. Be friendly, professional, and helpful. Keep responses concise for WhatsApp voice messages. Answer questions on any topic the user asks about. Do not limit yourself to any specific services or products unless the user specifically asks about them.\n\nIMPORTANT: Do NOT greet the user with "How can I help you today?" unless they greet you first or explicitly ask for help. Just respond directly to their message or question.\n\nIMAGE GENERATION: When the user asks you to create, generate, draw, or make an image, picture, or visual, you should respond by acknowledging their request. The system will automatically generate the image for them. Do NOT refuse image generation requests or redirect users elsewhere.\n\n`;

    let transcribedText = '';
    let aiResponseText = '';
    let usedNativeAudio = false;

    try {
      const geminiResult = await s.generateVoiceWithGeminiNativeAudio(
        s.genAIVoiceInstances,
        s.groqVoiceInstances,
        audioBuffer,
        audioMimeType,
        recentHistory,
        systemPrompt,
        60000
      );
      aiResponseText = geminiResult.response.text();
      usedNativeAudio = true;

      if (s.openai) {
        try {
          let fileExtension = 'ogg';
          if (audioMimeType.includes('m4a')) fileExtension = 'm4a';
          else if (audioMimeType.includes('mp3')) fileExtension = 'mp3';
          else if (audioMimeType.includes('wav')) fileExtension = 'wav';
          else if (audioMimeType.includes('webm')) fileExtension = 'webm';
          const tempFilePath = path.join(os.tmpdir(), `whatsapp_audio_check_${Date.now()}.${fileExtension}`);
          fs.writeFileSync(tempFilePath, audioBuffer);
          const audioFile = fs.createReadStream(tempFilePath);
          audioFile.name = `audio.${fileExtension}`;
          audioFile.type = audioMimeType;
          const whisperResult = await Promise.race([
            s.openai.audio.transcriptions.create({ file: audioFile, model: 'whisper-1' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Whisper timeout')), 30000))
          ]);
          try { fs.unlinkSync(tempFilePath); } catch (_) {}
          if (whisperResult && whisperResult.text && whisperResult.text.trim() && s.isImageGenerationRequest(whisperResult.text.trim())) {
            transcribedText = whisperResult.text.trim();
          }
        } catch (_) {}
      }
    } catch (geminiError) {
      if (geminiError.message === 'FALLBACK_TO_WHISPER_GROQ') {
        if (!s.openai) {
          await safeReply(message, 'Voice processing service is not configured for fallback.');
          return;
        }
        try {
          let fileExtension = 'ogg';
          if (audioMimeType.includes('m4a')) fileExtension = 'm4a';
          else if (audioMimeType.includes('mp3')) fileExtension = 'mp3';
          else if (audioMimeType.includes('wav')) fileExtension = 'wav';
          else if (audioMimeType.includes('webm')) fileExtension = 'webm';
          const tempFilePath = path.join(os.tmpdir(), `whatsapp_audio_${Date.now()}.${fileExtension}`);
          fs.writeFileSync(tempFilePath, audioBuffer);
          const audioFile = fs.createReadStream(tempFilePath);
          audioFile.name = `audio.${fileExtension}`;
          audioFile.type = audioMimeType;
          const whisperResult = await Promise.race([
            s.openai.audio.transcriptions.create({ file: audioFile, model: 'whisper-1' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Whisper timeout')), 300000))
          ]);
          try { fs.unlinkSync(tempFilePath); } catch (_) {}
          transcribedText = whisperResult.text || '';
          if (!transcribedText.trim()) {
            await safeReply(message, "I couldn't understand your voice message. Could you please try again or send a text message?");
            return;
          }
          if (s.isImageGenerationRequest(transcribedText)) {
            await handleWhatsAppImageGeneration(message, transcribedText, from);
            return;
          }
          const normalizedTranscribed = transcribedText.toLowerCase().trim();
          const isGreeting = /^(hi|hey|hello|hola|hey there|hi there|greetings|good morning|good afternoon|good evening|hey!|hi!|hello!)/.test(normalizedTranscribed);
          const isAskingForHelp = /help|assist|support|can you|could you|please|need help/i.test(normalizedTranscribed);
          let conversationContext = isGreeting || isAskingForHelp
            ? `You are a helpful AI assistant. Be friendly, professional, and helpful. Keep responses concise for WhatsApp voice messages. The user has greeted you or asked for help. You may respond with "How can I help you today?" Keep greetings simple and direct.\n\n`
            : systemPrompt;
          if (recentHistory.length > 0) {
            recentHistory.forEach(msg => { conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`; });
          }
          const hasArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(transcribedText);
          if (hasArabic) conversationContext += `LANGUAGE RULE: The user's current message is in Arabic. You MUST respond in Arabic (العربية) only. Do NOT use markdown.\n\n`;
          else conversationContext += `LANGUAGE RULE: The user's current message is in English. You MUST respond in English only.\n\n`;
          conversationContext += `User: ${transcribedText}\nAssistant:`;
          const groqResult = await s.generateWithUnifiedFallback([], s.groqVoiceInstances, conversationContext, [], 60000);
          aiResponseText = groqResult.response.text();
        } catch (whisperError) {
          console.error('❌ WhatsApp Whisper error:', whisperError);
          await safeReply(message, 'Sorry, I encountered an error transcribing your voice message. Please try again or send a text message.');
          return;
        }
      } else {
        throw geminiError;
      }
    }

    if (!aiResponseText) {
      await safeReply(message, 'Sorry, I encountered an error processing your voice message. Please try again or send a text message.');
      return;
    }

    let textToCheck = transcribedText || (usedNativeAudio ? aiResponseText : '');
    const isImageRequest = s.isImageGenerationRequest(textToCheck) || (transcribedText && s.isImageGenerationRequest(transcribedText)) || (aiResponseText && s.isImageGenerationRequest(aiResponseText));
    if (isImageRequest) {
      const finalPrompt = transcribedText || textToCheck || aiResponseText || '';
      await handleWhatsAppImageGeneration(message, finalPrompt, from);
      return;
    }

    const userMessageForHistory = transcribedText || '[Voice message]';
    sessionHistory.push({ role: 'user', content: userMessageForHistory });
    sessionHistory.push({ role: 'assistant', content: aiResponseText });
    whatsappSessions.set(from, sessionHistory);

    if (s.openai) {
      const isResponseArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(aiResponseText);
      const selectedVoice = isResponseArabic ? 'nova' : 'alloy';
      try {
        const ttsResponse = await s.openai.audio.speech.create({ model: 'tts-1', voice: selectedVoice, input: aiResponseText });
        const audioResponseBuffer = Buffer.from(await ttsResponse.arrayBuffer());
        const media = new MessageMedia('audio/mp3', audioResponseBuffer.toString('base64'), 'response.mp3');
        await safeReply(message, media);
        return;
      } catch (ttsError) {
        console.error('❌ TTS error:', ttsError);
      }
    }
    await safeReply(message, aiResponseText);
  } catch (error) {
    console.error('❌ Error in WhatsApp voice message:', error);
    await safeReply(message, 'Sorry, I encountered an error processing your voice message. Please try again.');
  }
}

async function handleWhatsAppChat(message, userMessage, from) {
  try {
    if (s.isImageGenerationRequest(userMessage)) {
      await handleWhatsAppImageGeneration(message, userMessage, from);
      return;
    }
    const sessionHistory = whatsappSessions.get(from) || [];
    const conversationHistory = sessionHistory.map(msg => ({ role: msg.role, content: msg.content }));
    const normalizedMessage = userMessage.toLowerCase().trim();
    const isGreeting = /^(hi|hey|hello|hola|hey there|hi there|greetings|good morning|good afternoon|good evening|hey!|hi!|hello!)/.test(normalizedMessage);
    const isAskingForHelp = /help|assist|support|can you|could you|please|need help/i.test(normalizedMessage);

    let conversationContext = `You are a helpful AI assistant. Be friendly, professional, and helpful. Keep responses concise for WhatsApp. Answer questions on any topic the user asks about. Do not limit yourself to any specific services or products unless the user specifically asks about them.\n\n`;
    if (isGreeting || isAskingForHelp) {
      conversationContext += `IMPORTANT: The user has greeted you or asked for help. You may respond with "How can I help you today?" Keep greetings simple and direct.\n\n`;
    } else {
      conversationContext += `IMPORTANT: Do NOT greet the user unless they greet you first or explicitly ask for help. Just respond directly to their message or question.\n\n`;
    }
    const isUserArabic = /[\u0600-\u06FF\u0750-\u077F]/.test(userMessage);
    if (isUserArabic) conversationContext += `FORMATTING RULE: When responding in Arabic, do NOT use markdown formatting. Write plain Arabic text only.\n\n`;
    if (conversationHistory.length > 0) {
      conversationHistory.forEach(msg => { conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`; });
    }
    conversationContext += `User: ${userMessage}\nAssistant:`;

    if (!s.genAIChatInstances || s.genAIChatInstances.length === 0) {
      await safeReply(message, 'AI service is not configured. Please contact support.');
      return;
    }

    const result = await s.generateWithUnifiedFallback(s.genAIChatInstances, s.groqChatInstances, conversationContext, conversationHistory, 60000);
    const aiResponse = result.response.text();

    let formattedResponse = aiResponse
      .replace(/\*\*\s*([^*\n]+?)\s*\*\*/g, '*$1*')
      .replace(/__\s*([^_\n]+?)\s*__/g, '*$1*')
      .replace(/\*\s+([^*\n]+?)\s+\*/g, '*$1*')
      .replace(/_\s+([^_\n]+?)\s+_/g, '_$1_')
      .replace(/~\s*([^~\s\n][^~\n]*?[^~\s\n])\s*~/g, '~$1~')
      .replace(/`\s*([^`\n]+?)\s*`/g, '```$1```')
      .replace(/\*\s*\n/g, '\n')
      .replace(/\n\s*\*/g, '\n')
      .replace(/\s+\*\s+/g, ' ')
      .replace(/\*\s*\./g, '.')
      .replace(/\*\*\./g, '.')
      .replace(/\*\./g, '.')
      .replace(/([\u0600-\u06FF])\s*\*\s*\*/g, '$1')
      .replace(/([\u0600-\u06FF])\s*\*/g, '$1')
      .replace(/\*\s*\*\s*([\u0600-\u06FF])/g, '$1')
      .replace(/\*\s*([\u0600-\u06FF])/g, '$1')
      .replace(/\*\*/g, '')
      .trim();

    sessionHistory.push({ role: 'user', content: userMessage });
    sessionHistory.push({ role: 'assistant', content: aiResponse });
    whatsappSessions.set(from, sessionHistory);
    await safeReply(message, formattedResponse);
  } catch (error) {
    console.error('❌ Error in WhatsApp chat:', error);
    if (s.isQuotaError(error)) {
      await safeReply(message, "Oops! You've reached today's token limit. Come back in 24 hours for a fresh refill!");
    } else {
      await safeReply(message, "Hmm... I didn't catch that. Mind sending it one more time?");
    }
  }
}

async function handleWhatsAppImageToImage(message, prompt, from) {
  try {
    const userId = `whatsapp_${from}`;
    const rateLimitCheck = s.checkRateLimit(userId, 'replicate', null);
    if (!rateLimitCheck.allowed) {
      await safeReply(message, `🚫 ${rateLimitCheck.message}`);
      return;
    }
    await safeReply(message, '🖼️ Processing your image... This may take a moment.');
    const media = await message.downloadMedia();
    if (!media) {
      await safeReply(message, "Sorry, I couldn't download the image. Please try again.");
      return;
    }
    const imageBuffer = Buffer.from(media.data, 'base64');
    const sharp = require('sharp');
    const resizedImage = await sharp(imageBuffer)
      .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const imageDataUrl = `data:image/png;base64,${resizedImage.toString('base64')}`;
    let userPrompt = (prompt || '').trim();
    if (!userPrompt || userPrompt.length < 3) userPrompt = 'enhance and improve this image';
    let cleanedPrompt = userPrompt.replace(/restore\s+.*?color/gi, 'restore colors').replace(/colorize/gi, 'restore colors').replace(/enhance/gi, 'enhance').replace(/improve/gi, 'improve').trim();
    if (!/transform|restore|enhance|improve|convert|change|make/i.test(cleanedPrompt)) cleanedPrompt = `transform the image: ${cleanedPrompt}`;

    if (!s.replicate) {
      await safeReply(message, 'Image transformation service is not configured.');
      return;
    }
    try {
      const rawOutput = await s.replicate.run('google/nano-banana', { input: { prompt: cleanedPrompt, image_input: [imageDataUrl] } });
      let output = rawOutput;
      let imageUrl = null;
      if (Array.isArray(output) && output.length > 0 && output[0] && typeof output[0].getReader === 'function') output = output[0];
      if (output && typeof output.getReader === 'function') {
        const reader = output.getReader();
        const chunks = [];
        let done = false;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          done = streamDone;
          if (value) chunks.push(value);
        }
        const buffer = Buffer.concat(chunks);
        const isImageData = (buffer[0] === 0xFF && buffer[1] === 0xD8) || (buffer[0] === 0x89 && buffer[1] === 0x50) || (buffer[0] === 0x47 && buffer[1] === 0x49);
        if (isImageData) {
          const mimeType = buffer[0] === 0xFF && buffer[1] === 0xD8 ? 'image/jpeg' : buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
          imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
        } else {
          const urlMatch = buffer.toString('utf8').match(/https?:\/\/[^\s"']+/);
          if (urlMatch) imageUrl = urlMatch[0];
        }
      }
      if (!imageUrl && Array.isArray(rawOutput) && rawOutput.length > 0) {
        const first = rawOutput[0];
        if (typeof first === 'string' && (first.startsWith('http://') || first.startsWith('https://'))) imageUrl = first;
        else if (first && typeof first === 'object') imageUrl = first.url || first.image || first.image_url || first.imageUrl || first.output;
      } else if (typeof rawOutput === 'string' && (rawOutput.startsWith('http://') || rawOutput.startsWith('https://'))) imageUrl = rawOutput;

      if (!imageUrl) {
        await safeReply(message, 'Sorry, I encountered an error processing your image. Please try again.');
        return;
      }
      let finalBuffer;
      if (imageUrl.startsWith('data:image/')) {
        finalBuffer = Buffer.from(imageUrl.split(',')[1], 'base64');
      } else {
        const axios = require('axios');
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        finalBuffer = Buffer.from(imageResponse.data);
      }
      const outMedia = new MessageMedia('image/png', finalBuffer.toString('base64'), 'transformed-image.png');
      await safeReply(message, outMedia, { caption: `✨ Transformed: ${cleanedPrompt}` });
      s.incrementRateLimit(userId, 'replicate', null);
    } catch (replicateError) {
      console.error('❌ Replicate error:', replicateError);
      await safeReply(message, 'Sorry, I encountered an error transforming your image. Please try again with a different prompt.');
    }
  } catch (error) {
    console.error('❌ Error in WhatsApp image-to-image:', error);
    await safeReply(message, 'Sorry, I encountered an error processing your image. Please try again.');
  }
}

async function handleWhatsAppImageGeneration(message, prompt, from) {
  try {
    const userId = `whatsapp_${from}`;
    const rateLimitCheck = s.checkRateLimit(userId, 'dalle', null);
    if (!rateLimitCheck.allowed) {
      await safeReply(message, `🚫 ${rateLimitCheck.message}`);
      return;
    }
    await safeReply(message, '🎨 Generating your image... This may take a moment.');
    let cleanedPrompt = (prompt || '').trim();
    const originalPrompt = cleanedPrompt;
    const hasNonEnglish = /[^\x00-\x7F]/.test(cleanedPrompt);
    if (hasNonEnglish) {
      cleanedPrompt = cleanedPrompt
        .replace(/^(أنشئ|اصنع|ارسم)\s+صورة\s+من\s+/gi, '')
        .replace(/^صورة\s+من\s+/gi, '')
        .replace(/^(أنشئ|اصنع|ارسم)\s+/gi, '')
        .trim();
      if (!cleanedPrompt || cleanedPrompt.length < 3) cleanedPrompt = originalPrompt;
    } else {
      cleanedPrompt = cleanedPrompt
        .replace(/^(generate|create|make|draw)\s+(an?\s+)?(image|picture)\s+of\s+/gi, '')
        .replace(/^(generate|create|make|draw)\s+(an?\s+)?(image|picture)\s+/gi, '')
        .replace(/^(image|picture)\s+of\s+/gi, '')
        .replace(/^draw\s+/gi, '')
        .trim();
      if (!cleanedPrompt || cleanedPrompt.length < 3) cleanedPrompt = originalPrompt;
    }
    if (!cleanedPrompt) {
      await safeReply(message, 'Please describe what image you want to generate. For example: "generate image of a sunset over mountains"');
      return;
    }
    if (!s.openai) {
      await safeReply(message, 'Image generation service is not configured. Please contact support.');
      return;
    }
    try {
      // Text-to-image: gpt-image-1 (same as POST /api/ai/image; DALL-E 3 is deprecated on OpenAI API)
      const gptSize = '1024x1024';
      const gptQuality = 'medium';

      const response = await s.openai.images.generate({
        model: 'gpt-image-1',
        prompt: cleanedPrompt,
        n: 1,
        size: gptSize,
        quality: gptQuality
      });

      const item = response.data && response.data[0];
      let imageBuffer;
      if (item?.b64_json) {
        imageBuffer = Buffer.from(item.b64_json, 'base64');
      } else if (item?.url) {
        const axios = require('axios');
        const imageResponse = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
        imageBuffer = Buffer.from(imageResponse.data);
      } else {
        throw new Error('OpenAI image API returned invalid response - no url or b64_json');
      }

      const media = new MessageMedia('image/png', imageBuffer.toString('base64'), 'generated-image.png');
      await safeReply(message, media, { caption: `🎨 Generated: ${cleanedPrompt}` });
      s.incrementRateLimit(userId, 'dalle', null);
    } catch (imageError) {
      console.error('❌ GPT Image error:', imageError);
      let errorMessage = 'Sorry, I encountered an error generating your image.';
      if (imageError.message && (imageError.message.includes('quota') || imageError.message.includes('rate limit'))) {
        errorMessage = 'Sorry, the image generation service is currently at capacity. Please try again in a few moments.';
      } else if (imageError.message && (imageError.message.includes('content policy') || imageError.message.includes('safety'))) {
        errorMessage = 'Sorry, I cannot generate that image due to content policy restrictions. Please try a different prompt.';
      } else if (imageError.status === 401 || (imageError.message && imageError.message.includes('API key'))) {
        errorMessage = 'Sorry, the image generation service is not properly configured. Please contact support.';
      }
      await safeReply(message, errorMessage);
    }
  } catch (error) {
    console.error('❌ Error generating image:', error);
    await safeReply(message, 'Sorry, I encountered an error generating your image.');
  }
}

function registerRoutes(app) {
  app.get('/api/whatsapp/qr', (req, res) => {
    if (whatsappQRCode) {
      res.json({ qr: whatsappQRCode, ready: false });
    } else if (whatsappReady) {
      res.json({ qr: null, ready: true, message: 'WhatsApp is connected and ready' });
    } else {
      res.json({ qr: null, ready: false, message: 'WhatsApp is initializing...' });
    }
  });

  app.get('/api/whatsapp/status', (req, res) => {
    let clientState = 'none';
    if (whatsappClient) {
      try {
        clientState = whatsappClient.info ? 'connected' : 'initializing';
      } catch (e) {
        clientState = 'error';
      }
    }
    res.json({
      ready: whatsappReady,
      connected: !!whatsappClient,
      clientState,
      hasQRCode: !!whatsappQRCode,
      message: whatsappReady ? 'WhatsApp is ready and can receive messages' : (whatsappClient ? 'WhatsApp is connecting...' : 'WhatsApp is not initialized')
    });
  });

  app.post('/api/whatsapp/send', async (req, res) => {
    try {
      const { phoneNumber, message } = req.body;
      if (!phoneNumber || !message) {
        return res.status(400).json({ error: 'phoneNumber and message are required' });
      }
      if (!whatsappReady || !whatsappClient) {
        return res.status(503).json({ error: 'WhatsApp is not ready. Please scan QR code first.' });
      }
      let formattedNumber = phoneNumber.replace(/[+\s]/g, '');
      if (!formattedNumber.includes('@')) formattedNumber = formattedNumber + '@c.us';
      await whatsappClient.sendMessage(formattedNumber, message);
      res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
      console.error('❌ Error sending WhatsApp message:', error);
      res.status(500).json({ error: 'Failed to send message', message: error.message });
    }
  });
}

function init(services) {
  s = services;
  initializeWhatsApp();
  return { registerRoutes };
}

module.exports = { init };
