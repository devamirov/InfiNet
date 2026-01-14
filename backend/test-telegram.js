const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Test Telegram bot connection
async function testTelegramBot() {
    console.log('🤖 Testing Telegram Bot Connection...');
    console.log('Bot Token:', process.env.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Missing');
    console.log('Chat ID:', process.env.TELEGRAM_CHAT_ID ? '✅ Configured' : '❌ Missing');
    
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.log('❌ Telegram configuration is incomplete. Please check your .env file.');
        return;
    }
    
    try {
        const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
        
        // Test bot info
        const botInfo = await bot.getMe();
        console.log('✅ Bot connected successfully!');
        console.log('Bot Name:', botInfo.first_name);
        console.log('Bot Username:', botInfo.username);
        
        // Send test message
        const testMessage = `
🎉 Telegram Bot Test Successful!

✅ Bot is connected and working
✅ Can send messages to chat ID: ${process.env.TELEGRAM_CHAT_ID}
✅ Ready to receive booking notifications

Your consultation booking system is now connected to Telegram!
        `.trim();
        
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, testMessage);
        console.log('✅ Test message sent successfully!');
        console.log('📱 Check your Telegram for the test message.');
        
    } catch (error) {
        console.error('❌ Telegram bot test failed:', error.message);
        
        if (error.message.includes('chat not found')) {
            console.log('💡 Make sure you have started a conversation with your bot first!');
            console.log('💡 Send a message to your bot, then try again.');
        }
    }
}

// Run the test
testTelegramBot();
