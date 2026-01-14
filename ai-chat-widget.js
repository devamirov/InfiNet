// InfiNet AI Chat Widget
// This widget works on all pages - just include this script before </body>

(function() {
    'use strict';
    
    // Configuration
    // Use relative path for production (goes through Apache reverse proxy)
    // For localhost development, use: 'http://localhost:3000'
    const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
        ? 'http://localhost:3000' 
        : ''; // Empty string means use relative path (current domain)
    const WIDGET_ID = 'infinet-ai-chat-widget';
    
    // State
    let sessionId = null;
    let isOpen = false;
    let isMinimized = false;
    
    // Create widget HTML
    function createWidgetHTML() {
        const widgetHTML = `
            <div id="${WIDGET_ID}" class="infinet-ai-widget">
                <div class="infinet-ai-widget-button" id="infinet-ai-widget-toggle">
                    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="7" y="5" width="10" height="9" rx="1.5" fill="#000000"/>
                        <circle cx="10.5" cy="9" r="1.2" fill="#ffffff"/>
                        <circle cx="13.5" cy="9" r="1.2" fill="#ffffff"/>
                        <rect x="10" y="11.5" width="4" height="1" rx="0.5" fill="#ffffff"/>
                        <rect x="5" y="7" width="2" height="5" rx="1" fill="#000000"/>
                        <rect x="17" y="7" width="2" height="5" rx="1" fill="#000000"/>
                        <rect x="8.5" y="15" width="2" height="4" rx="1" fill="#000000"/>
                        <rect x="13.5" y="15" width="2" height="4" rx="1" fill="#000000"/>
                        <rect x="11" y="3" width="2" height="2" rx="1" fill="#000000"/>
                    </svg>
                </div>
                <div class="infinet-ai-widget-container" id="infinet-ai-widget-container">
                    <div class="infinet-ai-widget-header">
                        <div class="infinet-ai-widget-header-content">
                            <div class="infinet-ai-widget-avatar">
                                <img id="infinet-ai-widget-favicon" src="" alt="InfiNet">
                            </div>
                            <div class="infinet-ai-widget-header-text">
                                <h3>InfiNet AI Assistant</h3>
                                <p>Ask me anything!</p>
                            </div>
                        </div>
                        <button class="infinet-ai-widget-close" id="infinet-ai-widget-close">×</button>
                    </div>
                    <div class="infinet-ai-widget-messages" id="infinet-ai-widget-messages">
                        <div class="infinet-ai-widget-message infinet-ai-widget-message-ai">
                            <div class="infinet-ai-widget-message-content">
                                <p>Hello! 👋 I'm your InfiNet AI assistant. I can help you with:</p>
                                <ul class="infinet-ai-widget-quick-options">
                                    <li class="infinet-ai-widget-option" data-option="Questions about our services">Questions about our services</li>
                                    <li class="infinet-ai-widget-option" data-option="Portfolio recommendations">Portfolio recommendations</li>
                                    <li class="infinet-ai-widget-option" data-option="Project estimates">Project estimates</li>
                                    <li class="infinet-ai-widget-option" data-option="Design consultation">Design consultation</li>
                                    <li class="infinet-ai-widget-option" data-option="Scheduling a consultation">Scheduling a consultation</li>
                                </ul>
                                <p>What would you like to know?</p>
                            </div>
                        </div>
                    </div>
                    <div class="infinet-ai-widget-input-container">
                        <a href="https://wa.me/96181460699" target="_blank" class="infinet-ai-widget-whatsapp-btn" title="Contact us on WhatsApp">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.885 3.488" fill="white"/>
                            </svg>
                        </a>
                        <input type="text" 
                               id="infinet-ai-widget-input" 
                               class="infinet-ai-widget-input" 
                               placeholder="Type your message...">
                        <button id="infinet-ai-widget-send" class="infinet-ai-widget-send">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="#000000" stroke="#000000" stroke-width="0.5"/>
                            </svg>
                        </button>
                    </div>
                    <div class="infinet-ai-widget-typing" id="infinet-ai-widget-typing" style="display: none;">
                        <span></span><span></span><span></span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', widgetHTML);
    }
    
    // Create widget styles
    function createWidgetStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .infinet-ai-widget {
                position: fixed;
                bottom: 16px;
                left: 20px;
                z-index: 10000;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            }
            
            .infinet-ai-widget-button {
                width: 60px;
                height: 60px;
                background: #98FB98;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                transition: all 0.3s ease;
                color: white;
            }
            
            .infinet-ai-widget-button svg {
                width: 42px;
                height: 42px;
            }
            
            .infinet-ai-widget-button:hover {
                transform: scale(1.1);
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
            }
            
            .infinet-ai-widget-container {
                position: fixed;
                bottom: 80px;
                left: 20px;
                right: 20px;
                width: auto;
                max-width: none;
                height: 500px;
                max-height: calc(100vh - 120px);
                background: white;
                border-radius: 16px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
                display: none;
                flex-direction: column;
                overflow: hidden;
            }
            
            .infinet-ai-widget-container.open {
                display: flex;
            }
            
            .infinet-ai-widget-header {
                background: #98FB98;
                color: white;
                padding: 4px 20px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            
            .infinet-ai-widget-header-content {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            
            .infinet-ai-widget-avatar {
                width: 40px;
                height: 40px;
                background: white;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                box-sizing: border-box;
                overflow: hidden;
                flex-shrink: 0;
            }
            
            .infinet-ai-widget-avatar img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                border-radius: 50%;
                display: block;
                border: none;
                padding: 0;
                margin: 0;
            }
            
            .infinet-ai-widget-header-text h3 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: #000000;
            }
            
            .infinet-ai-widget-header-text p {
                margin: 4px 0 0 0;
                font-size: 12px;
                color: #000000;
            }
            
            .infinet-ai-widget-close {
                background: none;
                border: none;
                color: #000000;
                font-size: 24px;
                cursor: pointer;
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                transition: background 0.2s;
            }
            
            .infinet-ai-widget-close:hover {
                background: rgba(0, 0, 0, 0.1);
            }
            
            .infinet-ai-widget-messages {
                flex: 1;
                overflow-y: auto;
                padding: 20px;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
            
            .infinet-ai-widget-message {
                display: flex;
                gap: 12px;
            }
            
            .infinet-ai-widget-message-user {
                justify-content: flex-end;
            }
            
            .infinet-ai-widget-message-content {
                max-width: 75%;
                padding: 6px 10px;
                border-radius: 12px;
                line-height: 1.4;
            }
            
            .infinet-ai-widget-message-ai .infinet-ai-widget-message-content {
                background: #f8f9fa;
                color: #333;
                border: 1px solid #e0e0e0;
                display: table-cell;
                vertical-align: middle;
                padding: 8px 10px;
            }
            
            .infinet-ai-widget-message-ai .infinet-ai-widget-message-content p {
                margin: 0;
                font-size: 14px;
                line-height: 1.4;
                display: inline;
            }
            
            .infinet-ai-widget-message-user .infinet-ai-widget-message-content {
                background: #98FB98;
                color: #000000;
                display: table-cell;
                vertical-align: middle;
                padding: 8px 10px;
            }
            
            .infinet-ai-widget-message-user .infinet-ai-widget-message-content p {
                margin: 0;
                font-size: 14px;
                line-height: 1.4;
                display: inline;
            }
            
            .infinet-ai-widget-message-content p {
                margin: 0;
                font-size: 14px;
                line-height: 1.4;
            }
            
            .infinet-ai-widget-message-content p:first-child {
                font-weight: 600;
                margin-bottom: 12px;
            }
            
            .infinet-ai-widget-message-content ul {
                margin: 8px 0 12px 0;
                padding: 0;
                list-style: none;
            }
            
            .infinet-ai-widget-message-content li {
                margin: 6px 0;
                padding-left: 20px;
                position: relative;
                font-size: 13px;
            }
            
            .infinet-ai-widget-message-content li:before {
                content: "•";
                position: absolute;
                left: 0;
                color: #98FB98;
                font-weight: bold;
                font-size: 16px;
            }
            
            /* Quick options styling */
            .infinet-ai-widget-quick-options {
                margin: 8px 0 12px 0;
                padding: 0;
                list-style: none;
            }
            
            .infinet-ai-widget-quick-options li:not(.infinet-ai-widget-option):before {
                display: none !important;
            }
            
            .infinet-ai-widget-option {
                margin: 8px 0;
                padding: 10px 14px 10px 38px !important;
                background: white;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
                position: relative !important;
                font-size: 13px;
                color: #333;
                text-indent: 0 !important;
            }
            
            .infinet-ai-widget-quick-options .infinet-ai-widget-option:before {
                content: "▶" !important;
                display: block !important;
                position: absolute !important;
                left: 14px !important;
                top: 50% !important;
                transform: translateY(-50%) !important;
                color: #98FB98 !important;
                font-weight: bold !important;
                font-size: 11px !important;
                line-height: 1 !important;
                width: 10px !important;
                height: 11px !important;
                overflow: hidden !important;
                pointer-events: none !important;
                z-index: 1 !important;
            }
            
            .infinet-ai-widget-option:hover {
                background: #f0f8f0;
                border-color: #98FB98;
                transform: translateX(4px);
            }
            
            .infinet-ai-widget-option:active {
                transform: translateX(2px);
                background: #e8f5e8;
            }
            
            .infinet-ai-widget-message-content p:last-child {
                margin-top: 12px;
                margin-bottom: 0;
                font-weight: 500;
            }
            
            .infinet-ai-widget-input-container {
                padding: 16px;
                border-top: 1px solid #e0e0e0;
                display: flex;
                gap: 8px;
                align-items: center;
            }
            
            .infinet-ai-widget-whatsapp-btn {
                width: 40px;
                height: 40px;
                background: #25D366;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.2s;
                flex-shrink: 0;
                text-decoration: none;
            }
            
            .infinet-ai-widget-whatsapp-btn:hover {
                transform: scale(1.1);
                background: #57ffff;
            }
            
            .infinet-ai-widget-whatsapp-btn svg {
                width: 20px;
                height: 20px;
                display: block;
            }
            
            .infinet-ai-widget-whatsapp-btn svg path {
                fill: white;
            }
            
            .infinet-ai-widget-whatsapp-btn:hover svg path {
                fill: #000000;
            }
            
            .infinet-ai-widget-input {
                flex: 1;
                padding: 12px;
                border: 1px solid #e0e0e0;
                border-radius: 24px;
                font-size: 14px;
                outline: none;
            }
            
            .infinet-ai-widget-input:focus {
                border-color: #98FB98;
            }
            
            .infinet-ai-widget-send {
                width: 44px;
                height: 44px;
                background: #98FB98;
                border: none;
                border-radius: 50%;
                color: white;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
            }
            
            .infinet-ai-widget-send svg {
                width: 24px;
                height: 24px;
                display: block;
                flex-shrink: 0;
            }
            
            .infinet-ai-widget-send:hover {
                transform: scale(1.1);
                background: #57ffff;
            }
            
            .infinet-ai-widget-send:hover svg path {
                fill: #000000;
                stroke: #000000;
            }
            
            .infinet-ai-widget-send:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .infinet-ai-widget-typing {
                padding: 12px 20px;
                display: flex;
                gap: 4px;
            }
            
            .infinet-ai-widget-typing span {
                width: 8px;
                height: 8px;
                background: #98FB98;
                border-radius: 50%;
                animation: typing 1.4s infinite;
            }
            
            .infinet-ai-widget-typing span:nth-child(2) {
                animation-delay: 0.2s;
            }
            
            .infinet-ai-widget-typing span:nth-child(3) {
                animation-delay: 0.4s;
            }
            
            @keyframes typing {
                0%, 60%, 100% {
                    transform: translateY(0);
                    opacity: 0.7;
                }
                30% {
                    transform: translateY(-10px);
                    opacity: 1;
                }
            }
            
            @media (max-width: 768px) {
                .infinet-ai-widget-container {
                    left: 10px;
                    right: 10px;
                    width: auto;
                    max-width: none;
                    height: 500px;
                    max-height: calc(100vh - 120px);
                    bottom: 80px;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Add message to chat
    function addMessage(text, isUser = false) {
        const messagesContainer = document.getElementById('infinet-ai-widget-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `infinet-ai-widget-message ${isUser ? 'infinet-ai-widget-message-user' : 'infinet-ai-widget-message-ai'}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'infinet-ai-widget-message-content';
        
        // Check if text already contains HTML anchor tags
        const containsHTML = /<a\s/i.test(text);
        
        let formattedText;
        if (containsHTML) {
            // Text already contains HTML - just convert newlines to <br>
            formattedText = text.replace(/\n/g, '<br>');
        } else {
            // Convert newlines to <br> and format URLs
            // Improved URL regex: stops at word boundaries, punctuation, or whitespace
            // Matches URLs but stops before trailing punctuation or when followed by a capital letter
            formattedText = text
                .replace(/\n/g, '<br>')
                .replace(/(https?:\/\/[^\s<>"']+?)(?=[\s.,!?;:)]|$|[A-Z][a-z])/g, '<a href="$1" target="_blank" style="color: inherit; text-decoration: underline;">$1</a>');
        }
        
        contentDiv.innerHTML = `<p>${formattedText}</p>`;
        messageDiv.appendChild(contentDiv);
        messagesContainer.appendChild(messageDiv);
        
        // Scroll to bottom
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    // Show typing indicator
    function showTyping() {
        document.getElementById('infinet-ai-widget-typing').style.display = 'flex';
        const messagesContainer = document.getElementById('infinet-ai-widget-messages');
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    
    // Hide typing indicator
    function hideTyping() {
        document.getElementById('infinet-ai-widget-typing').style.display = 'none';
    }
    
    // Send message to AI
    async function sendMessage(message) {
        if (!message.trim()) return;
        
        // Add user message to chat
        addMessage(message, true);
        
        // Show typing indicator
        showTyping();
        
        // Disable input
        const input = document.getElementById('infinet-ai-widget-input');
        const sendButton = document.getElementById('infinet-ai-widget-send');
        input.disabled = true;
        sendButton.disabled = true;
        
        try {
            // Use relative path for production (goes through Apache reverse proxy)
            const apiUrl = API_BASE_URL ? `${API_BASE_URL}/api/ai/chat` : '/api/ai/chat';
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    sessionId: sessionId
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Failed to get response');
            }
            
            // Update session ID
            if (data.sessionId) {
                sessionId = data.sessionId;
            }
            
            // Add AI response
            hideTyping();
            addMessage(data.response);
            
            // Check if booking is needed
            if (data.bookingData) {
                // Show booking form (simplified - you can enhance this)
                setTimeout(() => {
                    addMessage('Great! I can help you schedule a consultation. Would you like me to book a time for you?', false);
                }, 1000);
            }
            
        } catch (error) {
            hideTyping();
            addMessage("✨ Our assistant is taking a short break. Let’s get you real help instead.<br><br>" +
        "👉 <strong>Need help immediately?</strong><br>" +
        "<a href='https://wa.me/96181460699?text=Hi%20InfiNet%2C%20I%20need%20help%20from%20your%20website' " +
        "target='_blank' style='" +
            "display:inline-block;" +
            "margin-top:8px;" +
            "padding:10px 14px;" +
            "background:#25D366;" +
            "color:#ffffff;" +
            "border-radius:8px;" +
            "text-decoration:none;" +
            "font-weight:600;" +
            "font-size:14px;" +
        "'>" +
        "💬 Chat with us on WhatsApp" +
        "</a>", false);
            console.error('AI Chat Error:', error);
        } finally {
            // Re-enable input
            input.disabled = false;
            sendButton.disabled = false;
            input.value = '';
            input.focus();
        }
    }
    
    // Toggle widget
    function toggleWidget() {
        isOpen = !isOpen;
        const container = document.getElementById('infinet-ai-widget-container');
        if (isOpen) {
            container.classList.add('open');
            document.getElementById('infinet-ai-widget-input').focus();
        } else {
            container.classList.remove('open');
        }
    }
    
    // Set favicon path based on current page location
    // Always ensures HTTPS protocol to prevent mixed content warnings
    function setFaviconPath() {
        const faviconImg = document.getElementById('infinet-ai-widget-favicon');
        if (!faviconImg) {
            // Retry after a short delay if element doesn't exist yet
            setTimeout(setFaviconPath, 100);
            return;
        }
        
        // Helper function to ensure HTTPS protocol
        function ensureHttps(url) {
            // If URL already has protocol, replace http:// with https://
            if (url.startsWith('http://')) {
                return url.replace('http://', 'https://');
            }
            // If it's already https://, return as is
            if (url.startsWith('https://')) {
                return url;
            }
            // If no protocol, construct HTTPS URL from current hostname
            // Use protocol from current page (should be https) or default to https
            const protocol = window.location.protocol === 'http:' ? 'https:' : window.location.protocol;
            // If protocol is not https, force it to https
            const finalProtocol = 'https:';
            const hostname = window.location.hostname;
            
            // If it's a relative path starting with /, just prepend protocol and hostname
            if (url.startsWith('/')) {
                return finalProtocol + '//' + hostname + url;
            }
            
            // Otherwise, resolve relative to current path
            const basePath = window.location.pathname;
            const baseDir = basePath.substring(0, basePath.lastIndexOf('/') + 1);
            const resolvedUrl = new URL(url, finalProtocol + '//' + hostname + baseDir).href;
            // Double-check to ensure HTTPS
            return resolvedUrl.replace('http://', 'https://');
        }
        
        // Try to find existing favicon link in the page
        const existingFavicon = document.querySelector('link[rel="icon"][sizes="192x192"]');
        if (existingFavicon) {
            const href = existingFavicon.getAttribute('href');
            if (href) {
                // Always ensure HTTPS
                faviconImg.src = ensureHttps(href);
                return;
            }
        }
        
        // Fallback: Calculate based on current location
        const pathname = window.location.pathname;
        const segments = pathname.split('/').filter(segment => segment.length > 0 && segment !== 'index.html');
        
        let fallbackPath;
        if (segments.length > 0) {
            // We're in a subdirectory, go up one level
            fallbackPath = '../favicon-192x192.png';
        } else {
            // We're at root
            fallbackPath = '/favicon-192x192.png';
        }
        
        // Always ensure HTTPS for fallback
        faviconImg.src = ensureHttps(fallbackPath);
        
        // Add error handler as fallback
        faviconImg.onerror = function() {
            // If relative path fails, try absolute from origin with forced HTTPS
            const absolutePath = 'https://' + window.location.hostname + '/favicon-192x192.png';
            this.onerror = null; // Prevent infinite loop
            this.src = absolutePath;
        };
    }
    
    // Initialize widget
    function init() {
        createWidgetStyles();
        createWidgetHTML();
        
        // Set favicon path after widget HTML is created
        setFaviconPath();
        
        // Event listeners
        document.getElementById('infinet-ai-widget-toggle').addEventListener('click', toggleWidget);
        document.getElementById('infinet-ai-widget-close').addEventListener('click', toggleWidget);
        
        const input = document.getElementById('infinet-ai-widget-input');
        const sendButton = document.getElementById('infinet-ai-widget-send');
        
        sendButton.addEventListener('click', () => {
            sendMessage(input.value);
        });
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage(input.value);
            }
        });
        
        // Add click handlers to quick options using event delegation
        const messagesContainer = document.getElementById('infinet-ai-widget-messages');
        messagesContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('infinet-ai-widget-option')) {
                const optionText = e.target.getAttribute('data-option');
                sendMessage(optionText);
            }
        });
    }
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

